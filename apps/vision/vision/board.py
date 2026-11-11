"""Chessboard detection and the camera->board->robot coordinate mapping.

For an overhead camera we model the board as a plane. A homography maps board
"world" coordinates (x, y in the board plane, mm) to image pixels, and its
inverse maps pixels back to board coordinates. The board origin is expressed in
the robot-base frame via config, so a detected piece becomes a robot target.
"""

import json
import math
import os

import numpy as np

from .config import config


class Board:
    """Maps between board-plane coordinates (mm), pixels and robot targets."""

    def __init__(self):
        self._square = config.BOARD_SQUARE_SIZE
        self._origin = np.array(
            [config.BOARD_ORIGIN_X, config.BOARD_ORIGIN_Y, config.BOARD_ORIGIN_Z],
            dtype=float,
        )
        self._rotation = config.BOARD_ROTATION_DEG
        self._H = None  # world(x,y) -> pixel homography (set by calibration)
        # Lens model (vision.lens). With it, H maps to IDEAL pixels and every
        # raw pixel is converted at the edges; without it, raw = ideal.
        self.lens = None
        self._warp_cache = None
        # Thresholds of /board. A saved wizard calibration overrides the env defaults.
        self.thresholds = default_thresholds()

    # --- calibration --------------------------------------------------------

    def set_homography(self, H: np.ndarray) -> None:
        self._H = H
        self._warp_cache = None

    def set_lens(self, lens) -> None:
        self.lens = lens
        self._warp_cache = None

    def set_pose(self, origin, rotation_deg: float, square: float = None) -> None:
        """Board pose in the twin frame (a1 corner, mm; yaw, deg), from a calibration."""
        self._origin = np.array([float(v) for v in origin], dtype=float)
        self._rotation = float(rotation_deg)
        if square:
            self._square = float(square)

    @property
    def pose(self) -> dict:
        return {"origin": [float(v) for v in self._origin], "rotation_deg": self._rotation, "square": self._square}

    @property
    def homography(self):
        return None if self._H is None else self._H.copy()

    @property
    def calibrated(self) -> bool:
        return self._H is not None

    def save(self, path: str = config.CALIBRATION_FILE) -> None:
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        if _is_wizard_file(path):
            raise RuntimeError(f"{path} is a wizard calibration: recalibrate with the Calibrate wizard")
        with open(path, "w") as f:
            json.dump({"H": self._H.tolist(), "square": self._square}, f)

    def load(self, path: str = config.CALIBRATION_FILE) -> bool:
        if not os.path.exists(path):
            return False
        with open(path) as f:
            data = json.load(f)
        if "schema" in data:  # the wizard format (vision/calib.py)
            data = {"H": data["board"]["homography"], "square": data["board"]["square_mm"]}
        self._H = np.array(data["H"], dtype=float)
        self._square = float(data["square"])
        return self._H is not None

    # --- geometry -----------------------------------------------------------
    #
    # Board-plane coordinates (mm), as fitted by the calibration:
    #   x runs along the files, a -> h, starting at the a-file edge;
    #   y runs along the ranks, 8 -> 1, starting at the rank-8 edge.
    # So marker 0 is the a8 corner, 1 = h8, 2 = a1, 3 = h1 (marker CENTRE on
    # the outer board corner).
    # Squares are reported as names ("e4") and as [rank_index, file_index]
    # with rank_index 0 = rank 1, exactly like @robot/chess.

    @property
    def board_width(self) -> float:
        return 8 * self._square

    @property
    def square_size(self) -> float:
        return self._square

    def corner_points(self) -> dict[int, tuple[float, float]]:
        """Marker-id -> board-plane point (mm) for the 4 corners."""
        w = self.board_width
        return {
            0: (0.0, 0.0),  # a8 corner
            1: (w, 0.0),    # h8 corner
            2: (0.0, w),    # a1 corner
            3: (w, w),      # h1 corner
        }

    def square_board_point(self, rank_idx: int, file_idx: int) -> np.ndarray:
        """Board-plane point (mm) of the centre of a square (rank_idx 0 = rank 1)."""
        return np.array([(file_idx + 0.5) * self._square, (7 - rank_idx + 0.5) * self._square])

    def _rot(self, lx: float, lz: float) -> tuple[float, float]:
        """Rotate a board-plane local offset (files, ranks) about the vertical."""
        t = math.radians(self._rotation)
        c = math.cos(t)
        s = math.sin(t)
        return (lx * c + lz * s, -lx * s + lz * c)

    def _target(self, along_files: float, along_ranks: float) -> list[float]:
        """Robot-frame (twin, mm) target for an offset from the a1 corner.

        Same mapping as @robot/chess boardOffset: files run toward -X, ranks
        toward +Z, the height is the board surface plus the pickup height.
        """
        x, z = self._rot(-along_files, along_ranks)
        return [
            float(self._origin[0] + x),
            float(self._origin[1] + config.BOARD_PICKUP_Z),
            float(self._origin[2] + z),
        ]

    def square_target(self, rank_idx: int, file_idx: int) -> list[float]:
        """Robot-frame target (mm) for the centre of a square (rank_idx 0 = rank 1)."""
        return self._target((file_idx + 0.5) * self._square, (rank_idx + 0.5) * self._square)

    # --- pixel mapping ------------------------------------------------------

    def pixel_of_board(self, xy: np.ndarray) -> np.ndarray:
        """Map a board-plane point (mm) to pixel coords."""
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        p = np.array([xy[0], xy[1], 1.0])
        q = self._H @ p
        q = q[:2] / q[2]
        return self.lens.to_raw(q) if self.lens is not None else q

    def board_of_pixel(self, px: np.ndarray) -> np.ndarray:
        """Map pixel coords to board-plane (x, y) in mm."""
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        P = np.linalg.inv(self._H)
        if self.lens is not None:
            px = self.lens.to_ideal(np.asarray(px, dtype=float))
        p = np.array([px[0], px[1], 1.0])
        q = P @ p
        return q[:2] / q[2]

    def robot_target_of_pixel(self, px: np.ndarray) -> list[float]:
        """Robot-frame target (mm) for a pixel point on the board plane."""
        xy = self.board_of_pixel(px)
        return self._target(float(xy[0]), self.board_width - float(xy[1]))

    # --- top-down view and board state ---------------------------------------

    def topdown(self, frame, px_per_mm: float = None):
        """Warp the camera frame to a top-down image of the board (a8 top-left)."""
        cv2 = _cv2()
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        k = px_per_mm or config.TOPDOWN_PX_PER_MM
        if self.lens is None:
            return plane_warp(frame, self._H, None, k, self.board_width)
        key = (self._H.tobytes(), k, self.board_width, id(self.lens))
        if self._warp_cache is None or self._warp_cache[0] != key:
            self._warp_cache = (key, plane_maps(self._H, self.lens, k, self.board_width))
        self.lens.check_frame(frame)
        mx, my = self._warp_cache[1]
        return cv2.remap(frame, mx, my, cv2.INTER_LINEAR)

    def board_state(self, frame, reference, thresholds: dict = None, details: bool = False) -> dict:
        """Per square: "w", "b" or None, compared with an EMPTY-board reference.

        Both images are camera frames (same camera, same pose). Returns
        {"squares": {"a1": "w"|"b"|None, ...}, "scores": {"a1": occupied_fraction}}
        and, with details=True, "details": {"a1": {frac, grey, confidence}}.
        `thresholds` (diff, occupied_fraction, white) default to self.thresholds.
        """
        cv2 = _cv2()
        th = {**self.thresholds, **(thresholds or {})}
        k = config.TOPDOWN_PX_PER_MM
        top = _grey(self.topdown(frame, k))
        ref = _grey(self.topdown(reference, k))
        diff = cv2.absdiff(top, ref)
        squares, scores, info = {}, {}, {}
        for rank_idx, file_idx, (y0, y1, x0, x1) in self.square_windows(k):
            name = square_name(rank_idx, file_idx)
            changed = diff[y0:y1, x0:x1] > th["diff"]
            frac = float(changed.mean()) if changed.size else 0.0
            scores[name] = round(frac, 3)
            occ_conf = _confidence(frac, th["occupied_fraction"], 0.1)
            if frac < th["occupied_fraction"]:
                squares[name] = None
                info[name] = {"frac": round(frac, 3), "grey": None, "confidence": round(occ_conf, 2)}
                continue
            grey = float(top[y0:y1, x0:x1][changed].mean())
            squares[name] = "w" if grey >= th["white"] else "b"
            conf = min(occ_conf, _confidence(grey, th["white"], 40.0))
            info[name] = {"frac": round(frac, 3), "grey": round(grey, 1), "confidence": round(conf, 2)}
        out = {"squares": squares, "scores": scores}
        if details:
            out["details"] = info
        return out

    def square_windows(self, k: float = None, inset: float = 0.2):
        """(rank_idx, file_idx, (y0, y1, x0, x1)) of the centre window of each square
        in the top-down image (a8 top-left), `inset` of the square on each side."""
        k = k or config.TOPDOWN_PX_PER_MM
        sq = self._square * k
        for rank_idx in range(8):
            for file_idx in range(8):
                row = 7 - rank_idx  # image row 0 = rank 8
                yield rank_idx, file_idx, (
                    int((row + inset) * sq), int((row + 1 - inset) * sq),
                    int((file_idx + inset) * sq), int((file_idx + 1 - inset) * sq),
                )


