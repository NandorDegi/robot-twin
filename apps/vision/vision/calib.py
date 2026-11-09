"""Calibration wizard: board geometry, orientation, empty-board reference,
threshold auto-tune and the versioned calibration file.

Conventions (the same as vision.board):
  board plane (mm): origin at the a8 corner, x along the files a -> h,
  y along the ranks 8 -> 1. The homography H maps board plane -> pixel.
  Corner labels: a1, h1, h8, a8 (outer board corners).

Orientation rule: for a camera that looks down on the board (image not
mirrored), the path a1 -> h1 -> h8 -> a8 runs counterclockwise on the screen.
In image coordinates (y down) its signed area is negative. A positive area
means ranks or files are mirrored, which was a past bug (a piece on a8 got the
robot target of a1). It is refused unless the camera image itself is mirrored.

The calibration file is the one source of truth for board geometry, the
empty-board reference, the thresholds and the board pose in the robot frame.
The vision service writes it; the robot server only reads it.
"""

import copy
import datetime as _dt
import json
import math
import os
import re

import numpy as np

from .board import Board, default_thresholds, square_name

SCHEMA = "robot-twin.calibration/1"
CORNERS = ("a1", "h1", "h8", "a8")


def _cv2():
    import cv2

    return cv2


# --- corners, orientation, homography -----------------------------------------


def plane_corners(square: float) -> dict:
    w = 8.0 * square
    return {"a8": (0.0, 0.0), "h8": (w, 0.0), "a1": (0.0, w), "h1": (w, w)}


def signed_area(points) -> float:
    """Shoelace area of a polygon in image coordinates (y down)."""
    p = np.asarray(points, dtype=float)
    x, y = p[:, 0], p[:, 1]
    return float(0.5 * (np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y)))


def is_mirrored(labelled: dict) -> bool:
    """True when a1 -> h1 -> h8 -> a8 runs clockwise on the screen (mirrored)."""
    return signed_area([labelled[n] for n in CORNERS]) > 0


def screen_ccw_order(raw) -> list:
    """Indices of 4 points in counterclockwise screen order (negative area)."""
    p = np.asarray(raw, dtype=float)
    c = p.mean(axis=0)
    order = sorted(range(4), key=lambda i: math.atan2(p[i][1] - c[1], p[i][0] - c[0]))
    if signed_area(p[order]) > 0:
        order = order[::-1]
    return order


def label_corners(raw, a1_index: int, mirrored: bool = False) -> dict:
    """Name the 4 outer corners, given which raw point is a1.

    The other names follow the orientation rule (a1 -> h1 -> h8 -> a8
    counterclockwise on the screen), or the reverse when the camera image is
    mirrored. So only the a1 corner must be chosen.
    """
    if not 0 <= a1_index < 4:
        raise ValueError("a1_index must be 0..3")
    order = screen_ccw_order(raw)
    if mirrored:
        order = order[::-1]
    k = order.index(a1_index)
    return {name: [float(raw[order[(k + i) % 4]][0]), float(raw[order[(k + i) % 4]][1])] for i, name in enumerate(CORNERS)}


def homography_from_corners(labelled: dict, square: float, inner_px=None) -> np.ndarray:
    """Board plane -> pixel homography from the labelled outer corners.

    With `inner_px` (detected inner grid corners, any order), each inner point
    is snapped to its grid node and the fit uses all points (least squares).
    """
    cv2 = _cv2()
    pc = plane_corners(square)
    src = np.float32([pc[n] for n in CORNERS])
    dst = np.float32([labelled[n] for n in CORNERS])
    H = cv2.getPerspectiveTransform(src, dst).astype(float)
    if inner_px is not None and len(inner_px) >= 4:
        Hi = np.linalg.inv(H)
        s2, d2 = list(src), list(dst)
        for p in np.asarray(inner_px, dtype=float).reshape(-1, 2):
            q = Hi @ np.array([p[0], p[1], 1.0])
            q = q[:2] / q[2]
            node = np.round(q / square) * square
            if np.all(node > 0) and np.all(node < 8 * square) and np.linalg.norm(q - node) < 0.25 * square:
                s2.append(node)
                d2.append(p)
        if len(s2) > 8:
            H2, _ = cv2.findHomography(np.float32(s2), np.float32(d2), 0)
            if H2 is not None:
                H = H2.astype(float)
    return H / H[2, 2]


def project(H: np.ndarray, pts) -> np.ndarray:
    p = np.asarray(pts, dtype=float).reshape(-1, 2)
    q = (H @ np.hstack([p, np.ones((len(p), 1))]).T).T
    return q[:, :2] / q[:, 2:3]


