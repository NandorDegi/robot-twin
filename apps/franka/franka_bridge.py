"""
Franka Panda control bridge.

Connects to the Panda through the Franka Control Interface (FCI) using
`panda-py` (Python bindings for libfranka) and exposes a small HTTP API that
the Node robot server's `FrankaAdapter` calls.

FCI setup (see Franka docs):
  * The workstation must be wired to the CONTROL (shop-floor) network port of
    the Panda control unit, NOT the arm network port.
  * The control unit must have the FCI feature installed (Franka World account).
  * Set FRANKA_HOST to the control unit's IP (default 192.168.1.4).
  * FER/Panda needs libfranka < 0.10; `panda-python` ships 0.9.2 by default.

Endpoints
  GET  /state        -> {"q":[rad,...], "connected":bool, "error":str}
  POST /command      -> {"q":[rad,...]}  async joint-position move
  POST /gripper      -> {"open":bool}    open/close the hand
  POST /estop        -> frees the arm (stop control, no safe mode)
"""

import json
import os
import threading
import time

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FRANKA_HOST = os.environ.get("FRANKA_HOST", "192.168.1.4")
PORT = int(os.environ.get("FRANKA_BRIDGE_PORT", "3002"))

_robot = None
_gripper = None
_connected = False
_lock = threading.Lock()
_last_error = ""


def _import_panda():
    try:
        import panda_py  # noqa: F401

        return panda_py
    except ImportError as exc:
        raise RuntimeError(
            "panda-py is not installed. In the FCI workstation run: "
            "pip install panda-python"
        ) from exc


def connect():
    global _robot, _gripper, _connected, _last_error
    try:
        panda_py = _import_panda()
        host = FRANKA_HOST
        _robot = panda_py.Robot(host)
        _gripper = panda_py.Gripper(_robot)
        _robot.connect()
        _connected = True
        _last_error = ""
        print(f"[franka] connected to {host} via FCI")
    except Exception as exc:  # noqa: BLE001
        _connected = False
        _last_error = str(exc)
        print(f"[franka] connect failed: {exc}")


def state():
    global _last_error
    if not _connected or _robot is None:
        return {"q": [], "connected": False, "error": _last_error}
    try:
        st = _robot.read_once()
        # st.q is the current joint positions in radians.
        q = list(st.q)
        return {"q": q, "connected": True, "error": ""}
    except Exception as exc:  # noqa: BLE001
        _last_error = str(exc)
        return {"q": [], "connected": False, "error": _last_error}


def command(q):
    global _connected, _last_error
    if not _connected or _robot is None:
        return {"ok": False, "error": _last_error or "not connected"}
    try:
        _robot.move_to_joint_position(q)
        return {"ok": True, "error": ""}
    except Exception as exc:  # noqa: BLE001
        _last_error = str(exc)
        return {"ok": False, "error": _last_error}


def gripper(open_flag):
    if not _connected or _gripper is None:
        return {"ok": False, "error": _last_error or "not connected"}
    try:
        # Franka hand: open is a large width (mm), closed is a small width.
        width = 80.0 if open_flag else 0.0
        _gripper.move(width)
        return {"ok": True, "error": ""}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def free():
    global _connected, _last_error
    if _robot is None:
        return {"ok": False, "error": "not initialised"}
    try:
        _robot.stop_control()
        _robot.disconnect()
        _connected = False
        return {"ok": True, "error": ""}
    except Exception as exc:  # noqa: BLE001
        _last_error = str(exc)
        return {"ok": False, "error": _last_error}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/state":
            self._json(state())
        else:
            self.send_error(404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._json({"ok": False, "error": "bad json"}, 400)
            return
        if self.path == "/command":
            self._json(command([float(x) for x in data.get("q", [])]))
        elif self.path == "/gripper":
            self._json(gripper(bool(data.get("open"))))
        elif self.path == "/estop":
            self._json(free())
        else:
            self.send_error(404)


def main():
    connect()  # tries to connect at startup; /state reports if it failed
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[franka] bridge listening on http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
