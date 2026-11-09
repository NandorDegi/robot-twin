"""HTTP endpoints of the calibration wizard (all under /calib/, loopback only
like the rest of the service; Caddy serves them as /vision/calib/...).

The wizard edits a DRAFT. /board and /detect keep using the ACTIVE
calibration until the operator saves; then the draft becomes a new revision
of the calibration file and is active at once (no restart).

  GET  /calib/state            draft + active summary, overlay geometry
  GET  /calib/camera           source, resolution, UVC controls, camera list
  POST /calib/camera           {index?, width?, height?, controls?, lock?}
  GET  /calib/metrics          brightness, focus (blur), clipping
  GET  /calib/frame.jpg        current frame
  GET  /calib/topdown.jpg      top-down view with the draft (?src=reference)
  POST /calib/detect-board     {method: auto|aruco|chessboard}
  POST /calib/corners          {corners: [[x,y] a1, h1, h8, a8], mirrored_camera?}
  POST /calib/orientation      {a1_index, mirrored_camera?, confirm?}
  POST /calib/reference        {frames}   averaged empty-board reference
  GET  /calib/reference        per-square statistics and warnings
  GET  /calib/squares          per-square detection with the draft
  POST /calib/autotune         {expected: "start" | {square: "w"|"b"|null}}
  POST /calib/thresholds       {diff, occupied_fraction, white}
  POST /calib/save             {note, robot: {...}}  new revision, active now
  POST /calib/validate         {revision, reachability}  final check
  GET  /calib/versions         saved revisions
  POST /calib/rollback         {revision}
  POST /calib/reload           re-read the file
  POST /calib/draft/reset      {from: active|empty}
  GET/POST /calib/sim/scene    synthetic camera only
"""

import glob
import json
import math
import os
import threading
import time
from urllib.parse import parse_qs, urlsplit

import numpy as np

from . import calib
from .board import Board, default_thresholds, detect_aruco_marker
from .config import config

MAX_BODY = 64 * 1024
_lock = threading.RLock()
store = calib.CalibrationStore(config.CALIBRATION_FILE)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _srv():
    from . import server

    return server


# --- camera sources -----------------------------------------------------------


def _active_doc():
    try:
        return store.load()
    except (OSError, ValueError):
        return None


def open_camera(source=None, width=None, height=None):
    """Open the camera: VISION_CAMERA_SOURCE (synthetic | file path) or the index.

    Resolution and UVC controls saved in the calibration are applied.
    """
    doc = _active_doc() or {}
    cam_cfg = (doc.get("camera") or {}) if doc.get("schema") == calib.SCHEMA else {}
    src = source if source is not None else (config.CAMERA_SOURCE or config.CAMERA_INDEX)
    w = width or cam_cfg.get("width") or config.FRAME_WIDTH
    h = height or cam_cfg.get("height") or config.FRAME_HEIGHT
    if src == "synthetic":
        from .synthetic import SyntheticCamera

        cam = SyntheticCamera(w, h, square_mm=config.BOARD_SQUARE_SIZE)
    else:
        from .capture import Camera

        cam = Camera(src if isinstance(src, str) and not str(src).isdigit() else int(src), w, h)
    if str(cam_cfg.get("source")) == str(cam.index):
        for name, value in (cam_cfg.get("controls") or {}).items():
            cam.set_control(name, value)
    cam.start()
    return cam


def list_cameras() -> list:
    out = []
    for dev in sorted(glob.glob("/dev/video*")):
        n = dev[len("/dev/video"):]
        if not n.isdigit():
            continue
        name = ""
        try:
            with open(f"/sys/class/video4linux/video{n}/name") as f:
                name = f.read().strip()
        except OSError:
            pass
        out.append({"index": int(n), "device": dev, "name": name})
    if config.CAMERA_SOURCE == "synthetic":
        out.insert(0, {"index": "synthetic", "device": "", "name": "synthetic board (dev only)"})
    return out


# --- the draft ------------------------------------------------------------------


