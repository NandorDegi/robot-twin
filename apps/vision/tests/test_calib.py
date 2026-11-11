"""Calibration wizard tests: geometry, orientation, reference, auto-tune and the
versioned calibration file. Synthetic images only (no camera)."""

import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
cv2 = pytest.importorskip("cv2")

from vision import calib, calib_api  # noqa: E402
from vision.board import Board, detect_aruco_marker, square_name  # noqa: E402
from vision.pieces import square_of_pixel  # noqa: E402
from vision.synthetic import TRUE_CORNERS, SyntheticCamera, start_occupancy, true_homography  # noqa: E402

SQ = 40.0


def cam(**scene) -> SyntheticCamera:
    c = SyntheticCamera()
    c.scene.set(**scene)
    return c


def board_from(labelled) -> Board:
    b = Board()
    b.set_homography(calib.homography_from_corners(labelled, SQ))
    return b


# --- orientation and the rank/file mapping -------------------------------------


def test_true_corners_are_not_mirrored_and_ranks_mirrored_are():
    good = {n: TRUE_CORNERS[n] for n in calib.CORNERS}
    assert not calib.is_mirrored(good)
    # The past bug: ranks mirrored (a1 <-> a8, h1 <-> h8).
    ranks_mirrored = {"a1": good["a8"], "h1": good["h8"], "h8": good["h1"], "a8": good["a1"]}
    assert calib.is_mirrored(ranks_mirrored)
    files_mirrored = {"a1": good["h1"], "h1": good["a1"], "h8": good["a8"], "a8": good["h8"]}
    assert calib.is_mirrored(files_mirrored)


def test_homography_maps_squares_and_robot_targets_correctly():
    b = board_from({n: TRUE_CORNERS[n] for n in calib.CORNERS})
    H_true = true_homography()
    for r, f in [(0, 0), (7, 0), (0, 7), (7, 7), (3, 4)]:
        # A piece in the centre of the square, in the image, maps back to that square.
        px = calib.project(H_true, [((f + 0.5) * SQ, (7 - r + 0.5) * SQ)])[0]
        assert square_of_pixel(px, b) == [r, f]
        assert b.robot_target_of_pixel(px) == pytest.approx(b.square_target(r, f), abs=0.5)
    # a8 must never get the target of a1 (the rank-mirroring bug).
    a8 = calib.project(H_true, [(0.5 * SQ, 0.5 * SQ)])[0]
    assert square_name(*square_of_pixel(a8, b)) == "a8"
    assert b.robot_target_of_pixel(a8) != pytest.approx(b.square_target(0, 0), abs=5)


def test_rank_mirrored_labels_would_swap_a1_and_a8():
    good = {n: TRUE_CORNERS[n] for n in calib.CORNERS}
    bad = board_from({"a1": good["a8"], "h1": good["h8"], "h8": good["h1"], "a8": good["a1"]})
    a8 = calib.project(true_homography(), [(0.5 * SQ, 0.5 * SQ)])[0]
    assert square_name(*square_of_pixel(a8, bad)) == "a1"  # what the check prevents


@pytest.mark.parametrize("a1_at", [0, 1, 2, 3])
def test_label_corners_follows_the_orientation_rule(a1_at):
    names = list(calib.CORNERS)
    raw = [TRUE_CORNERS[n] for n in names]
    perm = [3, 0, 2, 1]  # shuffled input order
    shuffled = [raw[i] for i in perm]
    a1_index = perm.index(a1_at)
    lab = calib.label_corners(shuffled, a1_index)
    assert not calib.is_mirrored(lab)
    assert lab["a1"] == pytest.approx(list(raw[a1_at]))
    # The other corners follow counterclockwise on the screen.
    for k, n in enumerate(names):
        assert lab[n] == pytest.approx(list(raw[(a1_at + k) % 4]))
    mirrored = calib.label_corners(shuffled, a1_index, mirrored=True)
    assert calib.is_mirrored(mirrored)
    assert mirrored["a1"] == pytest.approx(list(raw[a1_at]))


