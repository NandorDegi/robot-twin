"""Per-square board observation for the robot's brain loop.

Turns piece detections into a 64-square observation with a confidence per
square: what @robot/brain (VisionObserver) compares with its prediction.

    GET /observe -> {"calibrated", "source", "timestamp", "frame_id",
                     "squares": {"e4": {"color": "w"|"b"|null,
                                        "type": "p".."k"|null,
                                        "confidence": 0..1}, ...}}

`color: null` = empty square. `type: null` with a colour = a piece of unknown
type (the heuristic detector cannot tell types apart).

Square naming follows Board.corner_points(): board-plane x runs along the
files from the a-file, y runs along the ranks from rank 8, so row 0 = rank 8
and col 0 = file a (the same as @robot/chess).

Detector: a fine-tuned YOLO model (training/README.md) when
VISION_OBSERVE_MODEL points to one (.pt, .onnx, or an *_openvino_model/
directory: ultralytics loads all three), else the colour heuristic.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone

import numpy as np

from .board import Board

FILES = "abcdefgh"

# Canonical class list of the chess-piece dataset (training/README.md). The
# index is the YOLO class id. Keep in sync with training/labels.py.
CLASS_NAMES = [
    "white_pawn", "white_knight", "white_bishop", "white_rook", "white_queen", "white_king",
    "black_pawn", "black_knight", "black_bishop", "black_rook", "black_queen", "black_king",
]
_TYPE_OF = {"pawn": "p", "knight": "n", "bishop": "b", "rook": "r", "queen": "q", "king": "k"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


OBSERVE_MODEL = os.environ.get("VISION_OBSERVE_MODEL", "")
# Detections below this confidence are ignored.
MIN_DETECTION_CONF = _env_float("VISION_OBSERVE_MIN_CONF", 0.25)
# Confidence that a square WITHOUT a detection is really empty.
EMPTY_CONF_MODEL = _env_float("VISION_OBSERVE_EMPTY_CONF", 0.9)
EMPTY_CONF_HEURISTIC = 0.6
HEURISTIC_PIECE_CONF = 0.5
# Where in the box the piece touches the board, as a fraction of the box height
# from the bottom. 0.5 = box centre (pure top-down camera); smaller values suit
# a tilted camera, where the top of a tall piece leans into the next square.
ANCHOR_FRAC = _env_float("VISION_OBSERVE_ANCHOR", 0.5)


def square_name(row: int, col: int) -> str:
    return f"{FILES[col]}{8 - row}"


def parse_class(name: str) -> tuple[str | None, str | None]:
    """'white_knight' -> ('w', 'n'); 'black' / 'piece' -> colour or None, type None."""
    n = name.lower().replace("-", "_").replace(" ", "_")
    color = "w" if n.startswith("white") else "b" if n.startswith("black") else None
    ptype = next((t for word, t in _TYPE_OF.items() if word in n), None)
    return color, ptype


def square_of_point(px: tuple[float, float], board: Board) -> tuple[int, int] | None:
    xy = board.board_of_pixel(np.array(px, dtype=float))
    col = int(np.floor(xy[0] / board._square))
    row = int(np.floor(xy[1] / board._square))
    if 0 <= row < 8 and 0 <= col < 8:
        return row, col
    return None


def observation_from_detections(
    detections: list[dict],
    board: Board,
    source: str,
    empty_confidence: float,
    anchor_frac: float = ANCHOR_FRAC,
) -> dict:
    """Build the 64-square observation.

    `detections`: [{"name": "white_knight", "conf": 0.9, "box": [x1, y1, x2, y2]}].
    Two detections on one square: the stronger wins, and its confidence drops
    by the weaker one's (a disagreement is uncertainty).
    """
    best: dict[str, list[tuple[float, str | None, str | None]]] = {}
    for d in detections:
        conf = float(d.get("conf", 0.0))
        if conf < MIN_DETECTION_CONF:
            continue
        x1, y1, x2, y2 = map(float, d["box"])
        anchor = ((x1 + x2) / 2, y2 - anchor_frac * (y2 - y1))
        sq = square_of_point(anchor, board)
        if sq is None:
            continue
        color, ptype = parse_class(str(d.get("name", "")))
        if color is None:
            continue
        best.setdefault(square_name(*sq), []).append((conf, color, ptype))

    squares = {}
    for r in range(8):
        for c in range(8):
            name = square_name(r, c)
            dets = sorted(best.get(name, []), key=lambda x: -x[0])
            if not dets:
                squares[name] = {"color": None, "type": None, "confidence": round(empty_confidence, 3)}
                continue
            conf, color, ptype = dets[0]
            rival = next((x[0] for x in dets[1:] if (x[1], x[2]) != (color, ptype)), 0.0)
            squares[name] = {"color": color, "type": ptype, "confidence": round(max(0.0, conf - rival), 3)}
    return {
        "calibrated": True,
        "source": source,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "squares": squares,
    }


class Observer:
    """Holds the (lazily loaded, cached) detector."""

    def __init__(self, model_path: str = OBSERVE_MODEL):
        self.model_path = model_path
        self._model = None
        self._lock = threading.Lock()
        self._frame_seq = 0

    def _yolo(self):
        if self._model is None:
            from ultralytics import YOLO  # optional dependency (AGPL-3.0)

            self._model = YOLO(self.model_path, task="detect")
        return self._model

    def detect(self, frame) -> tuple[list[dict], str]:
        if self.model_path and os.path.exists(self.model_path):
            try:
                with self._lock:
                    model = self._yolo()
                    res = model(frame, verbose=False)
                dets = []
                for r in res:
                    for b in r.boxes:
                        cls = int(b.cls[0])
                        dets.append({"name": str(model.names[cls]), "conf": float(b.conf[0]), "box": [float(v) for v in b.xyxy[0].tolist()]})
                return dets, "vision:yolo"
            except ImportError:
                pass
        from .pieces import _heuristic_boxes

        dets = []
        for color, _ptype, cx, cy in _heuristic_boxes(frame):
            dets.append({"name": color, "conf": HEURISTIC_PIECE_CONF, "box": [cx - 1, cy - 1, cx + 1, cy + 1]})
        return dets, "vision:heuristic"

    def observe(self, frame, board: Board) -> dict:
        if not board.calibrated:
            return {"calibrated": False, "error": "board not calibrated", "squares": {}}
        dets, source = self.detect(frame)
        empty = EMPTY_CONF_MODEL if source == "vision:yolo" else EMPTY_CONF_HEURISTIC
        obs = observation_from_detections(dets, board, source, empty)
        self._frame_seq += 1
        obs["frame_id"] = f"{int(time.time())}-{self._frame_seq}"
        return obs
