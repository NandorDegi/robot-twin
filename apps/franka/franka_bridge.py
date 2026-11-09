"""
Franka Panda (FER) control bridge: the ONE process that commands the arm.

It connects to the Panda through the Franka Control Interface (FCI) with
`panda-py` (panda-python 1.1.1; its PyPI wheel bundles libfranka 0.9.2, the
libfranka line for Panda system images 4.2.x). The Node robot server (`FrankaAdapter`) calls the
small HTTP API below on the loopback interface.

Single commander, by construction:
  * FCI accepts one client. This bridge holds that connection.
  * A lock file (flock) stops a second bridge on the same host.
  * The HTTP API listens on 127.0.0.1 only (FRANKA_BRIDGE_HOST must be loopback).
  * A command needs a lease. Only one lease exists at a time. The owner must
    send a heartbeat; when the heartbeat stops, the bridge stops the motion and
    drops the lease (watchdog).

Safety defaults:
  * FRANKA_DRY_RUN=1 (the default): no robot connection. A simulated arm
    follows the same validation and timing. Set FRANKA_DRY_RUN=0 for the robot.
  * Speed factor 0.1 by default, hard cap FRANKA_SPEED_FACTOR_MAX (<= 0.5).
  * Each goal is checked: 7 finite values, inside the Panda limits minus a
    margin, and the straight joint-space path (the path that
    move_to_joint_position follows) keeps every joint and the TCP above the
    table plane.
  * No automatic error recovery. POST /recover is an operator action.
  * The software stop (POST /stop) is NOT a safety function. The user stop
    (external activation device) on the robot is the safety function.

Endpoints (JSON):
  GET  /health
  GET  /state                      q, moving, lease owner, last motion result
  POST /lease     {owner}          -> {ok, token}; 409 when another owner holds it
  POST /heartbeat                  header X-Lease: <token>
  POST /release                    header X-Lease
  POST /move      {q, speedFactor?, id?}   header X-Lease; starts a motion
  POST /gripper   {open}           header X-Lease; blocks until done
  POST /stop                       no lease needed (anyone local may stop)
  POST /recover                    header X-Lease; libfranka error recovery
"""

from __future__ import annotations

import fcntl
import ipaddress
import json
import math
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, List, Optional, Sequence

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LIMITS = os.path.join(HERE, "..", "..", "packages", "robot-config", "panda-limits.json")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    def __init__(self) -> None:
        self.robot_host = os.environ.get("FRANKA_HOST", "172.16.0.2")
        self.host = os.environ.get("FRANKA_BRIDGE_HOST", "127.0.0.1")
        self.port = int(os.environ.get("FRANKA_BRIDGE_PORT", "3002"))
        self.dry_run = _env_bool("FRANKA_DRY_RUN", True)
        self.use_gripper = _env_bool("FRANKA_GRIPPER", True)
        # enforce (default) | ignore. Only use "ignore" for a bench test without the RT kernel.
        self.realtime = os.environ.get("FRANKA_REALTIME", "enforce")
        self.speed_factor = _env_float("FRANKA_SPEED_FACTOR", 0.1)
        self.speed_factor_max = min(_env_float("FRANKA_SPEED_FACTOR_MAX", 0.3), 0.5)
        self.lease_timeout_s = _env_float("FRANKA_LEASE_TIMEOUT_S", 1.0)
        self.limit_margin_rad = math.radians(_env_float("FRANKA_LIMIT_MARGIN_DEG", 1.0))
        # Table plane in the robot base frame (m). The robot base is usually on
        # the table, so the table is z = 0.
        self.table_z_m = _env_float("FRANKA_TABLE_Z_M", 0.0)
        self.min_tcp_clearance_m = _env_float("FRANKA_MIN_TCP_CLEARANCE_M", 0.02)
        self.min_joint_clearance_m = _env_float("FRANKA_MIN_JOINT_CLEARANCE_M", 0.05)
        self.lock_file = os.environ.get("FRANKA_LOCK_FILE", "/tmp/robot-twin-franka.lock")
        self.limits_file = os.environ.get("FRANKA_LIMITS_FILE", DEFAULT_LIMITS)
        self.open_width_m = _env_float("FRANKA_GRIPPER_OPEN_M", 0.08)
        self.gripper_speed = _env_float("FRANKA_GRIPPER_SPEED", 0.05)
        self.grasp_width_m = _env_float("FRANKA_GRASP_WIDTH_M", 0.02)
        self.grasp_eps_inner_m = _env_float("FRANKA_GRASP_EPS_INNER_M", 0.015)
        self.grasp_eps_outer_m = _env_float("FRANKA_GRASP_EPS_OUTER_M", 0.03)
        self.grasp_force_n = min(_env_float("FRANKA_GRASP_FORCE_N", 20.0), 70.0)