def test_grid_overlay_and_reprojection_error_on_a_synthetic_board():
    frame = cam(preset="empty", markers=False).render_now()
    H = calib.homography_from_corners({n: TRUE_CORNERS[n] for n in calib.CORNERS}, SQ)
    ov = calib.grid_overlay(H, SQ)
    assert len(ov["lines"]) == 18 and len(ov["centres"]) == 64
    assert ov["corners"]["a1"] == pytest.approx(list(TRUE_CORNERS["a1"]), abs=0.1)
    err = calib.grid_error(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), H, SQ)
    assert err["points"] >= 45 and err["mean_px"] < 1.0
    # A corner that is 15 px off gives a visibly larger error.
    off = {n: TRUE_CORNERS[n] for n in calib.CORNERS}
    off["h8"] = (off["h8"][0] + 15, off["h8"][1] + 10)
    err2 = calib.grid_error(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), calib.homography_from_corners(off, SQ), SQ)
    assert err2["mean_px"] is None or err2["mean_px"] > err["mean_px"] + 1


def test_detect_board_with_aruco_markers():
    frame = cam(preset="empty", markers=True).render_now()
    det = calib.detect_board(frame, SQ, "aruco", aruco=detect_aruco_marker)
    assert det["ok"] and det["method"] == "aruco"
    lab = calib.label_corners(det["raw_corners"], det["a1_index"])
    for n in calib.CORNERS:
        assert lab[n] == pytest.approx(list(TRUE_CORNERS[n]), abs=1.5)
    assert not det["markers_mirrored"]


def test_detect_board_from_the_chessboard_finds_a1_by_the_dark_square():
    frame = cam(preset="empty", markers=False).render_now()
    det = calib.detect_board(frame, SQ, "chessboard")
    assert det["ok"] and det["method"] == "chessboard"
    lab = calib.label_corners(det["raw_corners"], det["a1_index"])
    for n in calib.CORNERS:
        assert lab[n] == pytest.approx(list(TRUE_CORNERS[n]), abs=1.5)
    H = calib.homography_from_corners(lab, SQ, det["inner"])
    assert calib.parity_score(calib.topdown_grey(frame, H, SQ), SQ, 2.0) < 0  # a1 dark
    # Rotating a1 by one corner makes a1 light: the check sees it.
    lab2 = calib.label_corners(det["raw_corners"], (det["a1_index"] + 1) % 4)
    H2 = calib.homography_from_corners(lab2, SQ)
    assert calib.parity_score(calib.topdown_grey(frame, H2, SQ), SQ, 2.0) > 0


# --- reference and thresholds --------------------------------------------------


def true_board() -> Board:
    return board_from({n: TRUE_CORNERS[n] for n in calib.CORNERS})


def test_reference_stats_clean_and_with_glare():
    b = true_board()
    clean = calib.reference_stats(b, cam(preset="empty", markers=False).render_now())
    assert clean["warnings"] == []
    assert clean["contrast"] > 60
    assert len(clean["squares"]) == 64 and clean["squares"]["a1"]["dark"]
    glare = calib.reference_stats(b, cam(preset="empty", markers=False, glare=True).render_now())
    assert any(w.startswith("glare") for w in glare["warnings"])
    shadow = calib.reference_stats(b, cam(preset="empty", markers=False, shadow=True).render_now())
    assert any(w.startswith("shadow") for w in shadow["warnings"])


