"""Run piece detection on a static image.

Usage (from apps/vision):

    .venv/bin/python detect_image.py board.jpg

Prints the detected pieces as JSON (with board square and robot-frame target).
Useful for tuning the detector without a live camera.
"""

import argparse
import json

import cv2

from vision.board import Board
from vision.pieces import detect_pieces


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    args = parser.parse_args()

    frame = cv2.imread(args.image)
    if frame is None:
        print(f"could not read image: {args.image}", file=__import__("sys").stderr)
        return 1

    board = Board()
    loaded = board.load()
    pieces = detect_pieces(frame, board)
    print(json.dumps({"board_calibrated": loaded, "pieces": pieces}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