def load_limits(path: str) -> dict:
    with open(path) as f:
        data = json.load(f)
    for key in ("qMin", "qMax", "dqMax", "readyPose", "tcpOffsetM"):
        if key not in data:
            raise ValueError(f"{path}: missing {key}")
    return data


# --- Panda forward kinematics (official URDF origins), for the floor check ---

def _mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _tf(x, y, z, roll):
    c, s = math.cos(roll), math.sin(roll)
    return [[1, 0, 0, x], [0, c, -s, y], [0, s, c, z], [0, 0, 0, 1]]


def _rot_z(t):
    c, s = math.cos(t), math.sin(t)
    return [[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


_ORIGINS = [
    (0, 0, 0.333, 0),
    (0, 0, 0, -math.pi / 2),
    (0, -0.316, 0, math.pi / 2),
    (0.0825, 0, 0, math.pi / 2),
    (-0.0825, 0.384, 0, -math.pi / 2),
    (0, 0, 0, math.pi / 2),
    (0.088, 0, 0, math.pi / 2),
]


def panda_points(q: Sequence[float], tcp_offset_m: float) -> List[List[float]]:
    """Base-frame positions (m) of joint2..joint7 origins, the flange and the TCP."""
    t = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    pts = []
    for i, (x, y, z, r) in enumerate(_ORIGINS):
        t = _mat_mul(t, _tf(x, y, z, r))
        if i >= 1:
            pts.append([t[0][3], t[1][3], t[2][3]])
        t = _mat_mul(t, _rot_z(q[i]))
    flange = _mat_mul(t, _tf(0, 0, 0.107, 0))
    pts.append([flange[0][3], flange[1][3], flange[2][3]])
    tcp = _mat_mul(flange, _tf(0, 0, tcp_offset_m, 0))
    pts.append([tcp[0][3], tcp[1][3], tcp[2][3]])
    return pts


class ValidationError(ValueError):
    pass


def validate_goal(q_goal, q_now: Optional[Sequence[float]], limits: dict, s: Settings) -> List[float]:
    """Raise ValidationError unless the goal and the straight path to it are safe."""
    if not isinstance(q_goal, (list, tuple)) or len(q_goal) != 7:
        raise ValidationError("q must be a list of 7 joint values (rad)")
    try:
        q = [float(v) for v in q_goal]
    except (TypeError, ValueError):
        raise ValidationError("q values must be numbers")
    if not all(math.isfinite(v) for v in q):
        raise ValidationError("q values must be finite")
    for i, v in enumerate(q):
        lo = limits["qMin"][i] + s.limit_margin_rad
        hi = limits["qMax"][i] - s.limit_margin_rad
        if not lo <= v <= hi:
            raise ValidationError(
                f"joint{i + 1} = {math.degrees(v):.1f} deg is outside [{math.degrees(lo):.1f}, {math.degrees(hi):.1f}] deg"
            )
    if q_now is None or len(q_now) != 7:
        raise ValidationError("current robot state unknown; refusing to move")
    steps = 40
    for k in range(steps + 1):
        u = k / steps
        qq = [a + (b - a) * u for a, b in zip(q_now, q)]
        pts = panda_points(qq, limits["tcpOffsetM"])
        for j, p in enumerate(pts):
            is_tcp = j == len(pts) - 1
            floor = s.table_z_m + (s.min_tcp_clearance_m if is_tcp else s.min_joint_clearance_m)
            if p[2] < floor:
                what = "TCP" if is_tcp else ("flange" if j == len(pts) - 2 else f"joint{j + 2}")
                raise ValidationError(
                    f"path goes below the table: {what} at z={p[2]:.3f} m (min {floor:.3f} m) at {u * 100:.0f}% of the path"
                )
    return q


# --- backends -----------------------------------------------------------------

class DryRunBackend:
    """Simulated arm: same API and realistic timing, no robot."""

    name = "dry-run"

    def __init__(self, limits: dict) -> None:
        self._limits = limits
        self._q = list(limits["readyPose"])
        self._stop = threading.Event()
        self._width = 0.08
        self._lock = threading.Lock()

    def connect(self) -> None:
        pass

    def read_q(self) -> List[float]:
        with self._lock:
            return list(self._q)

    def robot_mode(self) -> str:
        return "dry-run"

    def move(self, q: Sequence[float], speed: float) -> bool:
        self._stop.clear()
        start = self.read_q()
        dq = self._limits["dqMax"]
        dur = max(max(abs(b - a) / (v * speed) for a, b, v in zip(start, q, dq)) * 1.875, 0.2)
        t0 = time.monotonic()
        while True:
            if self._stop.is_set():
                return False
            u = min((time.monotonic() - t0) / dur, 1.0)
            sm = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5
            with self._lock:
                self._q = [a + (b - a) * sm for a, b in zip(start, q)]
            if u >= 1.0:
                return True
            time.sleep(0.01)

    def stop(self) -> None:
        self._stop.set()

    def recover(self) -> None:
        pass

    def gripper_move(self, width: float, speed: float) -> bool:
        time.sleep(min(abs(self._width - width) / max(speed, 1e-3), 2.0))
        self._width = width
        return True

    def gripper_grasp(self, width, speed, force, eps_in, eps_out) -> bool:
        time.sleep(0.5)
        self._width = width
        return True

    def gripper_width(self) -> float:
        return self._width


class PandaBackend:
    """Real Panda through panda-py.

    The API names used here were checked against the type stubs of
    panda-python 1.1.1 (the version pinned in requirements.txt): Panda(hostname,
    realtime_config=...), move_to_joint_position(positions, speed_factor) -> bool,
    get_state().q / .robot_mode, get_robot().stop(), stop_controller(),
    recover(), libfranka.Gripper.move/grasp/read_once.

    panda-py's default realtime_config is kIgnore: without real-time rights it
    would run the 1 kHz loop with normal scheduling and fail with
    communication reflexes. The bridge uses kEnforce (FRANKA_REALTIME=enforce),
    so it fails at connect time instead.
    """

    name = "panda-py"

    def __init__(self, host: str, use_gripper: bool, realtime: str = "enforce") -> None:
        self._host = host
        self._use_gripper = use_gripper
        self._realtime = realtime
        self.panda = None
        self.gripper = None
        self._last_q: Optional[List[float]] = None

    def connect(self) -> None:
        try:
            import panda_py
            from panda_py import libfranka
        except ImportError as exc:
            raise RuntimeError("panda-py is not installed: pip install -r apps/franka/requirements.txt") from exc
        rt = libfranka.RealtimeConfig.kIgnore if self._realtime == "ignore" else libfranka.RealtimeConfig.kEnforce
        self.panda = panda_py.Panda(self._host, realtime_config=rt)
        if self._use_gripper:
            self.gripper = libfranka.Gripper(self._host)

    def read_q(self) -> Optional[List[float]]:
        try:
            self._last_q = [float(v) for v in self.panda.get_state().q]
        except Exception:  # noqa: BLE001 - keep the last known value
            pass
        return self._last_q

    def robot_mode(self) -> str:
        try:
            return str(self.panda.get_state().robot_mode)
        except Exception:  # noqa: BLE001
            return "unknown"

    def move(self, q: Sequence[float], speed: float) -> bool:
        res = self.panda.move_to_joint_position(list(q), speed_factor=speed)
        return res is not False

    def stop(self) -> None:
        # libfranka Robot.stop() preempts a running motion in another thread
        # (it raises a ControlException there). Then stop panda-py's controller.
        for fn in (lambda: self.panda.get_robot().stop(), lambda: self.panda.stop_controller()):
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass

    def recover(self) -> None:
        self.panda.recover()

    def gripper_move(self, width: float, speed: float) -> bool:
        return bool(self.gripper.move(width, speed))

    def gripper_grasp(self, width, speed, force, eps_in, eps_out) -> bool:
        return bool(self.gripper.grasp(width, speed, force, eps_in, eps_out))

    def gripper_width(self) -> Optional[float]:
        try:
            return float(self.gripper.read_once().width)
        except Exception:  # noqa: BLE001
            return None


# --- the bridge -----------------------------------------------------------------

class Bridge:
    def __init__(self, settings: Settings, backend, limits: dict, clock: Callable[[], float] = time.monotonic):
        self.s = settings
        self.backend = backend
        self.limits = limits
        self.clock = clock
        self._lock = threading.RLock()
        self._lease_token: Optional[str] = None
        self._lease_owner: Optional[str] = None
        self._lease_seen = 0.0
        self._moving = False
        self._motion_thread: Optional[threading.Thread] = None
        self._last_motion = {"id": None, "ok": None, "error": ""}
        self._connected = False
        self._error = ""

    # lease ---------------------------------------------------------------
    def acquire(self, owner: str):
        with self._lock:
            self._expire_lease_locked()
            if self._lease_token is not None:
                return None, f"lease held by {self._lease_owner}"
            self._lease_token = secrets.token_hex(16)
            self._lease_owner = owner or "unknown"
            self._lease_seen = self.clock()
            return self._lease_token, ""

    def check_lease(self, token: Optional[str]) -> bool:
        with self._lock:
            self._expire_lease_locked()
            if token is None or self._lease_token is None or not secrets.compare_digest(token, self._lease_token):
                return False
            self._lease_seen = self.clock()
            return True

    def release(self, token: Optional[str]) -> bool:
        with self._lock:
            if not self.check_lease(token):
                return False
            self.stop("lease released")
            self._lease_token = None
            self._lease_owner = None
            return True

    def _expire_lease_locked(self) -> None:
        if self._lease_token is not None and self.clock() - self._lease_seen > self.s.lease_timeout_s:
            owner = self._lease_owner
            self._lease_token = None
            self._lease_owner = None
            if self._moving:
                self.stop(f"heartbeat lost from {owner}")
            print(f"[franka] lease of {owner} expired", flush=True)

    def watchdog_tick(self) -> None:
        with self._lock:
            self._expire_lease_locked()

    # state ---------------------------------------------------------------
    def connect(self) -> None:
        try:
            self.backend.connect()
            self._connected = True
            self._error = ""
        except Exception as exc:  # noqa: BLE001
            self._connected = False
            self._error = str(exc)
            print(f"[franka] connect failed: {exc}", flush=True)

    def state(self) -> dict:
        q = self.backend.read_q() if self._connected else None
        return {
            "q": q or [],
            "connected": self._connected and q is not None,
            "dryRun": self.s.dry_run,
            "backend": self.backend.name,
            "mode": self.backend.robot_mode() if self._connected else "disconnected",
            "moving": self._moving,
            "lease": self._lease_owner,
            "lastMotion": dict(self._last_motion),
            "gripperWidth": self.backend.gripper_width() if self._connected else None,
            "error": self._error,
        }

    # commands --------------------------------------------------------------
    def move(self, q_goal, speed_factor=None, motion_id=None) -> dict:
        with self._lock:
            if not self._connected:
                return {"ok": False, "error": "robot not connected"}
            if self._moving:
                return {"ok": False, "error": "a motion is running"}
            try:
                q = validate_goal(q_goal, self.backend.read_q(), self.limits, self.s)
            except ValidationError as exc:
                return {"ok": False, "error": f"rejected: {exc}"}
            speed = self.s.speed_factor if speed_factor is None else float(speed_factor)
            if not math.isfinite(speed) or speed <= 0:
                return {"ok": False, "error": "speedFactor must be > 0"}
            speed = min(speed, self.s.speed_factor_max)
            self._moving = True
            self._last_motion = {"id": motion_id, "ok": None, "error": ""}

            def run():
                ok, err = False, ""
                try:
                    ok = self.backend.move(q, speed)
                    if not ok:
                        err = "motion stopped or failed"
                except Exception as exc:  # noqa: BLE001 - libfranka reflexes arrive here
                    err = f"{type(exc).__name__}: {exc}"
                with self._lock:
                    self._moving = False
                    self._last_motion = {"id": motion_id, "ok": ok, "error": err}
                    if err:
                        self._error = err
                print(f"[franka] motion {motion_id} ok={ok} {err}", flush=True)

            self._motion_thread = threading.Thread(target=run, daemon=True)
            self._motion_thread.start()
            return {"ok": True, "error": "", "speedFactor": speed}

    def stop(self, reason: str = "stop requested") -> dict:
        print(f"[franka] STOP: {reason}", flush=True)
        try:
            self.backend.stop()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "error": ""}

    def gripper(self, open_flag: bool) -> dict:
        if not self._connected:
            return {"ok": False, "error": "robot not connected"}
        if not self.s.use_gripper and not self.s.dry_run:
            return {"ok": False, "error": "gripper disabled (FRANKA_GRIPPER=0)"}
        try:
            if open_flag:
                ok = self.backend.gripper_move(self.s.open_width_m, self.s.gripper_speed)
            else:
                ok = self.backend.gripper_grasp(
                    self.s.grasp_width_m, self.s.gripper_speed, self.s.grasp_force_n,
                    self.s.grasp_eps_inner_m, self.s.grasp_eps_outer_m,
                )
            return {"ok": bool(ok), "error": "" if ok else ("open failed" if open_flag else "grasp failed (no object?)")}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def recover(self) -> dict:
        if self._moving:
            return {"ok": False, "error": "a motion is running"}
        try:
            self.backend.recover()
            self._error = ""
            return {"ok": True, "error": ""}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}


