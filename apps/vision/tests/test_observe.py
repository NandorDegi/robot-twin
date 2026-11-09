"""Per-square observation: square mapping, confidence, conflicts. numpy only."""

import numpy as np

from training.synth import synthetic_board
from vision.observe import observation_from_detections, parse_class, square_name


def centre_box(board, row, col, half=6.0):
    s = board._square
    cx, cy = board.pixel_of_board(np.array([(col + 0.5) * s, (row + 0.5) * s]))
    return [cx - half, cy - half, cx + half, cy + half]


def test_square_names_follow_chess_orientation():
    assert square_name(0, 0) == "a8"
    assert square_name(7, 4) == "e1"


def test_parse_class():
    assert parse_class("white_knight") == ("w", "n")
    assert parse_class("black-king") == ("b", "k")
    assert parse_class("white") == ("w", None)
    assert parse_class("piece") == (None, None)


def test_detections_become_64_squares():
    b = synthetic_board()
    dets = [
        {"name": "white_king", "conf": 0.92, "box": centre_box(b, 7, 4)},  # e1
        {"name": "black_pawn", "conf": 0.81, "box": centre_box(b, 1, 3)},  # d7
        {"name": "white_pawn", "conf": 0.1, "box": centre_box(b, 6, 0)},  # below threshold
        {"name": "black_queen", "conf": 0.9, "box": [-50, -50, -40, -40]},  # off the board
    ]
    obs = observation_from_detections(dets, b, "test", empty_confidence=0.9)
    sq = obs["squares"]
    assert len(sq) == 64
    assert sq["e1"] == {"color": "w", "type": "k", "confidence": 0.92}
    assert sq["d7"] == {"color": "b", "type": "p", "confidence": 0.81}
    assert sq["a2"] == {"color": None, "type": None, "confidence": 0.9}
    assert obs["calibrated"] is True


def test_conflicting_detections_lower_confidence():
    b = synthetic_board()
    dets = [
        {"name": "white_queen", "conf": 0.7, "box": centre_box(b, 7, 3)},
        {"name": "white_king", "conf": 0.5, "box": centre_box(b, 7, 3)},
    ]
    sq = observation_from_detections(dets, b, "test", 0.9)["squares"]["d1"]
    assert sq["type"] == "q"
    assert abs(sq["confidence"] - 0.2) < 1e-9


def test_colour_only_detections():
    b = synthetic_board()
    sq = observation_from_detections([{"name": "black", "conf": 0.5, "box": centre_box(b, 0, 7)}], b, "h", 0.6)["squares"]
    assert sq["h8"] == {"color": "b", "type": None, "confidence": 0.5}


def test_anchor_uses_the_base_of_a_tall_box():
    b = synthetic_board()
    x1, y1, x2, y2 = centre_box(b, 4, 4)  # e4
    tall = [x1, y1 - 3 * (y2 - y1), x2, y2]  # extends up into e5/e6
    assert observation_from_detections([{"name": "white_rook", "conf": 0.9, "box": tall}], b, "t", 0.9, anchor_frac=0.1)["squares"]["e4"]["type"] == "r"
