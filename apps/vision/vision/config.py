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
    # Loopback by default: Caddy serves /vision to the LAN, and the robot
    # server reads /board locally.
    HOST = os.environ.get("VISION_HOST", "127.0.0.1")
    PORT = _int("VISION_PORT", 8081)

    # Camera: use 0 for the first USB camera. On the NUC this is a UVC webcam.
    CAMERA_INDEX = _int("VISION_CAMERA_INDEX", 0)
    FRAME_WIDTH = _int("VISION_FRAME_WIDTH", 1280)
    FRAME_HEIGHT = _int("VISION_FRAME_HEIGHT", 720)
    JPEG_QUALITY = _int("VISION_JPEG_QUALITY", 70)
    FPS = _int("VISION_FPS", 30)

    # Board geometry in millimetres, twin frame (Y-up), the same values as
    # @robot/chess BOARD. ORIGIN is the a1 corner of the board; files a..h run
    # toward -X, ranks 1..8 toward +Z. Set them from
    # `pnpm --filter server calibrate --from-robot X Y Z`.
    BOARD_ORIGIN_X = _float("VISION_BOARD_ORIGIN_X", 600)
    BOARD_ORIGIN_Y = _float("VISION_BOARD_ORIGIN_Y", 0)
    BOARD_ORIGIN_Z = _float("VISION_BOARD_ORIGIN_Z", -160)
    BOARD_SQUARE_SIZE = _float("VISION_BOARD_SQUARE_SIZE", 40)
    # Yaw (degrees) of the board about its vertical (Y) axis; 0 = axis-aligned.
    BOARD_ROTATION_DEG = _float("VISION_BOARD_ROTATION_DEG", 0)
    # Height (mm, Y) above the board surface at which the gripper picks a piece up.
    BOARD_PICKUP_Z = _float("VISION_BOARD_PICKUP_Z", 45)
    # Where board calibration is saved / loaded.
    CALIBRATION_FILE = os.environ.get("VISION_CALIBRATION_FILE", "calibration.json")
    # Image of the EMPTY board (no pieces), taken with POST /reference after
    # the homography calibration. /board compares each square with it.
    REFERENCE_FILE = os.environ.get("VISION_REFERENCE_FILE", "reference.png")
    # /board tuning (check them on the real board and light, see NUC-BRINGUP).
    TOPDOWN_PX_PER_MM = _float("VISION_TOPDOWN_PX_PER_MM", 2.0)
    DIFF_THRESHOLD = _int("VISION_DIFF_THRESHOLD", 40)        # grey levels
    OCCUPIED_FRACTION = _float("VISION_OCCUPIED_FRACTION", 0.12)  # of the square centre
    WHITE_THRESHOLD = _int("VISION_WHITE_THRESHOLD", 128)     # mean grey of a piece

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
