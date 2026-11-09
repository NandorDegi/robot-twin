"""Tiny synthetic board images, to test the capture -> label -> train
pipeline without a camera. Not training data for the real robot."""

from __future__ import annotations

import numpy as np

from vision.board import Board

from .labels import fen_squares


def synthetic_board(width: int = 640, height: int = 480, margin: int = 60) -> Board:
    """A calibrated Board whose homography maps the 8x8 board into the image."""
    b = Board()
    size = 8 * b._square
    scale = (min(width, height) - 2 * margin) / size
    H = np.array([[scale, 0, (width - size * scale) / 2], [0, scale, margin], [0, 0, 1.0]])
    b.set_homography(H)
    return b


def render(fen: str, board: Board, width: int = 640, height: int = 480, seed: int = 0):
    """Draw the board and one disc per piece (white/black, letter on top)."""
    import cv2

    rng = np.random.default_rng(seed)
    img = np.full((height, width, 3), 90, np.uint8)
    s = board._square
    for r in range(8):
        for c in range(8):
            quad = np.array([board.pixel_of_board(np.array(p)) for p in [(c * s, r * s), ((c + 1) * s, r * s), ((c + 1) * s, (r + 1) * s), (c * s, (r + 1) * s)]], np.int32)
            cv2.fillConvexPoly(img, quad, (181, 217, 240) if (r + c) % 2 == 0 else (99, 136, 181))
    for (r, c), ch in fen_squares(fen).items():
        cx, cy = board.pixel_of_board(np.array([(c + 0.5) * s, (r + 0.5) * s]))
        jitter = rng.normal(0, 1.0, 2)
        centre = (int(cx + jitter[0]), int(cy + jitter[1]))
        sq_px = board.pixel_of_board(np.array([s, 0.0]))[0] - board.pixel_of_board(np.array([0.0, 0.0]))[0]
        rad = max(3, int(0.32 * sq_px))
        fill = (235, 235, 235) if ch.isupper() else (25, 25, 25)
        cv2.circle(img, centre, rad, fill, -1)
        cv2.putText(img, ch.upper(), (centre[0] - 6, centre[1] + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
    return img
