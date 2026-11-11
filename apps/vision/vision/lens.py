"""Lens distortion: the camera model, its calibration from a printed
checkerboard, and the mapping between raw and ideal pixels.

A cheap or wide-angle webcam bends straight lines (barrel distortion), most at
the image edges. One homography cannot follow a bent board, so the edge files
and ranks are read from the wrong place. With a lens model the vision service
works in two pixel spaces:

  raw pixels    what the camera delivers (the stream, YOLO boxes, clicks)
  ideal pixels  the same camera without distortion (pinhole, same K)

The board homography maps the board plane to IDEAL pixels. `Board` converts
at the edges (vision.board), so the stream and every detector stay raw.

Model: OpenCV pinhole + 5 coefficients (k1, k2, p1, p2, k3). The conversion
is done here in numpy, so it is the same on OpenCV 4.8 and 5.
"""

import datetime as _dt
import math

import numpy as np

MODEL = "opencv-pinhole-5"
MIN_VIEWS = 8
GOOD_VIEWS = 15
MAX_VIEWS = 40
# A fit worse than this (RMS reprojection error, px) is refused.
MAX_RMS_PX = 1.5


def _cv2():
    import cv2

    return cv2


class Lens:
    """Camera matrix K and distortion for one camera at one resolution."""

    def __init__(self, K, dist, size, info: dict = None):
        self.K = np.asarray(K, dtype=float).reshape(3, 3)
        d = np.zeros(5)
        src = np.asarray(dist, dtype=float).ravel()[:5]
        d[: len(src)] = src
        self.dist = d
        self.size = (int(size[0]), int(size[1]))
        self.info = dict(info or {})
        self._Kinv = np.linalg.inv(self.K)

    # --- point mapping ---------------------------------------------------------

    def _distort_norm(self, x, y):
        k1, k2, p1, p2, k3 = self.dist
        r2 = x * x + y * y
        radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
        xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        return xd, yd

    def to_raw(self, pts) -> np.ndarray:
        """Ideal pixels -> raw (distorted) pixels. pts: (N, 2) or (2,)."""
        p = np.asarray(pts, dtype=float)
        one = p.ndim == 1
        p = p.reshape(-1, 2)
        fx, fy, cx, cy = self.K[0, 0], self.K[1, 1], self.K[0, 2], self.K[1, 2]
        x, y = (p[:, 0] - cx) / fx, (p[:, 1] - cy) / fy
        xd, yd = self._distort_norm(x, y)
        out = np.stack([xd * fx + cx, yd * fy + cy], axis=1)
        return out[0] if one else out

    def to_ideal(self, pts, iterations: int = 30) -> np.ndarray:
        """Raw pixels -> ideal pixels (fixed-point inversion of the model)."""
        p = np.asarray(pts, dtype=float)
        one = p.ndim == 1
        p = p.reshape(-1, 2)
        fx, fy, cx, cy = self.K[0, 0], self.K[1, 1], self.K[0, 2], self.K[1, 2]
        xd, yd = (p[:, 0] - cx) / fx, (p[:, 1] - cy) / fy
        k1, k2, p1, p2, k3 = self.dist
        x, y = xd.copy(), yd.copy()
        for _ in range(iterations):
            r2 = x * x + y * y
            radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
            dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
            dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
            x = (xd - dx) / radial
            y = (yd - dy) / radial
        out = np.stack([x * fx + cx, y * fy + cy], axis=1)
        return out[0] if one else out

    # --- images ------------------------------------------------------------------

    def check_frame(self, frame) -> None:
        h, w = frame.shape[:2]
        if (w, h) != self.size:
            raise ValueError(f"the lens model is for {self.size[0]}x{self.size[1]}, the frame is {w}x{h}: "
                             "calibrate the lens again for this resolution")

    def undistort_image(self, frame, alpha: float = 0.5):
        """A straightened copy of a raw frame (preview only; the service never needs it)."""
        cv2 = _cv2()
        self.check_frame(frame)
        newK, _ = cv2.getOptimalNewCameraMatrix(self.K, self.dist, self.size, alpha, self.size)
        m1, m2 = cv2.initUndistortRectifyMap(self.K, self.dist, None, newK, self.size, cv2.CV_32FC1)
        return cv2.remap(frame, m1, m2, cv2.INTER_LINEAR)

    def max_shift_px(self) -> float:
        """How far the model moves a pixel, worst case on the image border."""
        w, h = self.size
        t = np.linspace(0, 1, 33)
        border = np.concatenate([
            np.stack([t * (w - 1), np.zeros_like(t)], 1), np.stack([t * (w - 1), np.full_like(t, h - 1)], 1),
            np.stack([np.zeros_like(t), t * (h - 1)], 1), np.stack([np.full_like(t, w - 1), t * (h - 1)], 1),
        ])
        return float(np.linalg.norm(self.to_ideal(border) - border, axis=1).max())

    def monotonic(self) -> bool:
        """False when the model folds over inside the frame (an over-fitted k2/k3)."""
        w, h = self.size
        c = np.array([self.K[0, 2], self.K[1, 2]])
        for corner in ([0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]):
            line = c + np.linspace(0, 1, 64)[:, None] * (np.array(corner, float) - c)
            r = np.linalg.norm(self.to_ideal(line) - c, axis=1)
            if np.any(np.diff(r) <= 0):
                return False
            back = self.to_raw(self.to_ideal(line))
            if np.abs(back - line).max() > 0.05:
                return False
        return True

    # --- file form --------------------------------------------------------------------

    def as_dict(self) -> dict:
        w, h = self.size
        fx, fy = self.K[0, 0], self.K[1, 1]
        return {
            "model": MODEL,
            "width": w,
            "height": h,
            "K": self.K.round(4).tolist(),
            "dist": [round(float(v), 7) for v in self.dist],
            "fov_deg": [round(math.degrees(2 * math.atan(w / (2 * fx))), 1), round(math.degrees(2 * math.atan(h / (2 * fy))), 1)],
            "max_shift_px": round(self.max_shift_px(), 1),
            **self.info,
        }

    @classmethod
    def from_dict(cls, d):
        """A Lens from the calibration file's camera.intrinsics, or None."""
        if not isinstance(d, dict) or d.get("model") != MODEL:
            return None
        info = {k: v for k, v in d.items() if k not in ("model", "width", "height", "K", "dist", "fov_deg", "max_shift_px")}
        return cls(d["K"], d["dist"], (d["width"], d["height"]), info)


