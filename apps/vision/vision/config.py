"""Runtime configuration for the vision service. All values come from env vars."""

import os


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


class Config:
    HOST = os.environ.get("VISION_HOST", "0.0.0.0")
    PORT = _int("VISION_PORT", 8081)

    # Camera: use 0 for the first USB camera. On the NUC this is a UVC webcam.
    CAMERA_INDEX = _int("VISION_CAMERA_INDEX", 0)
    FRAME_WIDTH = _int("VISION_FRAME_WIDTH", 1280)
    FRAME_HEIGHT = _int("VISION_FRAME_HEIGHT", 720)
    JPEG_QUALITY = _int("VISION_JPEG_QUALITY", 70)
    FPS = _int("VISION_FPS", 30)

    # Board geometry in millimetres, Y-up (matches the robot model and
    # @robot/chess BOARD, so detected pieces map to the targets the arm uses).
    # The board plane is horizontal (X-Z); origin_xyz is the world (robot-base)
    # position of the board's a1 square corner; square_size is one square side.
    BOARD_ORIGIN_X = _float("VISION_BOARD_ORIGIN_X", 530)
    BOARD_ORIGIN_Y = _float("VISION_BOARD_ORIGIN_Y", 0)
    BOARD_ORIGIN_Z = _float("VISION_BOARD_ORIGIN_Z", -160)
    BOARD_SQUARE_SIZE = _float("VISION_BOARD_SQUARE_SIZE", 40)
    # Yaw (degrees) of the board about its vertical (Y) axis; 0 = axis-aligned.
    BOARD_ROTATION_DEG = _float("VISION_BOARD_ROTATION_DEG", 0)
    # Height (mm, Y) above the board at which the gripper picks a piece up.
    BOARD_PICKUP_Z = _float("VISION_BOARD_PICKUP_Z", 45)
    # Where board calibration is saved / loaded.
    CALIBRATION_FILE = os.environ.get("VISION_CALIBRATION_FILE", "calibration.json")

    # ArUco dictionary for calibration.
    ARUCO_DICT = os.environ.get("VISION_ARUCO_DICT", "DICT_4X4_50")
    BASE_MARKER_ID = _int("VISION_BASE_MARKER_ID", 0)

    # Optional YOLO piece detector (only used if the weights file exists).
    YOLO_WEIGHTS = os.environ.get("VISION_YOLO_WEIGHTS", "")
    YOLO_CONFIDENCE = _float("VISION_YOLO_CONFIDENCE", 0.5)
    YOLO_BLACK_CLASSES = tuple(
        int(x) for x in os.environ.get("VISION_YOLO_BLACK_CLASSES", "").split(",") if x
    )


config = Config()
