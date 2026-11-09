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

    def __init__(self, index: int = config.CAMERA_INDEX):
        self._cv2 = _cv2()
        self._index = index
        self._cap = self._cv2.VideoCapture(index)
        self._cap.set(self._cv2.CAP_PROP_FRAME_WIDTH, config.FRAME_WIDTH)
        self._cap.set(self._cv2.CAP_PROP_FRAME_HEIGHT, config.FRAME_HEIGHT)
        self._frame = None
        self._running = False
        self._lock = threading.Lock()
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
            ok, frame = self._cap.read() if self._cap.isOpened() else (False, None)
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