# --- the checkerboard --------------------------------------------------------------


def find_pattern(frame, cols: int, rows: int):
    """Inner corners (N, 2 raw px, row by row) of a printed checkerboard, or None."""
    cv2 = _cv2()
    grey = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    flags = cv2.CALIB_CB_NORMALIZE_IMAGE | getattr(cv2, "CALIB_CB_ACCURACY", 0)
    found, pts = cv2.findChessboardCornersSB(grey, (cols, rows), flags)
    if not found or pts is None:
        return None
    return pts.reshape(-1, 2).astype(float)


def object_points(cols: int, rows: int, square_mm: float) -> np.ndarray:
    return np.array([(c * square_mm, r * square_mm, 0.0) for r in range(rows) for c in range(cols)], np.float32)


def coverage(views, size, cells=(4, 3)) -> dict:
    """Which cells of the image the pattern corners have covered (the edges matter most)."""
    w, h = size
    nx, ny = cells
    hit = np.zeros((ny, nx), bool)
    for v in views:
        p = np.asarray(v, float)
        ix = np.clip((p[:, 0] / w * nx).astype(int), 0, nx - 1)
        iy = np.clip((p[:, 1] / h * ny).astype(int), 0, ny - 1)
        hit[iy, ix] = True
    return {"cells": [nx, ny], "hit": hit.astype(int).tolist(), "fraction": round(float(hit.mean()), 2)}


def similar(view, views, size, tol: float = 0.02) -> bool:
    """True when `view` is almost the same as one already captured."""
    diag = math.hypot(*size)
    p = np.asarray(view, float)
    return any(np.linalg.norm(np.asarray(v, float) - p, axis=1).mean() < tol * diag for v in views)