def grid_overlay(H: np.ndarray, square: float) -> dict:
    """Pixel geometry for the UI overlay: grid lines, square centres, corners."""
    w = 8.0 * square
    lines = []
    for i in range(9):
        a, b = project(H, [(i * square, 0.0), (i * square, w)])
        lines.append([a.tolist(), b.tolist()])
        a, b = project(H, [(0.0, i * square), (w, i * square)])
        lines.append([a.tolist(), b.tolist()])
    centres = {}
    for r in range(8):
        for f in range(8):
            c = project(H, [((f + 0.5) * square, (7 - r + 0.5) * square)])[0]
            centres[square_name(r, f)] = [round(float(c[0]), 1), round(float(c[1]), 1)]
    corners = {n: [round(float(v), 1) for v in project(H, [p])[0]] for n, p in plane_corners(square).items()}
    return {"lines": lines, "centres": centres, "corners": corners}


def grid_error(grey, H: np.ndarray, square: float):
    """Reprojection error (px) of the 49 inner grid corners.

    Each predicted corner is refined on the image (cornerSubPix); the error is
    the distance between prediction and refined corner. Points that do not
    converge (covered by a piece, a marker) are skipped.
    """
    cv2 = _cv2()
    nodes = [(i * square, j * square) for j in range(1, 8) for i in range(1, 8)]
    pred = project(H, nodes).astype(np.float32)
    a, b = project(H, [(0.0, 0.0), (square, 0.0)])
    sq_px = float(np.linalg.norm(b - a))
    win = int(max(3, min(12, sq_px * 0.2)))
    h, w = grey.shape[:2]
    inside = (pred[:, 0] > win) & (pred[:, 0] < w - win) & (pred[:, 1] > win) & (pred[:, 1] < h - win)
    if inside.sum() < 4:
        return None
    pts = pred[inside].reshape(-1, 1, 2).copy()
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.01)
    ref = cv2.cornerSubPix(grey, pts, (win, win), (-1, -1), crit).reshape(-1, 2)
    d = np.linalg.norm(ref - pred[inside], axis=1)
    ok = d < win * 0.8
    if ok.sum() < 4:
        return {"mean_px": None, "max_px": None, "points": int(ok.sum()), "square_px": round(sq_px, 1)}
    return {
        "mean_px": round(float(d[ok].mean()), 2),
        "max_px": round(float(d[ok].max()), 2),
        "points": int(ok.sum()),
        "square_px": round(sq_px, 1),
        "mean_mm": round(float(d[ok].mean()) * square / sq_px, 2),
    }


def parity_score(grey_topdown, square: float, k: float) -> float:
    """Mean grey of a1-coloured squares minus the others (negative: a1 is dark).

    It samples the corners of each square, which a piece does not cover.
    """
    sq = square * k
    vals = {0: [], 1: []}
    for r in range(8):
        for f in range(8):
            row = 7 - r
            y0, x0 = row * sq, f * sq
            patches = []
            for fy, fx in ((0.06, 0.06), (0.06, 0.78), (0.78, 0.06), (0.78, 0.78)):
                ya, xa = int(y0 + fy * sq), int(x0 + fx * sq)
                patches.append(grey_topdown[ya:ya + max(1, int(0.16 * sq)), xa:xa + max(1, int(0.16 * sq))])
            vals[(r + f) % 2].append(float(np.median(np.concatenate([p.ravel() for p in patches]))))
    return float(np.mean(vals[0]) - np.mean(vals[1]))


def topdown_grey(frame, H: np.ndarray, square: float, k: float = 2.0):
    cv2 = _cv2()
    S = np.array([[k, 0, 0], [0, k, 0], [0, 0, 1]], dtype=float)
    size = int(round(8 * square * k))
    top = cv2.warpPerspective(frame, S @ np.linalg.inv(H), (size, size))
    return top if top.ndim == 2 else cv2.cvtColor(top, cv2.COLOR_BGR2GRAY)


