"""Chessboard detection and the camera->board->robot coordinate mapping.

For an overhead camera we model the board as a plane. A homography maps board
"world" coordinates (x, y in the board plane, metres) to image pixels, and its
inverse maps pixels back to board coordinates. The board origin is expressed in
the robot-base frame via config, so a detected piece becomes a robot target.
"""

import json
import math
import os

import numpy as np

from .config import config


class Board:
    """Maps between board coordinates (metres, robot-base frame) and pixels."""

    def __init__(self):
        self._square = config.BOARD_SQUARE_SIZE
        self._origin = np.array(
            [config.BOARD_ORIGIN_X, config.BOARD_ORIGIN_Y, config.BOARD_ORIGIN_Z],
            dtype=float,
        )
        self._H = None  # world(x,y) -> pixel homography (set by calibration)

    # --- calibration --------------------------------------------------------

    def set_homography(self, H: np.ndarray) -> None:
        self._H = H

    @property
    def calibrated(self) -> bool:
        return self._H is not None

    def save(self, path: str = config.CALIBRATION_FILE) -> None:
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        with open(path, "w") as f:
            json.dump({"H": self._H.tolist(), "square": self._square}, f)

    def load(self, path: str = config.CALIBRATION_FILE) -> bool:
        if not os.path.exists(path):
            return False
        with open(path) as f:
            data = json.load(f)
        self._H = np.array(data["H"], dtype=float)
        self._square = float(data["square"])
        return self._H is not None

    # --- geometry -----------------------------------------------------------

    @property
    def board_width(self) -> float:
        return 8 * self._square

    def corner_points(self) -> dict[int, tuple[float, float]]:
        """Marker-id -> world board-plane point (metres) for the 4 corners."""
        w = self.board_width
        return {
            0: (0.0, 0.0),          # a8 corner (bottom-left)
            1: (w, 0.0),            # h8 corner
            2: (0.0, w),            # a1 corner
            3: (w, w),              # h1 corner
        }

    def square_board_point(self, row: int, col: int) -> np.ndarray:
        """Board-plane point (metres, relative to board origin) of a square."""
        return np.array([(col + 0.5) * self._square, (row + 0.5) * self._square])

    def _rot(self, lx: float, lz: float) -> tuple[float, float]:
        """Rotate a board-plane local offset (files, ranks) about the vertical."""
        t = math.radians(config.BOARD_ROTATION_DEG)
        c = math.cos(t)
        s = math.sin(t)
        return (lx * c + lz * s, -lx * s + lz * c)

    def _target(self, lx: float, lz: float) -> list[float]:
        """Robot-frame target (mm) for a board-plane local offset.

        Files run toward -X (a-file at the high-X corner, matching @robot/chess
        BOARD), ranks run toward +Z. The board-plane y in this class is measured
        from the a8 corner, so negate the file axis here.
        """
        x, z = self._rot(lx, lz)
        return [
            float(self._origin[0] + x),
            float(config.BOARD_PICKUP_Z),
            float(self._origin[2] + z),
        ]

    def square_target(self, row: int, col: int) -> list[float]:
        """Robot-frame target (mm) for the centre of square (row, col).

        The model is Y-up, so the board lies in the X-Z plane and the pickup
        height is the Y coordinate.
        """
        p = self.square_board_point(row, col)
        return self._target(-float(p[0]), float(p[1]))

    # --- pixel mapping ------------------------------------------------------

    def pixel_of_board(self, xy: np.ndarray) -> np.ndarray:
        """Map a board-plane point (metres) to pixel coords."""
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        p = np.array([xy[0], xy[1], 1.0])
        q = self._H @ p
        return q[:2] / q[2]

    def board_of_pixel(self, px: np.ndarray) -> np.ndarray:
        """Map pixel coords to board-plane (x, y) in metres."""
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        P = np.linalg.inv(self._H)
        p = np.array([px[0], px[1], 1.0])
        q = P @ p
        return q[:2] / q[2]

    def robot_target_of_pixel(self, px: np.ndarray) -> list[float]:
        """Robot-frame target (mm) for a pixel point on the board plane (Y-up)."""
        xy = self.board_of_pixel(px)
        return self._target(-float(xy[0]), float(xy[1]))


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
