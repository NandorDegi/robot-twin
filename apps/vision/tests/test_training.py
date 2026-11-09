"""Auto labels and the synthetic capture pipeline (tiny data, no camera)."""

import os

import numpy as np
import pytest

from training.capture_dataset import last_verified_fen, main as capture_main, random_fen
from training.labels import class_id, data_yaml, fen_squares, yolo_labels
from training.synth import synthetic_board
from vision.observe import CLASS_NAMES, observation_from_detections

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def test_class_ids_match_observe_class_names():
    assert CLASS_NAMES[class_id("P")] == "white_pawn"
    assert CLASS_NAMES[class_id("k")] == "black_king"


def test_fen_squares():
    sq = fen_squares(START)
    assert len(sq) == 32
    assert sq[(0, 0)] == "r" and sq[(7, 4)] == "K"


def test_labels_round_trip_through_observe():
    """Labels made from a FEN, read back as detections, give the same FEN."""
    b = synthetic_board()
    w, h = 640, 480
    lines = yolo_labels(START, b, w, h, tilt=0.0)
    assert len(lines) == 32
    dets = []
    for ln in lines:
        c, cx, cy, bw, bh = ln.split()
        cx, cy, bw, bh = float(cx) * w, float(cy) * h, float(bw) * w, float(bh) * h
        assert 0 <= cx <= w and 0 <= cy <= h
        dets.append({"name": CLASS_NAMES[int(c)], "conf": 1.0, "box": [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2]})
    sq = observation_from_detections(dets, b, "t", 0.9)["squares"]
    assert sq["e1"]["type"] == "k" and sq["e1"]["color"] == "w"
    assert sq["d8"]["type"] == "q" and sq["d8"]["color"] == "b"
    assert sum(1 for v in sq.values() if v["color"]) == 32


def test_tilt_grows_boxes_upwards():
    b = synthetic_board()
    flat = yolo_labels("8/8/8/8/4Q3/8/8/8 w - - 0 1", b, 640, 480, tilt=0.0)[0].split()
    tall = yolo_labels("8/8/8/8/4Q3/8/8/8 w - - 0 1", b, 640, 480, tilt=1.0)[0].split()
    assert float(tall[4]) > float(flat[4]) and float(tall[2]) < float(flat[2])


def test_uncalibrated_board_refuses():
    from vision.board import Board

    with pytest.raises(RuntimeError):
        yolo_labels(START, Board(), 640, 480)


def test_last_verified_fen(tmp_path):
    log = tmp_path / "b.jsonl"
    log.write_text(
        '{"verdict":"ok","fenAfter":"A"}\n{"verdict":"mismatch","fenAfter":"B"}\nnot json\n{"verdict":"human-move","fenAfter":"C"}\n{"verdict":"illegal","fenAfter":"D"}\n'
    )
    assert last_verified_fen(str(log)) == "C"


def test_random_fen_is_well_formed():
    import random

    f = random_fen(random.Random(1))
    assert len(fen_squares(f)) >= 4


def test_synthetic_capture_writes_the_layout(tmp_path):
    pytest.importorskip("cv2")
    out = tmp_path / "ds"
    assert capture_main(["--out", str(out), "--synthetic", "6"]) == 0
    imgs = sorted((out / "images" / "train").iterdir()) + sorted((out / "images" / "val").iterdir())
    assert len(imgs) == 6
    labels = list((out / "labels" / "val").iterdir())
    assert len(labels) == 1 and labels[0].read_text().strip()
    assert "names:" in (out / "data.yaml").read_text()
    assert len((out / "meta.jsonl").read_text().splitlines()) == 6
    assert "11: black_king" in data_yaml("/x")