def make_handler(bridge: Bridge):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._json({"status": "ok"})
            elif self.path == "/state":
                self._json(bridge.state())
            else:
                self._json({"ok": False, "error": "not found"}, 404)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", "0") or 0)
            if n > 65536:
                self._json({"ok": False, "error": "body too large"}, 413)
                return
            raw = self.rfile.read(n) if n else b"{}"
            try:
                data = json.loads(raw or b"{}")
                if not isinstance(data, dict):
                    raise ValueError
            except ValueError:
                self._json({"ok": False, "error": "bad json"}, 400)
                return
            token = self.headers.get("X-Lease")
            if self.path == "/stop":
                self._json(bridge.stop("POST /stop"))
                return
            if self.path == "/lease":
                tok, err = bridge.acquire(str(data.get("owner", "")))
                self._json({"ok": tok is not None, "token": tok, "error": err}, 200 if tok else 409)
                return
            if not bridge.check_lease(token):
                self._json({"ok": False, "error": "no valid lease"}, 403)
                return
            if self.path == "/heartbeat":
                self._json({"ok": True})
            elif self.path == "/release":
                self._json({"ok": bridge.release(token)})
            elif self.path == "/move":
                self._json(bridge.move(data.get("q"), data.get("speedFactor"), data.get("id")))
            elif self.path == "/gripper":
                self._json(bridge.gripper(bool(data.get("open"))))
            elif self.path == "/recover":
                self._json(bridge.recover())
            else:
                self._json({"ok": False, "error": "not found"}, 404)

    return Handler


