"""Piece detection.

Uses a YOLO detector when one is available (ultralytics + a weights file),
otherwise falls back to a colour/connected-components heuristic. Detection
maps each piece to a board square and a robot-frame target.
"""

import os

import numpy as np

from .board import Board
from .config import config


def detect_pieces(frame, board: Board) -> list[dict]:
    """Detect chess pieces from a frame.

    Returns a list of dicts:
        {color, type, x, y, square: [row, col], target: [x, y, z]}
    where `target` is the robot-frame pickup position in metres.
    """
    boxes = _detect_boxes(frame)
    pieces = []
    for box in boxes:
        color, ptype, cx, cy = box
        square = square_of_pixel(np.array([cx, cy]), board)
        target = board.square_target(*square) if square is not None else None
        pieces.append(
            {
                "color": color,
                "type": ptype,
                "x": float(cx),
                "y": float(cy),
                "square": square,
                "target": target,
            }
        )
    return pieces


def square_of_pixel(px: np.ndarray, board: Board):
    """Map a pixel to a board square [row, col], or None if not calibrated."""
    if not board.calibrated:
        return None
    try:
        xy = board.board_of_pixel(px)
    except RuntimeError:
        return None
    col = int(xy[0] // board._square)
    row = int(xy[1] // board._square)
    if not (0 <= row < 8 and 0 <= col < 8):
        return None
    return [row, col]


# --- detection backends ------------------------------------------------------

def _detect_boxes(frame):
    """Return a list of (color, type, cx, cy). Uses YOLO if available."""
    try:
        return _yolo_boxes(frame)
    except (ImportError, FileNotFoundError, RuntimeError):
        return _heuristic_boxes(frame)


def _yolo_boxes(frame):
    import cv2

    ultralytics = _optional("ultralytics")
    weights = config.YOLO_WEIGHTS
    if ultralytics is None or not weights or not os.path.exists(weights):
        raise FileNotFoundError("no YOLO weights configured")

    model = ultralytics.YOLO(weights)
    results = model(frame, verbose=False)
    boxes = []
    for r in results:
        for b in r.boxes:
            x1, y1, x2, y2 = map(float, b.xyxy[0].tolist())
            cls = int(b.cls[0])
            conf = float(b.conf[0])
            if conf < config.YOLO_CONFIDENCE:
                continue
            name = model.names[cls]
            color = "black" if cls in config.YOLO_BLACK_CLASSES else "white"
            boxes.append((color, name, (x1 + x2) / 2, (y1 + y2) / 2))
    return boxes


def _heuristic_boxes(frame):
    import cv2

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    boxes = []
    for mask, color in ((gray > 150, "white"), (gray < 80, "black")):
        n, labels, stats, centroids = cv2.connectedComponentsWithStats(
            mask.astype(np.uint8), 8
        )
        for i in range(1, n):
            area = stats[i, cv2.CC_STAT_AREA]
            if area < 40 or area > 6000:
                continue
            w = stats[i, cv2.CC_STAT_WIDTH]
            h = stats[i, cv2.CC_STAT_HEIGHT]
            if w < 6 or h < 6:
                continue
            cx, cy = centroids[i]
            boxes.append((color, "piece", cx, cy))
    return boxes


def _optional(mod):
    try:
        return __import__(mod)
    except ImportError:
        return None


def _cv2():
    try:
        import cv2  # noqa: F401

        return cv2
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "OpenCV is not installed. Run: pip install -r requirements.txt"
        ) from exc
