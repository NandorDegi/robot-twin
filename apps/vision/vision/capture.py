"""Camera capture with a background reader thread.

cv2 is imported lazily so the service can still start (and report a clear
message) when OpenCV is not installed yet.
"""

import threading
import time
from typing import Optional

from .config import config


def _cv2():
    try:
        import cv2  # noqa: F401

        return cv2
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise RuntimeError(
            "OpenCV is not installed. Run: pip install -r requirements.txt"
        ) from exc


class Camera:
    """Reads frames continuously from a camera index, returns the latest."""

    synthetic = False

    def __init__(self, index=config.CAMERA_INDEX, width: int = None, height: int = None):
        # `index` is a camera index, or a path to a video/image file (looped).
        self._cv2 = _cv2()
        self._index = index
        self._is_file = isinstance(index, str)
        self.width = int(width or config.FRAME_WIDTH)
        self.height = int(height or config.FRAME_HEIGHT)
        self._cap = self._cv2.VideoCapture(index)
        self._cap.set(self._cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self._cap.set(self._cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self.controls_set: dict = {}
        self._frame = None
        self._running = False
        self._lock = threading.Lock()
        self._cap_lock = threading.Lock()  # guards self._cap (read vs. controls)
        self._thread = None

    @property
    def available(self) -> bool:
        return bool(self._cap.isOpened())

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=1)
        self._cap.release()

    def _loop(self) -> None:
        failures = 0
        while self._running:
            with self._cap_lock:
                ok, frame = self._cap.read() if self._cap.isOpened() else (False, None)
            if not ok and self._is_file and self._cap.isOpened():
                # A video file (synthetic camera for tests): loop it.
                self._cap.set(self._cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self._cap.read()
            if ok and self._is_file:
                time.sleep(1.0 / max(config.FPS, 1))
            if not ok:
                # Do not spin: a missing camera must not eat a CPU core on the
                # real-time box. Try to reopen it every few seconds.
                failures += 1
                with self._lock:
                    self._frame = None
                time.sleep(0.2)
                if failures % 25 == 0:
                    self._cap.release()
                    self._cap = self._cv2.VideoCapture(self._index)
                continue
            failures = 0
            with self._lock:
                self._frame = frame

    @property
    def index(self):
        return self._index

    # UVC controls through OpenCV (V4L2). A control that the camera does not
    # support reports None. V4L2 auto exposure: 1 = manual, 3 = auto.
    CONTROLS = {
        "auto_exposure": "CAP_PROP_AUTO_EXPOSURE",
        "exposure": "CAP_PROP_EXPOSURE",
        "auto_wb": "CAP_PROP_AUTO_WB",
        "wb_temperature": "CAP_PROP_WB_TEMPERATURE",
        "autofocus": "CAP_PROP_AUTOFOCUS",
        "focus": "CAP_PROP_FOCUS",
        "gain": "CAP_PROP_GAIN",
        "brightness": "CAP_PROP_BRIGHTNESS",
    }

    def controls(self) -> dict:
        out = {}
        with self._cap_lock:
            for name, prop in self.CONTROLS.items():
                pid = getattr(self._cv2, prop, None)
                v = self._cap.get(pid) if pid is not None and self._cap.isOpened() else -1
                out[name] = None if v == -1 else float(v)
        return out

    def set_control(self, name: str, value: float) -> bool:
        prop = self.CONTROLS.get(name)
        pid = getattr(self._cv2, prop, None) if prop else None
        if pid is None:
            return False
        with self._cap_lock:
            ok = bool(self._cap.set(pid, float(value)))
        if ok:
            self.controls_set[name] = float(value)
        return ok

    def read(self):
        """Return the latest frame (BGR numpy array) or None if not available."""
        with self._lock:
            frame = self._frame
        return frame

    def jpeg(self, frame=None, quality: int = config.JPEG_QUALITY) -> Optional[bytes]:
        """Encode a frame as JPEG bytes. Returns None if no frame."""
        if frame is None:
            frame = self.read()
        if frame is None:
            return None
        ok, buf = self._cv2.imencode(".jpg", frame, [self._cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            return None
        return buf.tobytes()
