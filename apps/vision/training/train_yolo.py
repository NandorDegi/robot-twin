"""Fine-tune a YOLO piece detector and export it for the NUC.

Run on a GPU node (not on the NUC). Needs `pip install ultralytics`
(AGPL-3.0: check the licence before you ship the model in a product).

    python train_yolo.py --data data/chess/data.yaml --model yolo11n.pt --epochs 80
    # -> runs/chess/<name>/weights/best.pt
    #    + best_openvino_model/  (load on the NUC: VISION_OBSERVE_MODEL=.../best_openvino_model)
    #    + best.onnx             (portable fallback, onnxruntime)

Export format for the NUC: OpenVINO IR (FP16 by default, INT8 with --int8).
OpenVINO is Intel's runtime: it runs well on the NUC's Intel CPU and can use
the Intel iGPU (device "intel:gpu"), and ultralytics loads the exported
directory directly. ONNX is exported as well, as a fallback for a non-Intel
host or if OpenVINO is not installed.

`--model` is a COCO-pretrained checkpoint name (downloaded by ultralytics on
first use) or a local .pt. Use the smallest model that is accurate enough
(yolo11n first): the NUC runs it every observation.
"""

from __future__ import annotations

import argparse
import shutil
import sys


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="fine-tune YOLO on the chess-piece dataset")
    ap.add_argument("--data", required=True, help="data.yaml (training/README.md layout)")
    ap.add_argument("--model", default="yolo11n.pt")
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="0", help="GPU index, or 'cpu' (slow; for a pipeline test only)")
    ap.add_argument("--project", default="runs/chess")
    ap.add_argument("--name", default="pieces")
    ap.add_argument("--int8", action="store_true", help="INT8 OpenVINO export (calibrates on --data)")
    ap.add_argument("--no-export", action="store_true")
    a = ap.parse_args(argv)
    try:
        from ultralytics import YOLO
    except ImportError:
        print("ultralytics is not installed: pip install ultralytics", file=sys.stderr)
        return 2

    model = YOLO(a.model)
    # Chess pieces: no left-right flip (it swaps the board files and the labels' meaning),
    # mild colour jitter for lighting, no mosaic in the last epochs.
    model.train(
        data=a.data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, device=a.device,
        project=a.project, name=a.name, exist_ok=True, fliplr=0.0, hsv_v=0.3, close_mosaic=10,
    )
    best = f"{a.project}/{a.name}/weights/best.pt"
    metrics = YOLO(best).val(data=a.data, imgsz=a.imgsz, device=a.device)
    print(f"val mAP50-95={metrics.box.map:.3f} mAP50={metrics.box.map50:.3f}")
    if a.no_export:
        return 0
    trained = YOLO(best)
    ov = trained.export(format="openvino", imgsz=a.imgsz, half=not a.int8, int8=a.int8, data=a.data if a.int8 else None)
    onnx = YOLO(best).export(format="onnx", imgsz=a.imgsz, simplify=True)
    print(f"exported: {ov}\nexported: {onnx}")
    print("copy to the NUC and set VISION_OBSERVE_MODEL to the *_openvino_model directory")
    shutil.copy(a.data, f"{a.project}/{a.name}/data.yaml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