class Draft:
    def __init__(self):
        self.reset()

    def reset(self, doc=None):
        self.square = config.BOARD_SQUARE_SIZE
        self.raw_corners = None
        self.a1_index = 0
        self.mirrored_camera = False
        self.method = None
        self.inner = None
        self.confirmed = False
        self.H = None
        self.grid_error = None
        self.a1_dark = None
        self.markers = []
        self.notes = []
        self.reference = None
        self.reference_frames = 0
        self.reference_stats = None
        self.thresholds = default_thresholds()
        self.autotune = None
        if doc and doc.get("schema") == calib.SCHEMA:
            b = doc.get("board") or {}
            self.square = float(b.get("square_mm", self.square))
            corners = b.get("image_corners_px") or {}
            if all(n in corners for n in calib.CORNERS):
                self.raw_corners = [corners[n] for n in calib.CORNERS]
            self.mirrored_camera = bool((b.get("orientation") or {}).get("mirrored_camera"))
            self.confirmed = bool((b.get("orientation") or {}).get("confirmed"))
            self.method = b.get("method")
            self.grid_error = b.get("grid_error")
            if b.get("homography"):
                self.H = np.array(b["homography"], dtype=float)
            self.thresholds = {**default_thresholds(), **(doc.get("thresholds") or {})}
            ref = (doc.get("reference") or {}).get("image")
            if ref:
                self.reference = _imread(store.resolve(ref))
                self.reference_frames = (doc.get("reference") or {}).get("frames", 0)

    def labelled(self):
        if self.raw_corners is None:
            return None
        return calib.label_corners(self.raw_corners, self.a1_index, self.mirrored_camera)

    def refit(self, frame=None):
        lab = self.labelled()
        if lab is None:
            self.H = None
            return
        self.H = calib.homography_from_corners(lab, self.square, self.inner)
        if frame is not None:
            g = _grey(frame)
            self.grid_error = calib.grid_error(g, self.H, self.square)
            self.a1_dark = calib.parity_score(calib.topdown_grey(frame, self.H, self.square), self.square, 2.0) < 0

    def board(self) -> Board:
        if self.H is None:
            raise ApiError("no board geometry yet (step 2)")
        b = Board()
        b._square = self.square
        b.set_homography(self.H)
        b.thresholds = dict(self.thresholds)
        return b

    def summary(self) -> dict:
        out = {
            "square_mm": self.square,
            "method": self.method,
            "raw_corners": self.raw_corners,
            "a1_index": self.a1_index,
            "mirrored_camera": self.mirrored_camera,
            "labelled": self.labelled(),
            "confirmed": self.confirmed,
            "grid_error": self.grid_error,
            "a1_dark": self.a1_dark,
            "markers": self.markers,
            "notes": self.notes,
            "has_reference": self.reference is not None,
            "reference_frames": self.reference_frames,
            "thresholds": self.thresholds,
            "overlay": calib.grid_overlay(self.H, self.square) if self.H is not None else None,
        }
        return out


draft = Draft()


def _grey(img):
    import cv2

    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _imread(path):
    import cv2

    return cv2.imread(path) if os.path.exists(path) else None


def _frame(wait_s: float = 2.0):
    cam = _srv()._get_camera()
    t0 = time.time()
    while True:
        f = cam.read()
        if f is not None:
            return f
        if time.time() - t0 > wait_s:
            raise ApiError("no camera frame", 503)
        time.sleep(0.05)


def _frames(n: int, timeout_s: float):
    """n distinct frames from the camera (the reader thread replaces the array)."""
    cam = _srv()._get_camera()
    out, last, t0 = [], None, time.time()
    while len(out) < n:
        f = cam.read()
        if f is not None and f is not last:
            out.append(f)
            last = f
        elif time.time() - t0 > timeout_s:
            break
        else:
            time.sleep(0.01)
    if not out:
        raise ApiError("no camera frame", 503)
    return out


def _mean_frame(n: int = 3):
    fs = _frames(n, 3.0)
    return np.mean(np.stack([f.astype(np.float32) for f in fs]), axis=0).round().astype(np.uint8)


# --- activation (draft or file -> the running service) --------------------------


def activate(doc) -> dict:
    """Use a calibration document in the running service (/board, /detect)."""
    srv = _srv()
    b = Board()
    calib.apply_to_board(doc, b)
    ref = None
    if doc.get("schema") == calib.SCHEMA:
        rel = (doc.get("reference") or {}).get("image")
        ref = _imread(store.resolve(rel)) if rel else None
    srv._board = b
    if ref is not None:
        srv._reference = ref
    return status()


