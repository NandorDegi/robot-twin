"""Synthetic camera: a rendered chessboard seen at an angle (dev and tests only).

Select it with VISION_CAMERA_SOURCE=synthetic. The scene (pieces, ArUco corner
markers, light, glare) is set through POST /calib/sim/scene, so the whole
calibration wizard can be tried without a camera. It is never used on the
robot unless somebody sets the variable.

The board is rendered in perspective from a known homography, so tests can
compare a fitted calibration with the truth (TRUE_CORNERS).
"""

import threading
import time

import numpy as np

from .board import square_name

# Outer board corners in a 1280x720 image (a1 bottom-left, white at the bottom).
TRUE_CORNERS = {
    "a8": (420.0, 95.0),
    "h8": (905.0, 120.0),
    "h1": (960.0, 640.0),
    "a1": (365.0, 615.0),
}
BASE_SIZE = (1280, 720)
MARGIN_MM = 40.0
TEX_PX_PER_MM = 2.0
MARKER_MM = 26.0


def start_occupancy() -> dict:
    occ = {}
    for r in range(8):
        for f in range(8):
            occ[square_name(r, f)] = "w" if r < 2 else ("b" if r > 5 else None)
    return occ


class SyntheticScene:
    def __init__(self, square_mm: float = 40.0):
        self.square = square_mm
        self.pieces: dict = {}
        self.markers = True
        self.light = 1.0
        self.glare = False
        self.shadow = False
        self.lock = threading.Lock()

    def set(self, preset: str = None, markers=None, light=None, glare=None, shadow=None, moves=None, pieces=None):
        with self.lock:
            if preset == "empty":
                self.pieces = {}
            elif preset == "start":
                self.pieces = {k: v for k, v in start_occupancy().items() if v}
            if pieces is not None:
                self.pieces = {k: v for k, v in pieces.items() if v in ("w", "b")}
            for mv in moves or []:
                a, b = mv[0], mv[1]
                if a in self.pieces:
                    self.pieces[b] = self.pieces.pop(a)
            if markers is not None:
                self.markers = bool(markers)
            if light is not None:
                self.light = float(light)
            if glare is not None:
                self.glare = bool(glare)
            if shadow is not None:
                self.shadow = bool(shadow)

    def as_dict(self) -> dict:
        with self.lock:
            return {
                "pieces": dict(self.pieces),
                "markers": self.markers,
                "light": self.light,
                "glare": self.glare,
                "shadow": self.shadow,
            }


def true_homography(width: int = BASE_SIZE[0], height: int = BASE_SIZE[1], square: float = 40.0) -> np.ndarray:
    """Board plane (mm, a8 corner origin, x a->h, y 8->1) -> pixel, for this size."""
    import cv2

    sx, sy = width / BASE_SIZE[0], height / BASE_SIZE[1]
    w = 8 * square
    src = np.float32([[0, 0], [w, 0], [w, w], [0, w]])
    dst = np.float32([[TRUE_CORNERS[n][0] * sx, TRUE_CORNERS[n][1] * sy] for n in ("a8", "h8", "h1", "a1")])
    return cv2.getPerspectiveTransform(src, dst).astype(float)