def detect_board(frame, square: float, method: str = "auto", aruco=None) -> dict:
    """Find the 4 outer board corners.

    aruco: markers 0..3 with the marker centre on a8, h8, a1, h1.
    chessboard: the 7x7 inner corners of an empty board (orientation then
    comes from the operator and the a1-is-dark check).
    Returns {ok, method, raw_corners, a1_index, inner, markers, error}.
    """
    cv2 = _cv2()
    grey = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    out = {"ok": False, "method": None, "raw_corners": None, "a1_index": 0, "inner": None, "markers": []}
    if method in ("auto", "aruco") and aruco is not None:
        corners, ids = aruco(frame)
        ids = ids or []
        out["markers"] = [{"id": int(i), "centre": np.asarray(c).reshape(-1, 2).mean(axis=0).tolist()} for c, i in zip(corners or [], ids)]
        by_id = {m["id"]: m["centre"] for m in out["markers"]}
        if all(i in by_id for i in (0, 1, 2, 3)):
            raw = [by_id[2], by_id[3], by_id[1], by_id[0]]  # a1, h1, h8, a8
            out.update(ok=True, method="aruco", raw_corners=raw, a1_index=0,
                       markers_mirrored=is_mirrored(dict(zip(CORNERS, raw))))
    if not out["ok"] and method in ("auto", "chessboard"):
        found, pts = cv2.findChessboardCornersSB(grey, (7, 7), cv2.CALIB_CB_NORMALIZE_IMAGE)
        if found:
            pts = pts.reshape(-1, 2)
            grid = np.float32([(c + 1, r + 1) for r in range(7) for c in range(7)])
            H0, _ = cv2.findHomography(grid, pts.astype(np.float32), 0)
            raw = project(H0, [(0, 0), (8, 0), (8, 8), (0, 8)]).tolist()
            out.update(ok=True, method="chessboard", raw_corners=raw, inner=pts.tolist(),
                       a1_index=suggest_a1(frame, raw, square))
    if not out["ok"]:
        out["error"] = (
            "no board found: show all 4 ArUco markers (ids 0-3) or an empty board, check focus and light; "
            "or click the 4 corners"
        )
    return out


def suggest_a1(frame, raw, square: float) -> int:
    """Suggest the a1 corner: a1 must be a dark square; prefer the bottom-left."""
    order = sorted(range(4), key=lambda i: -(raw[i][1] - raw[i][0]))  # bottom-left first
    for i in order:
        H = homography_from_corners(label_corners(raw, i), square)
        if parity_score(topdown_grey(frame, H, square), square, 2.0) < 0:
            return i
    return order[0]


# --- reference, square statistics ---------------------------------------------


def reference_stats(board: Board, mean_img, tstd_img=None) -> dict:
    """Per-square brightness and variance of the empty-board reference,
    with warnings for glare, shadows, noise and objects on the board."""
    cv2 = _cv2()
    k = 2.0
    top = cv2.cvtColor(board.topdown(mean_img, k), cv2.COLOR_BGR2GRAY)
    tst = None
    if tstd_img is not None:
        t = board.topdown(tstd_img.astype(np.float32), k)
        tst = t.mean(axis=2) if t.ndim == 3 else t
    sq = {}
    groups = {0: [], 1: []}
    for r, f, (y0, y1, x0, x1) in board.square_windows(k, inset=0.1):
        name = square_name(r, f)
        patch = top[y0:y1, x0:x1].astype(float)
        e = {
            "mean": round(float(patch.mean()), 1),
            "std": round(float(patch.std()), 1),
            "clipped": round(float((patch >= 250).mean()), 3),
            "temporal_std": round(float(tst[y0:y1, x0:x1].mean()), 2) if tst is not None else None,
            "dark": (r + f) % 2 == 0,
            "flags": [],
        }
        sq[name] = e
        groups[(r + f) % 2].append(e["mean"])
    med = {g: float(np.median(v)) for g, v in groups.items()}
    mad = {g: float(np.median(np.abs(np.array(v) - med[g]))) for g, v in groups.items()}
    warnings = []
    for name, e in sq.items():
        g = 0 if e["dark"] else 1
        tol = max(25.0, 4.0 * mad[g])
        if e["clipped"] > 0.02 or e["mean"] > med[g] + tol:
            e["flags"].append("glare")
        elif e["mean"] < med[g] - tol:
            e["flags"].append("shadow")
        if e["std"] > 22:
            e["flags"].append("uneven")
        if e["temporal_std"] is not None and e["temporal_std"] > 6:
            e["flags"].append("noisy")
    for flag, text in (
        ("glare", "glare (too bright or clipped): move the light, use a diffuser, or lower the exposure"),
        ("shadow", "shadow (darker than the other squares of the same colour): move the light or the arm"),
        ("uneven", "uneven square (a piece, a marker or a strong reflection on the board?)"),
        ("noisy", "noisy (changes between frames): more light, lower gain, lock the exposure"),
    ):
        names = [n for n, e in sq.items() if flag in e["flags"]]
        if names:
            warnings.append(f"{text}: {', '.join(names)}")
    contrast = med[1] - med[0]
    if contrast < 30:
        warnings.append(f"low contrast between light and dark squares ({contrast:.0f} grey levels)")
    return {"squares": sq, "warnings": warnings, "light_median": round(med[1], 1),
            "dark_median": round(med[0], 1), "contrast": round(contrast, 1)}