def activate_from_file() -> None:
    """Startup: load the calibration file (either format)."""
    doc = _active_doc()
    if doc:
        activate(doc)
        draft.reset(doc)
        print(f"[vision] calibration r{doc.get('revision', '-')} loaded from {store.path}")


def wizard_active() -> bool:
    """True when the calibration file is a wizard file (the old endpoints keep out)."""
    return (_active_doc() or {}).get("schema") == calib.SCHEMA


def status() -> dict:
    doc = _active_doc()
    reasons = calib.completeness(doc)
    return {
        "file": store.path,
        "revision": (doc or {}).get("revision"),
        "created": (doc or {}).get("created"),
        "note": (doc or {}).get("operator_note"),
        "complete": not reasons,
        "reasons": reasons,
        "validation": (doc or {}).get("validation"),
        "robot": (doc or {}).get("robot"),
    }


# --- request handling -------------------------------------------------------------


def handle(h, method: str) -> None:
    url = urlsplit(h.path)
    path = url.path
    query = parse_qs(url.query)
    try:
        if method == "POST":
            body = _read_body(h)
            fn = _POST.get(path)
        else:
            body = None
            fn = _GET.get(path)
        if fn is None:
            raise ApiError("not found", 404)
        with _lock:
            result = fn(body, query) if method == "POST" else fn(query)
        if isinstance(result, tuple):  # (content type, bytes)
            _send(h, 200, result[0], result[1])
        else:
            _send(h, 200, "application/json", json.dumps(result).encode())
    except ApiError as e:
        _send(h, e.status, "application/json", json.dumps({"ok": False, "error": str(e)}).encode())
    except Exception as e:  # noqa: BLE001 - report, do not kill the service
        _send(h, 500, "application/json", json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}).encode())


def _send(h, code, ctype, body: bytes):
    h.send_response(code)
    h.send_header("Content-Type", ctype)
    h.send_header("Content-Length", str(len(body)))
    h.send_header("Cache-Control", "no-store")
    h.end_headers()
    h.wfile.write(body)