def render(scene: SyntheticScene, width: int, height: int, controls: dict, rng=None) -> np.ndarray:
    import cv2

    rng = rng or np.random.default_rng()
    st = scene.as_dict()
    sq = scene.square
    k = TEX_PX_PER_MM
    size = int(round((8 * sq + 2 * MARGIN_MM) * k))
    tex = np.zeros((size, size, 3), np.uint8)
    tex[:] = (40, 62, 84)  # frame

    def px(mm):
        return int(round((mm + MARGIN_MM) * k))

    for r in range(8):
        for f in range(8):
            row = 7 - r
            dark = (r + f) % 2 == 0  # a1 is dark
            c = (70, 98, 128) if dark else (196, 214, 226)
            cv2.rectangle(tex, (px(f * sq), px(row * sq)), (px((f + 1) * sq) - 1, px((row + 1) * sq) - 1), c, -1)

    for name, colour in st["pieces"].items():
        f = "abcdefgh".index(name[0])
        r = int(name[1]) - 1
        cx, cy = px((f + 0.5) * sq), px((7 - r + 0.5) * sq)
        rad = int(0.33 * sq * k)
        cv2.circle(tex, (cx + 3, cy + 4), rad, (25, 35, 45), -1, cv2.LINE_AA)  # shadow
        if colour == "w":
            cv2.circle(tex, (cx, cy), rad, (232, 236, 240), -1, cv2.LINE_AA)
            cv2.circle(tex, (cx, cy), rad, (60, 60, 60), 2, cv2.LINE_AA)
            cv2.circle(tex, (cx - rad // 3, cy - rad // 3), rad // 4, (252, 252, 252), -1, cv2.LINE_AA)
        else:
            cv2.circle(tex, (cx, cy), rad, (28, 28, 32), -1, cv2.LINE_AA)
            cv2.circle(tex, (cx, cy), rad, (85, 85, 90), 2, cv2.LINE_AA)
            cv2.circle(tex, (cx - rad // 3, cy - rad // 3), rad // 5, (70, 70, 75), -1, cv2.LINE_AA)

    if st["markers"]:
        aruco = cv2.aruco
        d = aruco.getPredefinedDictionary(aruco.DICT_4X4_50)
        w = 8 * sq
        for mid, (bx, by) in {0: (0, 0), 1: (w, 0), 2: (0, w), 3: (w, w)}.items():
            quiet = MARKER_MM * 1.4
            cv2.rectangle(tex, (px(bx - quiet / 2), px(by - quiet / 2)), (px(bx + quiet / 2), px(by + quiet / 2)), (255, 255, 255), -1)
            side = int(round(MARKER_MM * k))
            img = aruco.generateImageMarker(d, mid, side)
            x0, y0 = px(bx - MARKER_MM / 2), px(by - MARKER_MM / 2)
            tex[y0:y0 + side, x0:x0 + side] = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

    # Background (table) and the perspective warp.
    bg = np.zeros((height, width, 3), np.uint8)
    grad = np.linspace(0.8, 1.1, width, dtype=np.float32)[None, :, None]
    bg[:] = (np.array([70, 100, 125], np.float32)[None, None, :] * grad).clip(0, 255).astype(np.uint8)
    H = true_homography(width, height, sq)
    S = np.array([[k, 0, k * MARGIN_MM], [0, k, k * MARGIN_MM], [0, 0, 1]], dtype=float)
    img = cv2.warpPerspective(tex, H @ np.linalg.inv(S), (width, height), dst=bg, borderMode=cv2.BORDER_TRANSPARENT, flags=cv2.INTER_LINEAR)

    f = img.astype(np.float32)
    exposure = controls.get("exposure", -5.0)
    gain = st["light"] * (2.0 ** ((exposure + 5.0) / 2.0)) * (1.0 + controls.get("gain", 0.0) / 100.0)
    f *= gain
    if st["shadow"]:
        yy, xx = np.mgrid[0:height, 0:width]
        f *= (1.0 - 0.45 * np.exp(-(((xx - width * 0.62) / (width * 0.08)) ** 2 + ((yy - height * 0.35) / (height * 0.12)) ** 2)))[..., None]
    if st["glare"]:
        yy, xx = np.mgrid[0:height, 0:width]
        f += 260.0 * np.exp(-(((xx - width * 0.45) / (width * 0.04)) ** 2 + ((yy - height * 0.55) / (height * 0.06)) ** 2))[..., None]
    f += rng.normal(0, 2.0, f.shape).astype(np.float32)
    out = f.clip(0, 255).astype(np.uint8)
    focus = controls.get("focus")
    if controls.get("autofocus", 1.0) == 0 and focus is not None and abs(focus - 30.0) > 10:
        r = int(min(15, abs(focus - 30.0) / 5)) * 2 + 1
        out = cv2.GaussianBlur(out, (r, r), 0)
    return out


class SyntheticCamera:
    """Same interface as capture.Camera, frames rendered from a SyntheticScene."""

    synthetic = True

    def __init__(self, width: int = 1280, height: int = 720, fps: float = 12.0, square_mm: float = 40.0):
        import cv2

        self._cv2 = cv2
        self.scene = SyntheticScene(square_mm)
        self.width, self.height = int(width), int(height)
        self.fps = fps
        self.controls_set: dict = {}
        self._values = {"auto_exposure": 3.0, "exposure": -5.0, "auto_wb": 1.0, "wb_temperature": 4600.0,
                        "autofocus": 1.0, "focus": 30.0, "gain": 0.0, "brightness": None}
        self._frame = None
        self._lock = threading.Lock()
        self._running = False
        self._thread = None
        self._rng = np.random.default_rng(1)

    @property
    def available(self) -> bool:
        return True

    @property
    def index(self):
        return "synthetic"

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

    def render_now(self):
        vals = {k: v for k, v in self._values.items() if v is not None}
        return render(self.scene, self.width, self.height, vals, self._rng)

    def _loop(self) -> None:
        while self._running:
            frame = self.render_now()
            with self._lock:
                self._frame = frame
            time.sleep(1.0 / self.fps)

    def read(self):
        with self._lock:
            return self._frame

    def controls(self) -> dict:
        return dict(self._values)

    def set_control(self, name: str, value: float) -> bool:
        if name not in self._values or self._values[name] is None:
            return False
        self._values[name] = float(value)
        self.controls_set[name] = float(value)
        return True

    def jpeg(self, frame=None, quality: int = 70):
        if frame is None:
            frame = self.read()
        if frame is None:
            return None
        ok, buf = self._cv2.imencode(".jpg", frame, [self._cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes() if ok else None
