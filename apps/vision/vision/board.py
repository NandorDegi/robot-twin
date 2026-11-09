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
        t = math.radians(config.BOARD_ROTATION_DEG)
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
        return q[:2] / q[2]

    def board_of_pixel(self, px: np.ndarray) -> np.ndarray:
        """Map pixel coords to board-plane (x, y) in mm."""
        if self._H is None:
            raise RuntimeError("Board is not calibrated")
        P = np.linalg.inv(self._H)
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
        S = np.array([[k, 0, 0], [0, k, 0], [0, 0, 1]], dtype=float)
        size = int(round(self.board_width * k))
        return cv2.warpPerspective(frame, S @ np.linalg.inv(self._H), (size, size))

    def board_state(self, frame, reference) -> dict:
        """Per square: "w", "b" or None, compared with an EMPTY-board reference.

        Both images are camera frames (same camera, same pose). Returns
        {"squares": {"a1": "w"|"b"|None, ...}, "scores": {"a1": occupied_fraction}}.
        """
        cv2 = _cv2()
        k = config.TOPDOWN_PX_PER_MM
        top = cv2.cvtColor(self.topdown(frame, k), cv2.COLOR_BGR2GRAY)
        ref = cv2.cvtColor(self.topdown(reference, k), cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(top, ref)
        sq = self._square * k
        squares, scores = {}, {}
        for rank_idx in range(8):
            for file_idx in range(8):
                name = square_name(rank_idx, file_idx)
                row = 7 - rank_idx  # image row 0 = rank 8
                y0, y1 = int((row + 0.2) * sq), int((row + 0.8) * sq)
                x0, x1 = int((file_idx + 0.2) * sq), int((file_idx + 0.8) * sq)
                changed = diff[y0:y1, x0:x1] > config.DIFF_THRESHOLD
                frac = float(changed.mean()) if changed.size else 0.0
                scores[name] = round(frac, 3)
                if frac < config.OCCUPIED_FRACTION:
                    squares[name] = None
                    continue
                grey = float(top[y0:y1, x0:x1][changed].mean())
                squares[name] = "w" if grey >= config.WHITE_THRESHOLD else "b"
        return {"squares": squares, "scores": scores}


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
