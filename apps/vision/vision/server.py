"""Lightweight HTTP server for the vision service (standard library only).

Endpoints:
  GET  /health      {"status": "ok"}
  GET  /stream      MJPEG feed for the twin
  GET  /detect      clickable piece overlay for the twin (heuristic or YOLO)
  GET  /board       chess-loop board state: per square "w" | "b" | null
  POST /calibrate   fit the homography from the 4 ArUco corner markers
  POST /reference   save the EMPTY board image used by /board
  /calib/...        the calibration wizard (vision/calib_api.py)
  (GET /calibrate is kept for old clients.)
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from .capture import Camera
from .board import Board, calibrate_from_markers, detect_aruco_marker
from .config import config
from .pieces import detect_pieces
from . import calib_api

_camera = None
_reference = None
_board = Board()
try:
    _board.load()  # load a saved calibration if present
except Exception as exc:  # a corrupt calibration file must not stop the service
    print(f"[vision] could not load calibration: {exc}")


def _load_reference():
    global _reference
    if os.path.exists(config.REFERENCE_FILE):
        import cv2

        _reference = cv2.imread(config.REFERENCE_FILE)


try:
    _load_reference()
except Exception as exc:  # noqa: BLE001
    print(f"[vision] could not load the empty-board reference: {exc}")


def _get_camera() -> Camera:
    global _camera
    if _camera is None:
        # Index, synthetic or file source; the calibration's camera settings.
        _camera = calib_api.open_camera()
    return _camera


def _placeholder_jpeg():
    """A small grey JPEG so the stream is not empty before a camera exists."""
    try:
        import cv2
    except ImportError:
        return None
    img = np.zeros((config.FRAME_HEIGHT, config.FRAME_WIDTH, 3), np.uint8)
    img[:] = (40, 40, 40)
    cv2.putText(
        img,
        "no camera",
        (config.FRAME_WIDTH // 2 - 80, config.FRAME_HEIGHT // 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (120, 120, 120),
        2,
    )
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, config.JPEG_QUALITY])
    return buf.tobytes() if ok else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence per-request logs
        pass

    def _send_json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/calib/"):
            calib_api.handle(self, "GET")
        elif path == "/health":
            self._send_json({"status": "ok"})
        elif path == "/calibrate":
            self._calibrate()
        elif path == "/detect":
            self._detect()
        elif path == "/board":
            self._board_state("debug" in self.path)
        elif path == "/stream":
            self._stream()
        else:
            self.send_error(404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/calib/"):
            calib_api.handle(self, "POST")
        elif path == "/calibrate":
            self._calibrate()
        elif path == "/reference":
            self._save_reference()
        else:
            self.send_error(404)

    def _board_state(self, debug: bool):
        if not _board.calibrated:
            self._send_json({"ok": False, "error": "board not calibrated (POST /vision/calibrate)"})
            return
        if _reference is None:
            self._send_json({"ok": False, "error": "no empty-board reference (POST /vision/reference with an empty board)"})
            return
        frame = _get_camera().read()
        if frame is None:
            self._send_json({"ok": False, "error": "no camera frame"})
            return
        st = _board.board_state(frame, _reference)
        out = {"ok": True, "squares": st["squares"], "time": time.time()}
        if debug:
            out["scores"] = st["scores"]
        self._send_json(out)

    def _save_reference(self):
        global _reference
        import cv2

        if calib_api.wizard_active():
            self._send_json({"ok": False, "error": "a wizard calibration is active: retake the reference in the Calibrate wizard"})
            return
        frame = _get_camera().read()
        if frame is None:
            self._send_json({"ok": False, "error": "no camera frame"})
            return
        cv2.imwrite(config.REFERENCE_FILE, frame)
        _reference = frame
        self._send_json({"ok": True, "reference_file": config.REFERENCE_FILE})

    def _detect(self):
        cam = _get_camera()
        frame = cam.read()
        if frame is None:
            self._send_json({"error": "no frame", "pieces": [], "board_calibrated": _board.calibrated})
            return
        pieces = detect_pieces(frame, _board)
        h, w = frame.shape[:2]
        self._send_json(
            {
                "pieces": pieces,
                "board_calibrated": _board.calibrated,
                "frame": {"width": w, "height": h},
            }
        )

    def _calibrate(self):
        cam = _get_camera()
        frame = cam.read()
        if frame is None:
            self._send_json({"error": "no frame", "calibrated": _board.calibrated})
            return
        corners, ids = detect_aruco_marker(frame)
        marker_list = (
            [{"id": int(i), "corners": c.tolist()} for i, c in zip(ids, corners)]
            if ids
            else []
        )
        if calib_api.wizard_active():
            self._send_json({"calibrated": _board.calibrated, "fitted": False, "markers": marker_list,
                             "error": "a wizard calibration is active: use the Calibrate wizard (/vision/calib)"})
            return
        ok = calibrate_from_markers(frame, _board)
        if ok:
            try:
                _board.save()
            except RuntimeError as exc:  # never overwrite a wizard calibration
                self._send_json({"calibrated": _board.calibrated, "fitted": ok, "saved": False, "error": str(exc)})
                return
        self._send_json(
            {
                "calibrated": _board.calibrated,
                "fitted": ok,
                "markers": marker_list,
                "calibration_file": config.CALIBRATION_FILE,
            }
        )

    def _stream(self):
        cam = _get_camera()
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                cam = _get_camera()  # the wizard can switch the camera
                frame = cam.read()
                jpeg = cam.jpeg(frame) if frame is not None else _placeholder_jpeg()
                if jpeg is None:
                    time.sleep(0.05)
                    continue
                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                self.wfile.write(jpeg)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
                time.sleep(1.0 / config.FPS)
        except (BrokenPipeError, ConnectionResetError):
            return


def run():
    try:
        calib_api.activate_from_file()  # the wizard's calibration file (either format)
    except Exception as exc:  # noqa: BLE001 - a bad file must not stop the service
        print(f"[vision] could not load the calibration: {exc}")
    cam = _get_camera()
    if cam.available:
        print(f"[vision] camera {cam.index} open")
    else:
        print(f"[vision] camera {cam.index} NOT available; serving placeholder")
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"[vision] listening on http://{config.HOST}:{config.PORT}")
    server.serve_forever()


if __name__ == "__main__":
    run()
