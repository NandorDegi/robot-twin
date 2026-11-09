"""Calibrate the board homography from ArUco corner markers.

Usage (from apps/vision):

    .venv/bin/python calibrate.py --camera 0 --out calibration.json

Detects the four corner markers (ids 0..3), fits the homography between the
board plane (metres) and the image, and saves it to `calibration.json`. The
vision server and the twin then use this so a detected piece maps to a
robot-frame target.
"""

import argparse
import sys
import time

from vision.board import Board, calibrate_from_markers
from vision.capture import Camera
from vision.config import config


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", type=int, default=config.CAMERA_INDEX)
    parser.add_argument("--out", default=config.CALIBRATION_FILE)
    parser.add_argument("--attempts", type=int, default=30)
    args = parser.parse_args()

    cam = Camera(args.camera)
    cam.start()
    board = Board()

    print(f"[calibrate] camera {args.camera}; place markers ids 0..3 at the board corners")
    print(f"[calibrate] board size {board.board_width:.3f} m; attempting up to {args.attempts} frames")
    for _ in range(args.attempts):
        frame = cam.read()
        if frame is None:
            time.sleep(0.2)
            continue
        if calibrate_from_markers(frame, board):
            board.save(args.out)
            print(f"[calibrate] OK -> {args.out}")
            print(f"[calibrate] homography:\n{board._H}")
            cam.stop()
            return 0
        time.sleep(0.2)

    print("[calibrate] FAILED: not enough markers in the last 30 frames", file=sys.stderr)
    cam.stop()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
