"""Lens distortion: the model, the fit from a printed checkerboard, and the board
mapping with a bent (cheap wide-angle webcam) image. Synthetic images only."""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
cv2 = pytest.importorskip("cv2")

from vision import calib, calib_api, lens as lensmod  # noqa: E402
from vision.board import Board, detect_aruco_marker, square_name  # noqa: E402
from vision.pieces import square_of_pixel  # noqa: E402
from vision.synthetic import PATTERN, PATTERN_POSES, SyntheticCamera, SyntheticScene, render, true_homography, true_lens  # noqa: E402

SQ = 40.0
SIZE = (1280, 720)


def frame(**scene):
    s = SyntheticScene()
    s.set(**scene)
    return render(s, *SIZE, {}, np.random.default_rng(3))


_VIEWS = []


def views():
    if _VIEWS:
        return list(_VIEWS)
    out = _VIEWS
    for i in range(len(PATTERN_POSES)):
        p = lensmod.find_pattern(frame(lens=True, pattern=i), PATTERN[0], PATTERN[1])
        assert p is not None, f"pose {i}: pattern not found"
        out.append(p)
    return list(out)


@pytest.fixture(scope="module")
def fitted():
    return lensmod.solve(views(), SIZE, *PATTERN)


def test_raw_and_ideal_are_inverse():
    lens = true_lens()
    pts = np.random.default_rng(0).uniform([0, 0], SIZE, (500, 2))
    assert lens.to_raw(lens.to_ideal(pts)) == pytest.approx(pts, abs=1e-3)
    assert lens.to_ideal(np.array([640.0, 360.0])) == pytest.approx([640.0, 360.0])  # the centre does not move
    assert lens.monotonic()


def test_solve_recovers_the_lens(fitted):
    lens = fitted["lens"]
    assert fitted["rms_px"] < 0.5 and not fitted["dropped"]
    truth = true_lens()
    # Straight lines, bent by the true lens, come out straight through the fitted
    # model, inside the area that the sheet covered.
    vs = np.concatenate(views())
    lo, hi = vs.min(axis=0), vs.max(axis=0)
    rng = np.random.default_rng(1)
    checked = 0
    for _ in range(60):
        a, b = rng.uniform(lo, hi, (2, 2))
        line = truth.to_raw(truth.to_ideal(a) + np.linspace(0, 1, 30)[:, None] * (truth.to_ideal(b) - truth.to_ideal(a)))
        if (line < lo).any() or (line > hi).any():
            continue
        q = lens.to_ideal(line)
        d = (q[-1] - q[0]) / np.linalg.norm(q[-1] - q[0])
        assert np.abs((q - q[0]) @ np.array([-d[1], d[0]])).max() < 0.5
        checked += 1
    assert checked > 20
    pts = rng.uniform([0, 0], SIZE, (200, 2))
    back = lensmod.Lens.from_dict(lens.as_dict())
    assert back.to_ideal(pts) == pytest.approx(lens.to_ideal(pts), abs=1e-3)


def test_solve_refuses_too_few_views_and_warns_on_poor_coverage():
    vs = views()
    with pytest.raises(ValueError, match="at least"):
        lensmod.solve(vs[:3], SIZE, *PATTERN)
    # Only the views near the centre: the edges are not covered.
    central = [v for v in vs if np.abs(v.mean(axis=0) - np.array(SIZE) / 2).max() < 150]
    if len(central) >= lensmod.MIN_VIEWS:
        assert any("edges" in w for w in lensmod.solve(central, SIZE, *PATTERN)["warnings"])
    assert lensmod.similar(vs[0], [vs[0] + 0.5], SIZE) and not lensmod.similar(vs[0], [vs[1]], SIZE)


def _board(img, lens):
    det = calib.detect_board(img, SQ, "aruco", aruco=detect_aruco_marker, lens=lens)
    assert det["ok"]
    lab = calib.label_corners(det["raw_corners"], det["a1_index"])
    b = Board()
    b.set_homography(calib.homography_from_corners(calib.to_ideal(lab, lens), SQ))
    b.set_lens(lens)
    return b


def _errors_mm(b):
    """Board-plane error (mm) of each square centre and of points near the board edge."""
    lens, H = true_lens(), true_homography()
    pts = [((f + 0.5) * SQ, (7 - r + 0.5) * SQ) for r in range(8) for f in range(8)]
    pts += [(x, y) for x in (4.0, 316.0) for y in np.linspace(4, 316, 9)]
    raw = lens.to_raw(calib.project(H, pts))
    return np.array([np.linalg.norm(b.board_of_pixel(p) - np.array(q)) for p, q in zip(raw, pts)])


def test_a_bent_board_maps_right_only_with_the_lens_model(fitted):
    img = frame(preset="empty", markers=True, lens=True)
    with_lens = _errors_mm(_board(img, fitted["lens"]))
    without = _errors_mm(_board(img, None))
    assert with_lens.max() < 1.5
    assert without.max() > 4 * with_lens.max() and without.max() > 3.0
    # Every square centre lands on its own square with the lens model.
    b = _board(img, fitted["lens"])
    H = true_homography()
    for r in range(8):
        for f in range(8):
            px = true_lens().to_raw(calib.project(H, [((f + 0.5) * SQ, (7 - r + 0.5) * SQ)])[0])
            assert square_of_pixel(px, b) == [r, f], square_name(r, f)