def test_autotune_reads_the_start_position_from_bad_thresholds():
    b = true_board()
    ref = cam(preset="empty", markers=False).render_now()
    frame = cam(preset="start", markers=False).render_now()
    bad = {"diff": 150.0, "occupied_fraction": 0.9, "white": 250.0}
    assert calib.score_position(b.board_state(frame, ref, bad)["squares"], calib.start_position())["correct"] < 64
    res = calib.autotune(b, frame, ref, calib.start_position())
    assert res["correct"] == 64 and res["pieces_correct"] == 32 and res["errors"] == []
    assert res["occupancy_margin"] > 0 and res["colour_margin"] > 0
    # The tuned thresholds also read another position (after 1. e4 e5).
    occ = start_occupancy()
    occ["e4"], occ["e2"], occ["e5"], occ["e7"] = "w", None, "b", None
    c = cam(markers=False, pieces=occ)
    st = b.board_state(c.render_now(), ref, res["thresholds"], details=True)
    assert calib.score_position(st["squares"], occ)["correct"] == 64
    assert min(d["confidence"] for d in st["details"].values()) > 0.2


def test_autotune_under_dimmer_light():
    b = true_board()
    ref = cam(preset="empty", markers=False, light=0.8).render_now()
    frame = cam(preset="start", markers=False, light=0.8).render_now()
    res = calib.autotune(b, frame, ref, calib.start_position())
    assert res["correct"] == 64


# --- the calibration file --------------------------------------------------------


def doc_complete(validated=False):
    d = {
        "schema": calib.SCHEMA,
        "board": {"square_mm": 40.0, "homography": true_homography().tolist(), "orientation": {"confirmed": True}},
        "reference": {"image": "x.png"},
        "thresholds": {"diff": 30, "occupied_fraction": 0.2, "white": 120},
        "robot": {"origin_twin_mm": [600, 0, -160], "rotation_deg": 2.0, "square_mm": 40.0},
    }
    return d


def test_store_save_versions_validation_and_rollback(tmp_path):
    st = calib.CalibrationStore(str(tmp_path / "calibration.json"))
    assert st.load() is None and st.versions() == []
    ref = np.full((20, 20, 3), 100, np.uint8)
    d1 = st.save({**doc_complete(), "operator_note": "first"}, ref)
    assert d1["revision"] == 1 and os.path.exists(st.resolve(d1["reference"]["image"]))
    assert calib.completeness(st.load()) == ["not validated (run the final check)"]
    st.set_validation(1, {"passed": True})
    assert calib.completeness(st.load()) == []
    d2 = st.save({**doc_complete(), "operator_note": "second", "thresholds": {"diff": 99}}, ref)
    assert d2["revision"] == 2 and "validation" not in d2
    assert [v["revision"] for v in st.versions()] == [1, 2]
    with pytest.raises(ValueError):
        st.set_validation(1, {"passed": True})  # not the active revision
    d3 = st.rollback(1)
    assert d3["revision"] == 3 and d3["rolled_back_from"] == 1
    assert st.load()["thresholds"] == {"diff": 30, "occupied_fraction": 0.2, "white": 120}
    assert calib.completeness(st.load()) == []  # the check of r1 carries over
    assert [v["revision"] for v in st.versions()] == [1, 2, 3]
    with pytest.raises(FileNotFoundError):
        st.rollback(42)
    # The history files are complete documents.
    with open(tmp_path / "calibration.d" / "calibration-r0002.json") as f:
        assert json.load(f)["operator_note"] == "second"


def test_completeness_reasons():
    assert calib.completeness(None) == ["no calibration file"]
    assert "old calibration format" in calib.completeness({"H": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "square": 40})[0]
    d = doc_complete()
    d["robot"] = {}
    d["board"]["orientation"]["confirmed"] = False
    r = calib.completeness(d)
    assert "no board pose in the robot frame" in r and "board orientation not confirmed" in r


