# Piece-detector dataset and training

The trainable part of perception: a YOLO detector for the 12 piece classes,
fine-tuned on frames from the NUC camera over the real board.

## Dataset layout

```
data/chess/
  data.yaml            # ultralytics dataset file (written by capture_dataset.py)
  images/train/*.jpg   # camera frames (4 of every 5)
  images/val/*.jpg     # every 5th frame
  labels/train/*.txt   # YOLO labels, one line per piece: "cls cx cy w h" (normalised 0..1)
  labels/val/*.txt
  meta.jsonl           # one line per image: image path, FEN, source, homography H, time
```

Class ids (the same list as `vision/observe.py` `CLASS_NAMES`):

| id | class | id | class |
|---|---|---|---|
| 0 | white_pawn | 6 | black_pawn |
| 1 | white_knight | 7 | black_knight |
| 2 | white_bishop | 8 | black_bishop |
| 3 | white_rook | 9 | black_rook |
| 4 | white_queen | 10 | black_queen |
| 5 | white_king | 11 | black_king |

## Labels come from the position, not from hand drawing

`labels.py` turns a known FEN + the board calibration into boxes: each occupied
square's footprint, projected through the homography, grown upwards by a
per-piece height (`--tilt`, 0 for a straight top-down camera). The FEN comes from
`--fen`, or from the brain's JSONL log (`--from-log`): every position the robot
verified becomes a label. Review the labels in a labelling tool before training.

Collect variety: several games, piece positions all over the board, captured
pieces near the board, daylight and lamp light, the arm partly in view. A few
hundred frames is a useful first set.

## Steps

1. Calibrate on the NUC (`calibrate.py`). Keep the camera fixed afterwards.
2. Capture on the NUC (vision service running):
   `python -m training.capture_dataset --out data/chess --fen "<FEN>" --count 20`
   or follow a game with `--from-log ../server/logs/brain.jsonl --every 5`.
3. Copy `data/chess` to a GPU node and train:
   `python training/train_yolo.py --data data/chess/data.yaml --model yolo11n.pt`
4. Copy `runs/chess/pieces/weights/best_openvino_model/` back to the NUC and set
   `VISION_OBSERVE_MODEL` to that directory. Restart the vision service.

Pipeline test without a camera: `python -m training.capture_dataset --out /tmp/s --synthetic 12`.
Synthetic images test the code path only; they are not training data for the robot.

## Export format: OpenVINO (ONNX as fallback)

The NUC has an Intel CPU and iGPU. OpenVINO is Intel's inference runtime and
is the fastest option there; ultralytics loads the exported
`*_openvino_model/` directory directly and can target the iGPU. `train_yolo.py`
also writes `best.onnx` for any other host.

Licence note: ultralytics (YOLO training and runtime) is AGPL-3.0.