def test_grid_error_and_topdown_are_straight_with_the_lens(fitted):
    img = frame(preset="empty", markers=False, lens=True)
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    lens = fitted["lens"]
    det = calib.detect_board(img, SQ, "chessboard", lens=lens)
    assert det["ok"]
    lab = calib.label_corners(det["raw_corners"], det["a1_index"])
    H = calib.homography_from_corners(calib.to_ideal(lab, lens), SQ, calib.to_ideal(det["inner"], lens))
    good = calib.grid_error(grey, H, SQ, lens)
    det0 = calib.detect_board(img, SQ, "chessboard")
    lab0 = calib.label_corners(det0["raw_corners"], det0["a1_index"])
    bad = calib.grid_error(grey, calib.homography_from_corners(lab0, SQ, det0["inner"]), SQ)
    assert good["mean_px"] < 0.6 and good["mean_px"] < bad["mean_px"] / 2
    ov = calib.grid_overlay(H, SQ, lens)
    assert len(ov["lines"]) == 18 * 8  # bent lines as short segments
    b = Board()
    b.set_homography(H)
    b.set_lens(lens)
    assert b.topdown(img, 2.0).shape[:2] == (640, 640)
    with pytest.raises(ValueError, match="resolution"):
        b.topdown(cv2.resize(img, (640, 360)), 2.0)


def test_apply_to_board_reads_the_intrinsics(fitted):
    doc = {"schema": calib.SCHEMA, "camera": {"intrinsics": fitted["lens"].as_dict()},
           "board": {"square_mm": SQ, "homography": np.eye(3).tolist()}}
    b = Board()
    calib.apply_to_board(doc, b)
    assert b.lens is not None and b.lens.size == SIZE
    doc["camera"]["intrinsics"] = None
    calib.apply_to_board(doc, b)
    assert b.lens is None


def test_pattern_svg_has_the_right_number_of_squares():
    svg = lensmod.pattern_svg(9, 6, 25)
    assert svg.count("<rect x=") == 35 and 'width="274.0mm"' in svg


# --- the wizard handlers ------------------------------------------------------------


class _Srv:
    def __init__(self):
        self._camera = SyntheticCamera()
        self._camera.start()
        self._board = Board()
        self._reference = None

    def _get_camera(self):
        return self._camera


@pytest.fixture()
def api(tmp_path, monkeypatch):
    srv = _Srv()
    monkeypatch.setattr(calib_api, "_srv", lambda: srv)
    monkeypatch.setattr(calib_api, "store", calib.CalibrationStore(str(tmp_path / "calibration.json")))
    calib_api.draft.reset()
    yield srv
    srv._camera.stop()


def _show(srv, **scene):
    srv._camera.scene.set(**scene)
    srv._camera.refresh()


def test_lens_step_through_the_handlers_and_into_the_saved_file(api):
    a = calib_api
    _show(api, preset="empty", markers=True, lens=True)
    a.post_detect_board({"method": "auto"}, {})
    a.post_orientation({"confirm": True}, {})
    before = a.draft.grid_error
    with pytest.raises(a.ApiError, match="capture"):
        a.post_lens_solve({}, {})
    with pytest.raises(a.ApiError, match="differ"):
        a.post_lens_capture({"cols": 6, "rows": 6}, {})
    for i in range(len(PATTERN_POSES)):
        _show(api, pattern=i)
        st = a.post_lens_capture({"cols": 9, "rows": 6, "square_mm": 25}, {})
    assert st["views"] == len(PATTERN_POSES)
    with pytest.raises(a.ApiError, match="same view"):
        a.post_lens_capture({}, {})
    _show(api, pattern=None)
    st = a.post_lens_solve({}, {})
    assert st["lens"]["rms_px"] < 0.5
    # The board is refitted through the lens; the orientation must be confirmed again.
    assert not a.draft.confirmed and any("lens model changed" in n for n in a.draft.notes)
    assert a.draft.grid_error["mean_px"] < before["mean_px"]
    a.post_orientation({"confirm": True}, {})
    _show(api, markers=False)
    a.post_reference({"frames": 2}, {})
    _show(api, preset="start")
    assert a.post_autotune({"expected": "start"}, {})["correct"] == 64
    saved = a.post_save({"robot": {"origin_twin_mm": [600, 0, -160]}}, {})["saved"]
    assert saved["camera"]["intrinsics"]["model"] == lensmod.MODEL
    assert api._board.lens is not None  # the running service uses it at once
    assert a.get_lens_preview({})[0] == "image/jpeg"
    # Clearing the model refits without it.
    a.post_lens_clear({"views": True, "model": True}, {})
    assert a.draft.lens is None and a.draft.summary()["lens_views"] == 0