def test_apply_to_board_and_legacy_board_file(tmp_path):
    b = Board()
    calib.apply_to_board(doc_complete(), b)
    assert b.calibrated and b.thresholds["diff"] == 30 and b.pose["rotation_deg"] == 2.0
    assert b.pose["origin"] == [600, 0, -160]
    # Board.load reads the wizard file; Board.save never overwrites it.
    p = tmp_path / "calibration.json"
    p.write_text(json.dumps(doc_complete()))
    b2 = Board()
    assert b2.load(str(p)) and b2.calibrated
    with pytest.raises(RuntimeError):
        b2.save(str(p))
    # The old format still loads.
    old = tmp_path / "old.json"
    old.write_text(json.dumps({"H": true_homography().tolist(), "square": 40}))
    b3 = Board()
    calib.apply_to_board(json.loads(old.read_text()), b3)
    assert b3.calibrated


# --- the HTTP handlers with a synthetic camera ------------------------------------


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


def test_wizard_flow_through_the_handlers(api):
    a = calib_api
    api._camera.scene.set(preset="empty", markers=True)
    api._camera.refresh()
    with pytest.raises(a.ApiError):
        a.post_save({"robot": {"origin_twin_mm": [600, 0, -160]}}, {})  # nothing yet
    det = a.post_detect_board({"method": "auto"}, {})
    assert det["ok"] and det["method"] == "aruco" and det["a1_dark"]
    with pytest.raises(a.ApiError):
        a.post_save({"robot": {"origin_twin_mm": [600, 0, -160]}}, {})  # orientation not confirmed
    a.post_orientation({"confirm": True}, {})
    api._camera.scene.set(markers=False)
    a.post_reference({"frames": 3}, {})
    api._camera.scene.set(preset="start")
    tuned = a.post_autotune({"expected": "start"}, {})
    assert tuned["correct"] == 64
    with pytest.raises(a.ApiError):
        a.post_save({"robot": {"origin_twin_mm": [1e6, 0, 0]}}, {})  # out of range
    saved = a.post_save({"note": "test", "robot": {"origin_twin_mm": [600, 0, -160], "rotation_deg": 0}}, {})
    rev = saved["saved"]["revision"]
    assert saved["status"]["reasons"] == ["not validated (run the final check)"]
    assert api._reference is not None and api._board.calibrated  # active without a restart
    v = a.post_validate({"revision": rev, "reachability": {"reachable": 65, "total": 65}}, {})
    assert v["validation"]["passed"] and v["status"]["complete"]
    # One piece off the board: the final check fails.
    api._camera.scene.set(moves=[["e2", "e9"]])
    v2 = a.post_validate({"revision": rev, "reachability": {"reachable": 65, "total": 65}}, {})
    assert not v2["validation"]["passed"] and v2["validation"]["start_position"]["pieces_correct"] == 31


def test_manual_corners_refuse_the_mirrored_order(api):
    a = calib_api
    api._camera.refresh()
    good = [list(TRUE_CORNERS[n]) for n in calib.CORNERS]
    ranks_mirrored = [good[3], good[2], good[1], good[0]]  # a8, h8, h1, a1 clicked as a1, h1, h8, a8
    with pytest.raises(a.ApiError, match="mirrored"):
        a.post_corners({"corners": ranks_mirrored}, {})
    res = a.post_corners({"corners": good}, {})
    assert res["labelled"]["a1"] == pytest.approx(good[0]) and res["a1_dark"]
    with pytest.raises(a.ApiError):
        a.post_corners({"corners": [[0, 0], [1, 0], [1, 1], [0, 1]]}, {})  # too small
    with pytest.raises(a.ApiError):
        a.post_thresholds({"diff": 1000}, {})


def test_sim_scene_takes_a_whole_position(api):
    a = calib_api
    out = a.post_sim_scene({"pieces": {"e4": "w", "e5": "b"}}, {})
    assert out["pieces"] == {"e4": "w", "e5": "b"}
    with pytest.raises(a.ApiError):
        a.post_sim_scene({"pieces": {"e9": "w"}}, {})
    with pytest.raises(a.ApiError):
        a.post_sim_scene({"pieces": {"e4": "q"}}, {})
