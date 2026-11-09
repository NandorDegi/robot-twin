"""Capture camera frames + automatic YOLO labels for piece-detector fine-tuning.

Run from apps/vision. The board must be calibrated (calibration.json).

    # One frame of a known position, from the running vision service:
    python -m training.capture_dataset --out data/chess --url http://127.0.0.1:8081 \
        --fen "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"

    # Follow a game: label each frame with the last VERIFIED position from the
    # brain's JSONL log (the robot's own self-checked positions become labels):
    python -m training.capture_dataset --out data/chess --url http://127.0.0.1:8081 \
        --from-log ../server/logs/brain.jsonl --every 5

    # Pipeline test without a camera (tiny synthetic images):
    python -m training.capture_dataset --out /tmp/chess-synth --synthetic 12

Writes the layout in training/README.md. Every 5th image goes to val/.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.request

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from vision.board import Board  # noqa: E402

from training.labels import data_yaml, yolo_labels  # noqa: E402

VERIFIED = {"ok", "human-move", "resolved"}


def last_verified_fen(log_path: str) -> str | None:
    """fenAfter of the newest cycle whose board the robot verified."""
    fen = None
    with open(log_path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("verdict") in VERIFIED and rec.get("fenAfter"):
                fen = rec["fenAfter"]
    return fen


def fetch_frame(url: str):
    import cv2

    with urllib.request.urlopen(f"{url.rstrip('/')}/frame.jpg", timeout=5) as r:
        buf = np.frombuffer(r.read(), np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("could not decode frame")
    return img


def ensure_layout(out: str) -> None:
    for split in ("train", "val"):
        os.makedirs(os.path.join(out, "images", split), exist_ok=True)
        os.makedirs(os.path.join(out, "labels", split), exist_ok=True)
    with open(os.path.join(out, "data.yaml"), "w") as f:
        f.write(data_yaml(os.path.abspath(out)))


def save_sample(out: str, idx: int, img, fen: str, board: Board, tilt: float, source: str) -> str:
    import cv2

    split = "val" if idx % 5 == 4 else "train"
    name = f"{time.strftime('%Y%m%d-%H%M%S')}-{idx:05d}"
    h, w = img.shape[:2]
    cv2.imwrite(os.path.join(out, "images", split, name + ".jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    with open(os.path.join(out, "labels", split, name + ".txt"), "w") as f:
        f.write("\n".join(yolo_labels(fen, board, w, h, tilt)) + "\n")
    with open(os.path.join(out, "meta.jsonl"), "a") as f:
        f.write(json.dumps({"image": f"images/{split}/{name}.jpg", "fen": fen, "source": source, "H": board._H.tolist(), "ts": time.time()}) + "\n")
    return f"{split}/{name}"


def random_fen(rng: random.Random) -> str:
    """A random placement (not necessarily legal chess): fine for detector data."""
    pieces = list("KQRRBBNNPPPPPPPPkqrrbbnnpppppppp")
    rng.shuffle(pieces)
    pieces = pieces[: rng.randint(4, 32)]
    cells = ["."] * 64
    for p, i in zip(pieces, rng.sample(range(64), len(pieces))):
        cells[i] = p
    rows = []
    for r in range(8):
        s, e = "", 0
        for ch in cells[r * 8:(r + 1) * 8]:
            if ch == ".":
                e += 1
            else:
                s += (str(e) if e else "") + ch
                e = 0
        rows.append(s + (str(e) if e else ""))
    return "/".join(rows) + " w - - 0 1"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="capture frames + auto labels")
    ap.add_argument("--out", required=True)
    ap.add_argument("--url", default=os.environ.get("VISION_URL", "http://127.0.0.1:8081"), help="vision service (uses /frame.jpg)")
    ap.add_argument("--calibration", default=os.environ.get("VISION_CALIBRATION_FILE", "calibration.json"))
    ap.add_argument("--fen", help="label every frame with this position")
    ap.add_argument("--from-log", help="label with the last verified position in this brain JSONL log")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--every", type=float, default=0, help="seconds between frames (0 = press Enter for each)")
    ap.add_argument("--tilt", type=float, default=float(os.environ.get("VISION_LABEL_TILT", "1.0")))
    ap.add_argument("--synthetic", type=int, default=0, help="write N synthetic images instead (no camera)")
    a = ap.parse_args(argv)

    ensure_layout(a.out)
    if a.synthetic:
        from training.synth import render, synthetic_board

        board = synthetic_board()
        rng = random.Random(0)
        for i in range(a.synthetic):
            fen = random_fen(rng)
            print(save_sample(a.out, i, render(fen, board, seed=i), fen, board, tilt=0.0, source="synthetic"))
        return 0

    board = Board()
    if not board.load(a.calibration):
        print(f"no calibration at {a.calibration}: run calibrate.py first", file=sys.stderr)
        return 2
    if not a.fen and not a.from_log:
        print("give --fen or --from-log", file=sys.stderr)
        return 2
    for i in range(a.count):
        if a.every > 0:
            if i:
                time.sleep(a.every)
        else:
            input(f"[{i + 1}/{a.count}] arrange the board, keep hands out of view, press Enter ")
        fen = a.fen or last_verified_fen(a.from_log)
        if not fen:
            print("no verified position in the log yet; skipping", file=sys.stderr)
            continue
        print(save_sample(a.out, i, fetch_frame(a.url), fen, board, a.tilt, source="camera"), fen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