def solve(views, size, cols: int, rows: int, square_mm: float) -> dict:
    """Fit K and the distortion from the captured views.

    Views whose error is far above the others (motion blur, a bent sheet) are
    dropped once, and the fit is repeated. k3 is fitted only with enough views,
    because a free k3 over-fits a few views and folds the image edges.
    Returns {lens, rms_px, per_view_px, dropped, warnings}.
    """
    cv2 = _cv2()
    if len(views) < MIN_VIEWS:
        raise ValueError(f"capture at least {MIN_VIEWS} views of the sheet ({len(views)} so far)")
    obj = object_points(cols, rows, square_mm)

    def fit(vs):
        flags = 0 if len(vs) >= GOOD_VIEWS else cv2.CALIB_FIX_K3
        ip = [np.asarray(v, np.float32).reshape(-1, 1, 2) for v in vs]
        rms, K, dist, rvecs, tvecs = cv2.calibrateCamera([obj] * len(vs), ip, size, None, None, flags=flags)
        errs = []
        for v, rv, tv in zip(ip, rvecs, tvecs):
            proj, _ = cv2.projectPoints(obj, rv, tv, K, dist)
            errs.append(float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - v.reshape(-1, 2)) ** 2, axis=1)))))
        return float(rms), K, dist, errs

    idx = list(range(len(views)))
    rms, K, dist, errs = fit(views)
    med = float(np.median(errs))
    bad = [i for i, e in zip(idx, errs) if e > max(1.0, 3.0 * med)]
    if bad and len(views) - len(bad) >= MIN_VIEWS:
        idx = [i for i in idx if i not in bad]
        rms, K, dist, errs = fit([views[i] for i in idx])
    else:
        bad = []
    warnings = []
    if rms > MAX_RMS_PX:
        raise ValueError(f"the fit is poor (RMS {rms:.2f} px): hold the sheet flat and still, check the pattern size, "
                         "and capture the views again")
    lens = Lens(K, dist.ravel(), size, {
        "rms_px": round(rms, 3),
        "views": len(idx),
        "pattern": {"cols": cols, "rows": rows, "square_mm": square_mm},
        "created": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat(),
    })
    if not lens.monotonic():
        raise ValueError("the fit folds over at the image edges (too few views near the edges): "
                         "capture more views with the sheet in the corners, then solve again")
    cov = coverage([views[i] for i in idx], size)
    if cov["fraction"] < 0.75:
        warnings.append("the views do not cover the image edges well: the distortion is strongest there, "
                        "add views with the sheet near each corner and edge")
    if rms > 0.6:
        warnings.append(f"RMS {rms:.2f} px is high for a webcam (good: below 0.5): check that the sheet is flat")
    if len(idx) < GOOD_VIEWS:
        warnings.append(f"{len(idx)} views: {GOOD_VIEWS} or more give a better model (k3 is then fitted too)")
    return {"lens": lens, "rms_px": round(rms, 3), "per_view_px": [round(e, 3) for e in errs],
            "used": idx, "dropped": bad, "coverage": cov, "warnings": warnings}


def pattern_svg(cols: int, rows: int, square_mm: float) -> str:
    """A printable checkerboard with cols x rows INNER corners (print at 100 %)."""
    nx, ny = cols + 1, rows + 1
    m = 12.0
    w, h = nx * square_mm + 2 * m, ny * square_mm + 2 * m + 8
    rects = []
    for r in range(ny):
        for c in range(nx):
            if (r + c) % 2 == 0:
                rects.append(f'<rect x="{m + c * square_mm:.2f}" y="{m + r * square_mm:.2f}" '
                             f'width="{square_mm:.2f}" height="{square_mm:.2f}"/>')
    label = (f"robot-twin lens pattern: {cols} x {rows} inner corners, {square_mm:g} mm squares. "
             "Print at 100 % (no scaling), glue flat on card.")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.1f}mm" height="{h:.1f}mm" viewBox="0 0 {w:.2f} {h:.2f}">'
            f'<rect width="100%" height="100%" fill="#fff"/><g fill="#000">{"".join(rects)}</g>'
            f'<text x="{m}" y="{h - 4}" font-family="sans-serif" font-size="3.2">{label}</text></svg>')