def take_lock(path: str):
    """Hold an exclusive lock for the process lifetime (one bridge per host)."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    fh = open(path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(f"[franka] another bridge holds {path}; only one process may command the arm", file=sys.stderr)
        sys.exit(3)
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def main() -> None:
    s = Settings()
    if not ipaddress.ip_address(s.host).is_loopback:
        print(f"[franka] FRANKA_BRIDGE_HOST={s.host} is not a loopback address; refusing to start", file=sys.stderr)
        sys.exit(2)
    lock = take_lock(s.lock_file)  # noqa: F841 - keep the lock open
    limits = load_limits(s.limits_file)
    backend = DryRunBackend(limits) if s.dry_run else PandaBackend(s.robot_host, s.use_gripper, s.realtime)
    bridge = Bridge(s, backend, limits)
    print(f"[franka] backend={backend.name} dry_run={s.dry_run} robot={s.robot_host if not s.dry_run else '-'} "
          f"speed={s.speed_factor} (max {s.speed_factor_max})", flush=True)
    bridge.connect()

    def watchdog():
        while True:
            time.sleep(0.1)
            bridge.watchdog_tick()

    threading.Thread(target=watchdog, daemon=True).start()
    server = ThreadingHTTPServer((s.host, s.port), make_handler(bridge))
    print(f"[franka] bridge listening on http://{s.host}:{s.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        bridge.stop("bridge shutting down")


if __name__ == "__main__":
    main()
