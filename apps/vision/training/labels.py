"""Automatic YOLO labels from a known position + the board calibration.

When the robot (or a person) knows the position (FEN) and the board is
calibrated, each occupied square gives one bounding box: no hand labelling.
The box is the square's footprint, projected through the homography, grown
"up" in the image by a per-piece height factor (pieces are taller than wide;
with a tilted camera they extend into the square behind).

These are STARTING labels. Review them in a labelling tool (for example CVAT
or Label Studio) before training: a wrong FEN gives wrong labels.
"""

from __future__ import annotations

import numpy as np

from vision.board import Board
from vision.observe import CLASS_NAMES

_NAME = {"p": "pawn", "n": "knight", "b": "bishop", "r": "rook", "q": "queen", "k": "king"}
# Visible height of each piece type in square units, as seen by the camera
# (0 for a pure top-down view). Tune with VISION_LABEL_TILT (multiplier).
HEIGHT = {"p": 0.6, "n": 0.8, "b": 0.9, "r": 0.7, "q": 1.0, "k": 1.1}


def class_id(piece_char: str) -> int:
    color = "white" if piece_char.isupper() else "black"
    return CLASS_NAMES.index(f"{color}_{_NAME[piece_char.lower()]}")


def fen_squares(fen: str) -> dict[tuple[int, int], str]:
    """(row, col) -> FEN piece char; row 0 = rank 8, col 0 = file a."""
    out = {}
    for r, rank in enumerate(fen.split()[0].split("/")):
        c = 0
        for ch in rank:
            if ch.isdigit():
                c += int(ch)
            else:
                out[(r, c)] = ch
                c += 1
    if len(fen.split()[0].split("/")) != 8:
        raise ValueError(f"bad FEN: {fen}")
    return out


def square_box(board: Board, row: int, col: int, shrink: float = 0.8) -> np.ndarray:
    """Pixel bounding box [x1, y1, x2, y2] of a square's (shrunken) footprint."""
    s = board._square
    m = (1 - shrink) / 2 * s
    corners = [
        (col * s + m, row * s + m),
        ((col + 1) * s - m, row * s + m),
        (col * s + m, (row + 1) * s - m),
        ((col + 1) * s - m, (row + 1) * s - m),
    ]
    px = np.array([board.pixel_of_board(np.array(p)) for p in corners])
    return np.array([px[:, 0].min(), px[:, 1].min(), px[:, 0].max(), px[:, 1].max()])


def yolo_labels(fen: str, board: Board, width: int, height: int, tilt: float = 1.0) -> list[str]:
    """YOLO label lines `cls cx cy w h` (normalised) for every piece in `fen`."""
    if not board.calibrated:
        raise RuntimeError("board not calibrated: run calibrate.py first")
    lines = []
    for (r, c), ch in sorted(fen_squares(fen).items()):
        x1, y1, x2, y2 = square_box(board, r, c)
        y1 -= tilt * HEIGHT[ch.lower()] * (y2 - y1)  # grow upwards in the image
        x1, x2 = np.clip([x1, x2], 0, width - 1)
        y1, y2 = np.clip([y1, y2], 0, height - 1)
        if x2 - x1 < 2 or y2 - y1 < 2:
            continue  # outside the frame
        cx, cy = (x1 + x2) / 2 / width, (y1 + y2) / 2 / height
        lines.append(f"{class_id(ch)} {cx:.6f} {cy:.6f} {(x2 - x1) / width:.6f} {(y2 - y1) / height:.6f}")
    return lines


def data_yaml(root: str) -> str:
    """Ultralytics dataset description for the layout in training/README.md."""
    names = "\n".join(f"  {i}: {n}" for i, n in enumerate(CLASS_NAMES))
    return f"path: {root}\ntrain: images/train\nval: images/val\nnames:\n{names}\n"
