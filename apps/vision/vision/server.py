"""Lightweight HTTP server for the vision service.

Uses the standard library (http.server) so the only non-stdlib dependency
outside OpenCV/numpy is nothing. Endpoints: /health, /stream (MJPEG),
/detect (JSON), /calibrate (JSON).
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from .capture import Camera
from .board import Board, calibrate_from_markers, detect_aruco_marker
from .config import config
from .pieces import detect_pieces

_camera = None
_board = Board()
try:
    _board.load()  # load a saved calibration if present
except Exception as exc:  # a corrupt calibration file must not stop the service
    print(f"[vision] could not load calibration: {exc}")


def _get_camera() -> Camera:
    global _camera
    if _camera is None:
        _camera = Camera(config.CAMERA_INDEX)
        _camera.start()
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok"})
        elif self.path == "/calibrate":
            self._calibrate()
        elif self.path == "/detect":
            self._detect()
        elif self.path == "/stream":
            self._stream()
        else:
            self.send_error(404)

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
        ok = calibrate_from_markers(frame, _board)
        if ok:
            _board.save()
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
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
    cam = _get_camera()
    if cam.available:
        print(f"[vision] camera {config.CAMERA_INDEX} open")
    else:
        print(f"[vision] camera {config.CAMERA_INDEX} NOT available; serving placeholder")
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"[vision] listening on http://{config.HOST}:{config.PORT}")
    server.serve_forever()


if __name__ == "__main__":
    run()