def plane_maps(H: np.ndarray, lens, k: float, width_mm: float):
    """remap() maps of the top-down view: top-down pixel -> plane -> ideal -> raw pixel."""
    size = int(round(width_mm * k))
    v, u = np.mgrid[0:size, 0:size].astype(float)
    plane = np.stack([u.ravel() / k, v.ravel() / k, np.ones(size * size)])
    q = H @ plane
    ideal = (q[:2] / q[2]).T
    raw = lens.to_raw(ideal)
    return raw[:, 0].reshape(size, size).astype(np.float32), raw[:, 1].reshape(size, size).astype(np.float32)


def plane_warp(frame, H: np.ndarray, lens, k: float, width_mm: float):
    """Top-down image of the board plane (a8 top-left), k px per mm, lens-corrected."""
    cv2 = _cv2()
    size = int(round(width_mm * k))
    if lens is None:
        S = np.array([[k, 0, 0], [0, k, 0], [0, 0, 1]], dtype=float)
        return cv2.warpPerspective(frame, S @ np.linalg.inv(H), (size, size))
    lens.check_frame(frame)
    mx, my = plane_maps(H, lens, k, width_mm)
    return cv2.remap(frame, mx, my, cv2.INTER_LINEAR)


def default_thresholds() -> dict:
    return {
        "diff": float(config.DIFF_THRESHOLD),
        "occupied_fraction": float(config.OCCUPIED_FRACTION),
        "white": float(config.WHITE_THRESHOLD),
    }


