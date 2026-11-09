"""Vision tests with synthetic images (no camera needed)."""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
cv2 = pytest.importorskip("cv2")

from vision.board import Board, square_name  # noqa: E402
from vision.pieces import square_of_pixel  # noqa: E402

PX = 2.0  # pixels per mm in the synthetic camera
OFF = 40  # pixel offset of the a8 corner


def make_board() -> Board:
    b = Board()
    # Synthetic camera: pixel = OFF + PX * board-plane mm (a8 corner top-left).
    H = np.array([[PX, 0, OFF], [0, PX, OFF], [0, 0, 1]], dtype=float)
    b.set_homography(H)
    return b


def empty_image(b: Board) -> np.ndarray:
    size = int(OFF * 2 + b.board_width * PX)
    img = np.full((size, size, 3), 30, np.uint8)
    sq = b.square_size * PX
    for r in range(8):
        for f in range(8):
            light = (r + f) % 2 == 0  # a8 is light
            c = 190 if light else 90
            y0, x0 = int(OFF + r * sq), int(OFF + f * sq)
            img[y0:int(y0 + sq), x0:int(x0 + sq)] = c
    return img


def put_piece(img, b: Board, name: str, grey: int):
    f = "abcdefgh".index(name[0])
    rank_idx = int(name[1]) - 1
    cx, cy = b.pixel_of_board(b.square_board_point(rank_idx, f))
    cv2.circle(img, (int(cx), int(cy)), int(b.square_size * PX * 0.3), (grey, grey, grey), -1)


def test_square_mapping_matches_chess_convention():
    b = make_board()
    # Centre of a1 is at the bottom-left of the image (a8 is top-left).
    px = b.pixel_of_board(b.square_board_point(0, 0))
    assert square_of_pixel(px, b) == [0, 0]
    assert square_name(0, 0) == "a1"
    px = b.pixel_of_board(b.square_board_point(7, 4))
    assert square_name(*square_of_pixel(px, b)) == "e8"


def test_targets_match_robot_chess_board():
    # @robot/chess squareToTarget("e4") with origin [600, 0, -160], 40 mm squares,
    # grab height 45 -> [420, 45, -20]; a1 -> [580, 45, -140].
    b = make_board()
    assert b.square_target(3, 4) == pytest.approx([420, 45, -20])
    assert b.square_target(0, 0) == pytest.approx([580, 45, -140])
    # The pixel path gives the same target.
    px = b.pixel_of_board(b.square_board_point(3, 4))
    assert b.robot_target_of_pixel(px) == pytest.approx([420, 45, -20])


def test_board_state_occupancy_and_colour():
    b = make_board()
    ref = empty_image(b)
    frame = ref.copy()
    put_piece(frame, b, "e4", 245)   # white piece on a light square
    put_piece(frame, b, "d5", 245)   # white piece on a light square
    put_piece(frame, b, "e5", 15)    # black piece on a dark square
    put_piece(frame, b, "a1", 245)   # white piece on a dark square
    st = b.board_state(frame, ref)["squares"]
    assert len(st) == 64
    assert st["e4"] == "w"
    assert st["d5"] == "w"
    assert st["e5"] == "b"
    assert st["a1"] == "w"
    assert sum(1 for v in st.values() if v) == 4


def test_empty_board_is_empty():
    b = make_board()
    ref = empty_image(b)
    noisy = np.clip(ref.astype(int) + np.random.default_rng(0).integers(-10, 10, ref.shape), 0, 255).astype(np.uint8)
    assert all(v is None for v in b.board_state(noisy, ref)["squares"].values())