# --- thresholds ---------------------------------------------------------------


def start_position() -> dict:
    return {square_name(r, f): ("w" if r < 2 else "b" if r > 5 else None) for r in range(8) for f in range(8)}


def autotune(board: Board, frame, reference, expected: dict) -> dict:
    """Thresholds that read `expected` (square -> "w"|"b"|None) correctly, with
    the largest margin. Returns {thresholds, correct, total, pieces_correct,
    pieces_total, errors, occupancy_margin, colour_margin}."""
    cv2 = _cv2()
    from .config import config

    k = config.TOPDOWN_PX_PER_MM
    top = cv2.cvtColor(board.topdown(frame, k), cv2.COLOR_BGR2GRAY)
    ref = cv2.cvtColor(board.topdown(reference, k), cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(top, ref)
    wins = {square_name(r, f): w for r, f, w in board.square_windows(k)}
    occ = [n for n in wins if expected.get(n)]
    emp = [n for n in wins if not expected.get(n)]
    if not occ or not emp:
        raise ValueError("the expected position needs empty and occupied squares")

    def frac(n, t):
        y0, y1, x0, x1 = wins[n]
        return float((diff[y0:y1, x0:x1] > t).mean())

    results = []
    for t in range(6, 122, 2):
        fo = np.array([frac(n, t) for n in occ])
        fe = np.array([frac(n, t) for n in emp])
        margin = float(fo.min() - fe.max())
        if margin > 0:
            thr, errors = float(fe.max() + fo.min()) / 2, 0
        else:
            cands = np.unique(np.concatenate([fo, fe]))
            errs = [int((fo < c).sum() + (fe >= c).sum()) for c in cands]
            j = int(np.argmin(errs))
            thr, errors = float(cands[j]), errs[j]
        results.append((errors, margin, t, float(min(0.9, max(0.02, thr)))))
    least = min(r[0] for r in results)
    cands = [r for r in results if r[0] == least]
    best_margin = max(r[1] for r in cands)
    # Robust choice: the middle of the diff thresholds whose margin is close to
    # the best one, not the most sensitive one (light changes during a game).
    good = sorted((r for r in cands if r[1] >= best_margin - 0.2 * abs(best_margin)), key=lambda r: r[2])
    _, occ_margin, t_best, occ_thr = good[len(good) // 2]

    greys = {}
    for n in occ:
        y0, y1, x0, x1 = wins[n]
        m = diff[y0:y1, x0:x1] > t_best
        greys[n] = float(top[y0:y1, x0:x1][m].mean()) if m.any() else float(top[y0:y1, x0:x1].mean())
    gw = [greys[n] for n in occ if expected[n] == "w"]
    gb = [greys[n] for n in occ if expected[n] == "b"]
    if gw and gb:
        colour_margin = min(gw) - max(gb)
        if colour_margin > 0:
            white = (min(gw) + max(gb)) / 2
        else:
            cands = sorted(gw + gb)
            white = min(cands, key=lambda c: sum(g < c for g in gw) + sum(g >= c for g in gb))
    else:
        colour_margin, white = 0.0, float(config.WHITE_THRESHOLD)

    th = {"diff": float(t_best), "occupied_fraction": round(occ_thr, 3), "white": round(float(white), 1)}
    return {**score_position(board.board_state(frame, reference, th)["squares"], expected),
            "thresholds": th, "occupancy_margin": round(occ_margin, 3), "colour_margin": round(float(colour_margin), 1)}


def score_position(observed: dict, expected: dict) -> dict:
    errors = sorted(n for n in expected if observed.get(n) != expected[n])
    pieces = [n for n in expected if expected[n]]
    return {
        "correct": 64 - len(errors),
        "total": 64,
        "pieces_correct": sum(1 for n in pieces if observed.get(n) == expected[n]),
        "pieces_total": len(pieces),
        "errors": errors,
    }


# --- the calibration file -----------------------------------------------------


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def completeness(doc) -> list:
    """Reasons why a calibration is not usable by the chess loop ([] = complete)."""
    if not isinstance(doc, dict):
        return ["no calibration file"]
    if doc.get("schema") != SCHEMA:
        return ["old calibration format (homography only): run the Calibrate wizard"]
    reasons = []
    b = doc.get("board") or {}
    if not b.get("homography"):
        reasons.append("no board homography")
    if not b.get("orientation", {}).get("confirmed"):
        reasons.append("board orientation not confirmed")
    if not (doc.get("reference") or {}).get("image"):
        reasons.append("no empty-board reference")
    if not doc.get("thresholds"):
        reasons.append("no thresholds")
    if not (doc.get("robot") or {}).get("origin_twin_mm"):
        reasons.append("no board pose in the robot frame")
    v = doc.get("validation") or {}
    if not v.get("passed") or v.get("revision") != doc.get("revision"):
        reasons.append("not validated (run the final check)")
    return reasons


class CalibrationStore:
    """The active file plus every saved version in <dir>/calibration.d/."""

    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self.dir = os.path.join(os.path.dirname(self.path), "calibration.d")

    def _version_path(self, rev: int) -> str:
        return os.path.join(self.dir, f"calibration-r{rev:04d}.json")

    def resolve(self, rel: str) -> str:
        return rel if os.path.isabs(rel) else os.path.join(os.path.dirname(self.path), rel)

    def load(self):
        if not os.path.exists(self.path):
            return None
        with open(self.path) as f:
            return json.load(f)

    def versions(self) -> list:
        if not os.path.isdir(self.dir):
            return []
        out = []
        for fn in sorted(os.listdir(self.dir)):
            m = re.fullmatch(r"calibration-r(\d{4,})\.json", fn)
            if not m:
                continue
            try:
                with open(os.path.join(self.dir, fn)) as f:
                    d = json.load(f)
            except (OSError, ValueError):
                continue
            out.append({
                "revision": int(m.group(1)),
                "created": d.get("created"),
                "note": d.get("operator_note", ""),
                "passed": bool((d.get("validation") or {}).get("passed")),
                "rolled_back_from": d.get("rolled_back_from"),
            })
        return out

    def next_revision(self) -> int:
        v = self.versions()
        return (max(x["revision"] for x in v) + 1) if v else 1

    def _write(self, path: str, doc: dict) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)

    def save(self, doc: dict, reference_img=None) -> dict:
        """Write a new revision and make it active. Returns the saved document."""
        os.makedirs(self.dir, exist_ok=True)
        doc = copy.deepcopy(doc)
        rev = self.next_revision()
        doc["schema"] = SCHEMA
        doc["revision"] = rev
        doc["created"] = now_iso()
        doc.pop("validation", None)
        if reference_img is not None:
            rel = os.path.join("calibration.d", f"reference-r{rev:04d}.png")
            if not _cv2().imwrite(self.resolve(rel), reference_img):
                raise RuntimeError("could not write the reference image")
            doc.setdefault("reference", {})["image"] = rel
        self._write(self._version_path(rev), doc)
        self._write(self.path, doc)
        return doc

    def rollback(self, revision: int) -> dict:
        """Make an old revision active again, as a new revision (history stays)."""
        p = self._version_path(int(revision))
        if not os.path.exists(p):
            raise FileNotFoundError(f"no calibration revision {revision}")
        with open(p) as f:
            old = json.load(f)
        old["rolled_back_from"] = int(revision)
        old["operator_note"] = f"rollback to r{int(revision)}: {old.get('operator_note', '')}".strip()
        validation = old.get("validation")
        doc = self.save(old)
        if validation and validation.get("passed"):
            # The check was for the same content; keep it, now for this revision.
            doc = self.set_validation(doc["revision"], {**validation, "revision": doc["revision"], "carried_from": int(revision)})
        return doc

    def set_validation(self, revision: int, validation: dict) -> dict:
        doc = self.load()
        if not doc or doc.get("revision") != int(revision):
            raise ValueError("the validated revision is not the active calibration")
        doc["validation"] = {**validation, "revision": int(revision), "date": now_iso()}
        self._write(self._version_path(int(revision)), doc)
        self._write(self.path, doc)
        return doc


def apply_to_board(doc: dict, board: Board) -> None:
    """Use a calibration document (new or old format) in a Board."""
    if doc.get("schema") != SCHEMA:
        if "H" in doc:  # old format: homography only
            board._square = float(doc.get("square", board.square_size))
            board.set_homography(np.array(doc["H"], dtype=float))
        return
    b = doc["board"]
    square = float(b.get("square_mm") or board.square_size)
    board._square = square
    board.set_homography(np.array(b["homography"], dtype=float))
    th = doc.get("thresholds")
    if th:
        board.thresholds = {**default_thresholds(), **{k: float(v) for k, v in th.items() if k in ("diff", "occupied_fraction", "white")}}
    r = doc.get("robot") or {}
    if r.get("origin_twin_mm"):
        board.set_pose(r["origin_twin_mm"], float(r.get("rotation_deg", 0.0)), square)
