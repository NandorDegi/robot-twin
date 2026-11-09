"""Tests for the Franka bridge. They run without a robot and without panda-py."""

import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.request

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import franka_bridge as fb  # noqa: E402

LIMITS = fb.load_limits(fb.DEFAULT_LIMITS)
READY = LIMITS["readyPose"]


def settings(**kw):
    s = fb.Settings()
    s.dry_run = True
    for k, v in kw.items():
        setattr(s, k, v)
    return s


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_fk_ready_pose_matches_official_tcp():
    # Franka ready pose: TCP at about (0.307, 0, 0.487) m in the base frame.
    tcp = fb.panda_points(READY, LIMITS["tcpOffsetM"])[-1]
    assert tcp[0] == pytest.approx(0.307, abs=0.002)
    assert tcp[1] == pytest.approx(0.0, abs=0.002)
    assert tcp[2] == pytest.approx(0.487, abs=0.002)


def test_limits_match_typescript_values():
    assert LIMITS["qMax"][5] == pytest.approx(3.7525)
    assert LIMITS["qMin"][3] == pytest.approx(-3.0718)
    assert len(LIMITS["qMin"]) == 7


@pytest.mark.parametrize(
    "q,msg",
    [
        ([0] * 6, "7 joint"),
        ([0, 0, 0, -1, 0, 1, float("nan")], "finite"),
        ([0, 0, 0, 0.0, 0, 1.5, 0], "joint4"),  # joint4 must stay below -4 deg
        ([0, 0, 0, -2, 0, 3.9, 0], "joint6"),  # Panda joint6 stops at 215 deg
    ],
)
def test_validate_rejects(q, msg):
    with pytest.raises(fb.ValidationError, match=msg):
        fb.validate_goal(q, READY, LIMITS, settings())


def test_validate_rejects_unknown_state():
    with pytest.raises(fb.ValidationError, match="unknown"):
        fb.validate_goal(READY, None, LIMITS, settings())


def test_validate_rejects_path_below_table():
    # Shoulder pitched far forward with the elbow straight: the hand hits the table.
    q = [0, 1.7, 0, -0.1, 0, 1.8, 0.785]
    with pytest.raises(fb.ValidationError, match="below the table"):
        fb.validate_goal(q, READY, LIMITS, settings())


def test_validate_accepts_ready_neighbourhood():
    q = list(READY)
    q[0] = 0.3
    assert fb.validate_goal(q, READY, LIMITS, settings()) == q


def test_lease_is_exclusive_and_expires():
    clock = Clock()
    b = fb.Bridge(settings(lease_timeout_s=1.0), fb.DryRunBackend(LIMITS), LIMITS, clock=clock)
    tok, _ = b.acquire("server")
    assert tok
    tok2, err = b.acquire("intruder")
    assert tok2 is None and "server" in err
    assert not b.check_lease("wrong")
    clock.t = 0.5
    assert b.check_lease(tok)  # heartbeat
    clock.t = 2.0
    b.watchdog_tick()
    assert not b.check_lease(tok)  # expired
    tok3, _ = b.acquire("intruder")
    assert tok3


def test_heartbeat_loss_stops_motion():
    clock = Clock()
    backend = fb.DryRunBackend(LIMITS)
    b = fb.Bridge(settings(lease_timeout_s=1.0, speed_factor=0.05), backend, LIMITS, clock=clock)
    b.connect()
    b.acquire("server")
    goal = list(READY)
    goal[0] = 1.0
    assert b.move(goal)["ok"]
    time.sleep(0.1)
    clock.t = 5.0
    b.watchdog_tick()
    for _ in range(100):
        if not b.state()["moving"]:
            break
        time.sleep(0.02)
    st = b.state()
    assert not st["moving"]
    assert st["lastMotion"]["ok"] is False
    assert abs(st["q"][0] - 1.0) > 0.05  # stopped before the goal


def test_move_rejected_while_moving_and_speed_capped():
    backend = fb.DryRunBackend(LIMITS)
    b = fb.Bridge(settings(speed_factor_max=0.3), backend, LIMITS)
    b.connect()
    goal = list(READY)
    goal[0] = 0.5
    r = b.move(goal, speed_factor=2.0)
    assert r["ok"] and r["speedFactor"] == 0.3
    assert not b.move(goal)["ok"]
    b.stop()


class FakePanda:
    def __init__(self):
        self.moves = []
        self.q = list(READY)

    def get_state(self):
        return type("S", (), {"q": self.q, "robot_mode": "kIdle"})()

    def move_to_joint_position(self, q, speed_factor):
        self.moves.append((q, speed_factor))
        self.q = list(q)
        return True


def test_panda_backend_passes_speed_factor():
    be = fb.PandaBackend("x", use_gripper=False)
    be.panda = FakePanda()
    b = fb.Bridge(settings(dry_run=False, speed_factor=0.1), be, LIMITS)
    b._connected = True
    goal = list(READY)
    goal[6] = 0.0
    assert b.move(goal)["ok"]
    b._motion_thread.join(2)
    assert be.panda.moves == [(goal, 0.1)]
    assert b.state()["lastMotion"]["ok"] is True


def _free_port():
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def test_http_requires_lease_and_second_instance_refused(tmp_path):
    port = _free_port()
    env = dict(os.environ, FRANKA_BRIDGE_PORT=str(port), FRANKA_LOCK_FILE=str(tmp_path / "f.lock"), FRANKA_DRY_RUN="1")
    script = os.path.join(os.path.dirname(__file__), "..", "franka_bridge.py")
    p = subprocess.Popen([sys.executable, "-I", script], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        base = f"http://127.0.0.1:{port}"
        for _ in range(50):
            try:
                urllib.request.urlopen(base + "/health", timeout=0.2)
                break
            except OSError:
                time.sleep(0.1)

        def post(path, body, token=None):
            req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST")
            if token:
                req.add_header("X-Lease", token)
            try:
                with urllib.request.urlopen(req, timeout=2) as r:
                    return r.status, json.load(r)
            except urllib.error.HTTPError as e:
                return e.code, json.load(e)

        assert post("/move", {"q": READY})[0] == 403
        code, lease = post("/lease", {"owner": "test"})
        assert code == 200
        assert post("/lease", {"owner": "other"})[0] == 409
        code, res = post("/move", {"q": READY}, lease["token"])
        assert code == 200 and res["ok"]
        # A second bridge on the same lock file must refuse to start.
        p2 = subprocess.run([sys.executable, "-I", script], env=dict(env, FRANKA_BRIDGE_PORT=str(_free_port())),
                            capture_output=True, timeout=10)
        assert p2.returncode == 3
        # A non-loopback bind is refused.
        p3 = subprocess.run([sys.executable, "-I", script], env=dict(env, FRANKA_BRIDGE_HOST="0.0.0.0"),
                            capture_output=True, timeout=10)
        assert p3.returncode == 2
    finally:
        p.terminate()
        p.wait(5)