def _read_body(h) -> dict:
    """POST rules: same origin, JSON only, small bodies."""
    ctype = (h.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if ctype != "application/json":
        raise ApiError("POST needs Content-Type: application/json", 415)
    origin = h.headers.get("Origin")
    if origin:
        o = urlsplit(origin).netloc.lower()
        allowed = {(h.headers.get("Host") or "").lower(), (h.headers.get("X-Forwarded-Host") or "").lower()}
        loopback = o.split(":")[0] in ("localhost", "127.0.0.1", "[::1]")
        if o not in allowed and not loopback:
            raise ApiError("cross-origin request refused", 403)
    n = int(h.headers.get("Content-Length") or 0)
    if n > MAX_BODY:
        raise ApiError("body too large", 413)
    raw = h.rfile.read(n) if n else b"{}"
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        raise ApiError("invalid JSON") from None
    if not isinstance(data, dict):
        raise ApiError("JSON object expected")
    return data


def _num(v, name, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ApiError(f"{name} must be a number in [{lo}, {hi}]")
    return float(v)


def _point(p, name):
    if not isinstance(p, (list, tuple)) or len(p) != 2:
        raise ApiError(f"{name} must be [x, y]")
    return [_num(p[0], name, -1e5, 1e5), _num(p[1], name, -1e5, 1e5)]


# GET -------------------------------------------------------------------------


def get_state(_q):
    cam = _srv()._get_camera()
    f = cam.read()
    size = [int(f.shape[1]), int(f.shape[0])] if f is not None else [cam.width, cam.height]
    return {"ok": True, "draft": draft.summary(), "active": status(), "frame": {"width": size[0], "height": size[1]},
            "synthetic": bool(getattr(cam, "synthetic", False))}


def get_camera(_q):
    cam = _srv()._get_camera()
    return {"ok": True, "source": cam.index, "width": cam.width, "height": cam.height, "available": cam.available,
            "synthetic": bool(getattr(cam, "synthetic", False)), "controls": cam.controls(),
            "controls_set": dict(cam.controls_set), "cameras": list_cameras(),
            "resolutions": [[640, 480], [800, 600], [1280, 720], [1600, 1200], [1920, 1080]]}


def get_metrics(_q):
    import cv2

    f = _frame()
    g = _grey(f)
    roi = g
    if draft.H is not None:
        pts = calib.project(draft.H, list(calib.plane_corners(draft.square).values())).astype(int)
        x0, y0 = np.clip(pts.min(axis=0), 0, None)
        x1, y1 = pts.max(axis=0)
        if x1 - x0 > 20 and y1 - y0 > 20:
            roi = g[y0:y1, x0:x1]
    focus = float(cv2.Laplacian(roi, cv2.CV_64F).var())
    bright = float(roi.mean())
    clipped = float((roi >= 250).mean())
    dark = float((roi <= 5).mean())
    warnings = []
    if bright < 60:
        warnings.append("too dark: more light or a longer exposure")
    if bright > 200:
        warnings.append("too bright: less light or a shorter exposure")
    if clipped > 0.01:
        warnings.append(f"{clipped * 100:.1f}% of the pixels are clipped (glare)")
    if focus < 60:
        warnings.append("blurred: adjust the focus")
    return {"ok": True, "brightness": round(bright, 1), "focus": round(focus, 1), "clipped": round(clipped, 4),
            "dark": round(dark, 4), "width": int(f.shape[1]), "height": int(f.shape[0]),
            "board_roi": draft.H is not None, "warnings": warnings}


def get_frame_jpg(_q):
    import cv2

    ok, buf = cv2.imencode(".jpg", _frame(), [cv2.IMWRITE_JPEG_QUALITY, 85])
    return ("image/jpeg", buf.tobytes())


def get_topdown_jpg(q):
    import cv2

    src = (q.get("src") or ["frame"])[0]
    img = draft.reference if src == "reference" else _frame()
    if img is None:
        raise ApiError("no reference yet (step 3)", 404)
    b = draft.board()
    k = 2.0
    top = b.topdown(img, k)
    sq = draft.square * k
    for i in range(9):
        cv2.line(top, (int(i * sq), 0), (int(i * sq), int(8 * sq)), (0, 200, 255), 1)
        cv2.line(top, (0, int(i * sq)), (int(8 * sq), int(i * sq)), (0, 200, 255), 1)
    for r in range(8):
        for f in range(8):
            cv2.putText(top, "abcdefgh"[f] + str(r + 1), (int(f * sq + 3), int((7 - r) * sq + 14)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 140, 255), 1, cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", top, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return ("image/jpeg", buf.tobytes())


def get_reference(_q):
    if draft.reference is None:
        raise ApiError("no reference yet", 404)
    if draft.reference_stats is None:
        draft.reference_stats = calib.reference_stats(draft.board(), draft.reference)
    return {"ok": True, "frames": draft.reference_frames, **draft.reference_stats}


def get_squares(_q):
    if draft.reference is None:
        raise ApiError("no empty-board reference yet (step 3)")
    st = draft.board().board_state(_mean_frame(2), draft.reference, details=True)
    low = sorted(n for n, d in st["details"].items() if d["confidence"] < 0.3)
    return {"ok": True, "squares": st["squares"], "details": st["details"], "thresholds": draft.thresholds,
            "low_confidence": low}


def get_versions(_q):
    return {"ok": True, "active": status(), "versions": store.versions()}


def get_sim_scene(_q):
    cam = _srv()._get_camera()
    if not getattr(cam, "synthetic", False):
        raise ApiError("not a synthetic camera", 404)
    return {"ok": True, **cam.scene.as_dict()}


# POST ------------------------------------------------------------------------


def post_camera(body, _q):
    srv = _srv()
    cam = srv._get_camera()
    index = body.get("index", cam.index)
    width = int(_num(body.get("width", cam.width), "width", 160, 4096))
    height = int(_num(body.get("height", cam.height), "height", 120, 3072))
    if index != "synthetic":
        index = int(_num(index, "index", 0, 63))
    if index == "synthetic" and config.CAMERA_SOURCE != "synthetic":
        raise ApiError("the synthetic camera is off (VISION_CAMERA_SOURCE)")
    changed = str(index) != str(cam.index) or width != cam.width or height != cam.height
    if changed:
        keep = dict(cam.controls_set)
        cam.stop()
        srv._camera = open_camera("synthetic" if index == "synthetic" else index, width, height)
        cam = srv._camera
        for k, v in keep.items():
            cam.set_control(k, v)
        if draft.H is not None:
            draft.reset()
            draft.notes = ["camera or resolution changed: board geometry reset, redo step 2"]
    results = {}
    for name, value in (body.get("controls") or {}).items():
        results[name] = cam.set_control(str(name), _num(value, name, -1e5, 1e5))
    cur = cam.controls()
    for what, (auto, val, manual, automatic) in {
        "exposure": ("auto_exposure", "exposure", 1.0, 3.0),
        "white_balance": ("auto_wb", "wb_temperature", 0.0, 1.0),
        "focus": ("autofocus", "focus", 0.0, 1.0),
    }.items():
        lock = (body.get("lock") or {}).get(what)
        if lock is None:
            continue
        ok = cam.set_control(auto, manual if lock else automatic)
        if lock and cur.get(val) is not None:
            ok = cam.set_control(val, cur[val]) and ok
        results[f"lock_{what}"] = ok
    return {**get_camera(None), "results": results}


def post_detect_board(body, _q):
    method = body.get("method", "auto")
    if method not in ("auto", "aruco", "chessboard"):
        raise ApiError("method must be auto, aruco or chessboard")
    f = _mean_frame(2)
    det = calib.detect_board(f, draft.square, method, aruco=detect_aruco_marker)
    draft.markers = det["markers"]
    if not det["ok"]:
        return {"ok": False, "error": det["error"], "markers": det["markers"]}
    draft.raw_corners = det["raw_corners"]
    draft.a1_index = det["a1_index"]
    draft.inner = det["inner"]
    draft.method = det["method"]
    draft.confirmed = False
    draft.notes = []
    if det.get("markers_mirrored"):
        draft.notes.append("the markers are placed mirrored (1 and 2 swapped?): a1 is kept, h1/a8 follow the orientation rule")
    draft.refit(f)
    if draft.a1_dark is False:
        draft.notes.append("a1 looks LIGHT: a1 must be a dark square; choose another a1 corner")
    return {"ok": True, **draft.summary()}


def post_corners(body, _q):
    pts = body.get("corners")
    if not isinstance(pts, list) or len(pts) != 4:
        raise ApiError("corners must be 4 points: a1, h1, h8, a8")
    raw = [_point(p, "corner") for p in pts]
    mirrored_camera = bool(body.get("mirrored_camera", False))
    if abs(calib.signed_area(raw)) < 400:
        raise ApiError("the 4 corners do not span a board")
    if calib.is_mirrored(dict(zip(calib.CORNERS, raw))) != mirrored_camera:
        raise ApiError("the corners are mirrored: click a1, h1, h8, a8 so that they run counterclockwise on the screen "
                       "(a1 -> h1 along rank 1, then up to h8). Tick 'camera image is mirrored' only if it is.")
    f = _mean_frame(2)
    draft.raw_corners = raw
    draft.a1_index = 0
    draft.mirrored_camera = mirrored_camera
    draft.inner = None
    draft.method = "manual"
    draft.confirmed = False
    draft.notes = []
    draft.refit(f)
    if draft.a1_dark is False:
        draft.notes.append("a1 looks LIGHT: a1 must be a dark square; check the corner order")
    return {"ok": True, **draft.summary()}


def post_orientation(body, _q):
    if draft.raw_corners is None:
        raise ApiError("detect or click the board corners first")
    if "a1_index" in body:
        draft.a1_index = int(_num(body["a1_index"], "a1_index", 0, 3))
    if "mirrored_camera" in body:
        draft.mirrored_camera = bool(body["mirrored_camera"])
    draft.confirmed = False
    draft.refit(_mean_frame(2))
    if body.get("confirm"):
        if draft.a1_dark is False and not body.get("force"):
            raise ApiError("a1 looks light; a1 must be dark. Choose another a1 corner (or force if the board is unusual)")
        draft.confirmed = True
    return {"ok": True, **draft.summary()}


def post_reference(body, _q):
    n = int(_num(body.get("frames", 10), "frames", 1, 60))
    b = draft.board()
    fs = _frames(n, timeout_s=n * 1.0 + 2.0)
    stack = np.stack([f.astype(np.float32) for f in fs])
    mean = stack.mean(axis=0)
    tstd = stack.std(axis=0) if len(fs) > 1 else None
    draft.reference = mean.round().clip(0, 255).astype(np.uint8)
    draft.reference_frames = len(fs)
    draft.reference_stats = calib.reference_stats(b, draft.reference, tstd)
    return {"ok": True, "frames": len(fs), **draft.reference_stats}


def post_autotune(body, _q):
    if draft.reference is None:
        raise ApiError("no empty-board reference yet (step 3)")
    exp = body.get("expected", "start")
    if exp == "start":
        expected = calib.start_position()
    elif isinstance(exp, dict):
        expected = {}
        for n in calib.start_position():
            v = exp.get(n)
            if v not in ("w", "b", None):
                raise ApiError(f"bad value for {n}")
            expected[n] = v
    else:
        raise ApiError('expected must be "start" or a square map')
    res = calib.autotune(draft.board(), _mean_frame(3), draft.reference, expected)
    draft.thresholds = res["thresholds"]
    draft.autotune = res
    return {"ok": True, **res}


def post_thresholds(body, _q):
    t = dict(draft.thresholds)
    if "diff" in body:
        t["diff"] = _num(body["diff"], "diff", 1, 254)
    if "occupied_fraction" in body:
        t["occupied_fraction"] = _num(body["occupied_fraction"], "occupied_fraction", 0.01, 0.95)
    if "white" in body:
        t["white"] = _num(body["white"], "white", 1, 254)
    draft.thresholds = t
    return {"ok": True, "thresholds": t}


def post_save(body, _q):
    if draft.H is None:
        raise ApiError("no board geometry (step 2)")
    if not draft.confirmed:
        raise ApiError("confirm the board orientation first (step 2)")
    if draft.reference is None:
        raise ApiError("no empty-board reference (step 3)")
    r = body.get("robot")
    if not isinstance(r, dict):
        raise ApiError("robot: the board pose in the robot frame is missing (step 5)")
    o = r.get("origin_twin_mm")
    if not isinstance(o, list) or len(o) != 3:
        raise ApiError("robot.origin_twin_mm must be [x, y, z]")
    origin = [_num(v, "robot.origin_twin_mm", -2000, 2000) for v in o]
    rot = _num(r.get("rotation_deg", 0), "robot.rotation_deg", -180, 180)
    square = _num(r.get("square_mm", draft.square), "robot.square_mm", 10, 100)
    note = str(body.get("note", ""))[:500]
    H = draft.H.copy()
    if abs(square - draft.square) > 1e-9:
        # Same pixels, new board units: x_mm_new = x_mm_old * square / draft.square.
        s = draft.square / square
        H = H @ np.diag([s, s, 1.0])
    cam = _srv()._get_camera()
    lab = draft.labelled()
    robot = {
        "origin_twin_mm": origin,
        "rotation_deg": rot,
        "square_mm": square,
        # Derived, for people: the same a1 corner in the robot base frame (Z up).
        "a1_corner_base_mm": [origin[0], -origin[2], origin[1]],
        "method": str(r.get("method", "manual"))[:40],
        "residual_mm": r.get("residual_mm") if isinstance(r.get("residual_mm"), (int, float)) else None,
        "points_twin_mm": r.get("points_twin_mm") if isinstance(r.get("points_twin_mm"), dict) else None,
        "hover_mm": r.get("hover_mm") if isinstance(r.get("hover_mm"), (int, float)) else None,
    }
    doc = {
        "schema": calib.SCHEMA,
        "operator_note": note,
        "camera": {"source": str(cam.index), "width": cam.width, "height": cam.height,
                   "controls": dict(cam.controls_set), "intrinsics": None},
        "board": {
            "square_mm": square,
            "homography": (H / H[2, 2]).tolist(),
            "plane": "board plane mm: origin a8 corner, x along files a->h, y along ranks 8->1; H maps plane -> pixel",
            "image_corners_px": lab,
            "orientation": {"confirmed": True, "mirrored_camera": draft.mirrored_camera, "a1_dark": draft.a1_dark},
            "method": draft.method,
            "grid_error": draft.grid_error,
        },
        "reference": {"frames": draft.reference_frames,
                      "contrast": (draft.reference_stats or {}).get("contrast"),
                      "warnings": (draft.reference_stats or {}).get("warnings", [])},
        "thresholds": dict(draft.thresholds),
        "robot": robot,
    }
    saved = store.save(doc, draft.reference)
    draft.square = square
    draft.H = H / H[2, 2]
    return {"ok": True, "saved": saved, "status": activate(saved)}


def post_validate(body, _q):
    doc = store.load()
    if not doc or doc.get("schema") != calib.SCHEMA:
        raise ApiError("no saved calibration")
    rev = int(_num(body.get("revision", -1), "revision", 0, 1e9))
    if rev != doc.get("revision"):
        raise ApiError(f"revision {rev} is not the active calibration (r{doc.get('revision')})")
    reach = body.get("reachability") or {}
    reachable = int(_num(reach.get("reachable", 0), "reachable", 0, 1000))
    total = int(_num(reach.get("total", 0), "total", 1, 1000))
    unreachable = [str(x)[:40] for x in (reach.get("unreachable") or [])][:80]
    srv = _srv()
    activate(doc)
    if srv._reference is None:
        raise ApiError("the reference image of this calibration is missing")
    observed = srv._board.board_state(_mean_frame(3), srv._reference)["squares"]
    score = calib.score_position(observed, calib.start_position())
    passed = score["pieces_correct"] == score["pieces_total"] == 32 and score["correct"] == 64 and reachable == total
    validation = {"passed": passed, "start_position": score, "observed": observed,
                  "reachability": {"reachable": reachable, "total": total, "unreachable": unreachable}}
    saved = store.set_validation(rev, validation)
    return {"ok": True, "validation": saved["validation"], "status": status()}


def post_rollback(body, _q):
    rev = int(_num(body.get("revision"), "revision", 1, 1e9))
    try:
        doc = store.rollback(rev)
    except FileNotFoundError as e:
        raise ApiError(str(e), 404) from None
    draft.reset(doc)
    return {"ok": True, "status": activate(doc), "revision": doc["revision"]}


def post_reload(_body, _q):
    doc = store.load()
    if not doc:
        raise ApiError("no calibration file", 404)
    return {"ok": True, "status": activate(doc)}


def post_draft_reset(body, _q):
    draft.reset(store.load() if body.get("from", "active") == "active" else None)
    return {"ok": True, "draft": draft.summary()}


def post_sim_scene(body, _q):
    cam = _srv()._get_camera()
    if not getattr(cam, "synthetic", False):
        raise ApiError("not a synthetic camera", 404)
    preset = body.get("preset")
    if preset not in (None, "empty", "start"):
        raise ApiError("preset must be empty or start")
    moves = body.get("moves") or []
    if not isinstance(moves, list) or not all(isinstance(m, list) and len(m) == 2 for m in moves):
        raise ApiError("moves must be [[from, to], ...]")
    pieces = body.get("pieces")  # a whole position: {"e4": "w", ...} (dev tools, the loop e2e)
    if pieces is not None and not (isinstance(pieces, dict) and all(
            isinstance(k, str) and len(k) == 2 and k[0] in "abcdefgh" and k[1] in "12345678" and v in ("w", "b")
            for k, v in pieces.items())):
        raise ApiError('pieces must be {"<square>": "w" | "b", ...}')
    cam.scene.set(preset=preset, markers=body.get("markers"), light=body.get("light"), glare=body.get("glare"),
                  shadow=body.get("shadow"), moves=[[str(a), str(b)] for a, b in moves], pieces=pieces)
    return {"ok": True, **cam.scene.as_dict()}


_GET = {
    "/calib/state": get_state,
    "/calib/camera": get_camera,
    "/calib/metrics": get_metrics,
    "/calib/frame.jpg": get_frame_jpg,
    "/calib/topdown.jpg": get_topdown_jpg,
    "/calib/reference": get_reference,
    "/calib/squares": get_squares,
    "/calib/versions": get_versions,
    "/calib/status": lambda _q: {"ok": True, **status()},
    "/calib/sim/scene": get_sim_scene,
}
_POST = {
    "/calib/camera": post_camera,
    "/calib/detect-board": post_detect_board,
    "/calib/corners": post_corners,
    "/calib/orientation": post_orientation,
    "/calib/reference": post_reference,
    "/calib/autotune": post_autotune,
    "/calib/thresholds": post_thresholds,
    "/calib/save": post_save,
    "/calib/validate": post_validate,
    "/calib/rollback": post_rollback,
    "/calib/reload": post_reload,
    "/calib/draft/reset": post_draft_reset,
    "/calib/sim/scene": post_sim_scene,
}