def _confidence(value: float, threshold: float, scale: float) -> float:
    """0 at the threshold, 1 at `scale` or more away from it."""
    return float(min(1.0, abs(value - threshold) / scale)) if scale > 0 else 1.0


def _grey(img):
    cv2 = _cv2()
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _is_wizard_file(path: str) -> bool:
    try:
        with open(path) as f:
            return "schema" in json.load(f)
    except (OSError, ValueError):
        return False


def square_name(rank_idx: int, file_idx: int) -> str:
    return "abcdefgh"[file_idx] + str(rank_idx + 1)


def fit_homography(src_world: np.ndarray, dst_pixel: np.ndarray) -> np.ndarray:
    """Solve the 3x3 homography H such that dst ~ H @ src."""
    cv2 = _cv2()
    src = src_world.astype(np.float32).reshape(-1, 1, 2)
    dst = dst_pixel.astype(np.float32).reshape(-1, 1, 2)
    H, _ = cv2.findHomography(src, dst, cv2.RANSAC)
    if H is None:
        raise RuntimeError("Could not fit homography (need >= 4 point pairs)")
    return H


def detect_aruco_marker(frame):
    """Return (corners, ids) for ArUco markers in the frame, or (None, [])."""
    cv2 = _cv2()
    try:
        aruco = cv2.aruco
        dict_id = getattr(cv2.aruco, config.ARUCO_DICT, cv2.aruco.DICT_4X4_50)
    except AttributeError:
        aruco = None
        dict_id = None
    if aruco is None:
        return None, []
    params = (
        cv2.aruco.DetectorParameters_create()
        if hasattr(aruco, "DetectorParameters_create")
        else cv2.aruco.DetectorParameters()
    )
    try:
        detector = cv2.aruco.ArucoDetector(
            cv2.aruco.getPredefinedDictionary(dict_id), params
        )
        corners, ids, _ = detector.detectMarkers(frame)
        if ids is None:
            return None, []
        return corners, ids.flatten().tolist()
    except Exception:
        return None, []


def calibrate_from_markers(frame, board: Board) -> bool:
    """Fit the board homography from up to 4 corner markers. Returns success."""
    corners, ids = detect_aruco_marker(frame)
    if not ids:
        return False
    map_ = board.corner_points()
    src: list = []
    dst: list = []
    for corner, mid in zip(corners, ids):
        if mid not in map_:
            continue
        pts = corner.reshape(-1, 2)
        center = pts.mean(axis=0)
        src.append(map_[mid])
        dst.append(center)
    if len(src) < 4:
        return False
    H = fit_homography(np.array(src), np.array(dst))
    board.set_homography(H)
    return True


def _cv2():
    try:
        import cv2  # noqa: F401

        return cv2
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "OpenCV is not installed. Run: pip install -r requirements.txt"
        ) from exc
