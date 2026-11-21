from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from edu_synth import edu_field

from nd2utils import edu

DEMO = Path(__file__).resolve().parents[2] / "ND2demo" / "EdU"


def test_synthetic_counts_both_modes():
    dapi, edu_img, truth = edu_field()
    res = edu.analyze(dapi, edu_img, edu.EduParams())
    means = [n["edu"] for n in res["nuclei"]]
    c = edu.counts(means, res["auto_thresholds"]["li"], {}, len(res["edu_objects"]), [])
    # Touching nuclei are split; every nucleus is found once.
    assert abs(c["nuclei"] - truth["nuclei"]) <= 2
    assert abs(c["positive"] - truth["positive"]) <= 1
    # Independent counting also counts EdU specks outside nuclei; nucleus counting does not.
    assert c["independent"] == pytest.approx(truth["positive"] + truth["debris"], abs=2)
    assert c["ratio"] == pytest.approx(truth["positive"] / truth["nuclei"], abs=0.02)
    # Outlines are flat [x, y, …] lists around the centre.
    n = res["nuclei"][0]
    xs, ys = n["outline"][::2], n["outline"][1::2]
    assert len(xs) >= 6 and min(xs) <= n["cx"] <= max(xs) and min(ys) <= n["cy"] <= max(ys)


def test_without_splitting_touching_nuclei_merge():
    dapi, edu_img, truth = edu_field(touching=6)
    res = edu.analyze(dapi, edu_img, edu.EduParams(split_touching=False))
    assert len(res["nuclei"]) <= truth["nuclei"] - 4


def test_parameters_are_clamped_and_split():
    p = edu.EduParams.from_dict({"nucleus_factor": 99, "edu_method": "bogus", "min_area": "-5", "split_touching": 0, "edu_channel": "2"})
    assert p.nucleus_factor == 5.0 and p.edu_method == "li" and p.min_area == 0 and p.split_touching is False and p.edu_channel == 2
    a = edu.segmentation_key({"edu_threshold": 10, "count_mode": "independent"})
    b = edu.segmentation_key({"edu_threshold": 99})
    assert a == b  # classification parameters never invalidate hand edits


def test_classify_marks_and_thresholds():
    means = [1, 2, 3, 50, 60, 70]
    assert edu.classify(means, 10, {"1": "positive", "6": "excluded"}) == ["positive", "negative", "negative", "positive", "positive", "excluded"]
    c = edu.counts(means, 10, {"6": "excluded"}, 4, [1])
    assert c["nuclei"] == 5 and c["positive"] == 2 and c["independent"] == 3 and c["excluded"] == 1
    bimodal = list(np.r_[np.random.default_rng(1).normal(5, 1, 200), np.random.default_rng(2).normal(80, 10, 50)])
    for method in ("li", "log-otsu", "otsu"):
        t = edu.auto_threshold(bimodal, method)
        assert 48 <= sum(v > t for v in bimodal) <= 52, (method, t)
    assert edu.auto_threshold([3.0], "li") is None


def _rec(fid, name, channels, folder="exp"):
    return {"id": fid, "name": name, "folder": folder, "channels": channels}


def _ch(name, color=None):
    return {"index": 0, "name": name, "color": color or [255, 255, 255]}


def test_pairing_single_channel_files():
    files = [
        _rec("a", "2940+3247_0066_DAPI.tiff", [_ch("DAPI", [0, 0, 255])]),
        _rec("b", "2940+3247_0066_GFP.tiff", [_ch("GFP", [0, 255, 0])]),
        _rec("c", "2940+3247_0067_DAPI.tiff", [_ch("DAPI", [0, 0, 255])]),
        _rec("d", "2940+3247_0067_GFP.tiff", [_ch("GFP", [0, 255, 0])]),
        _rec("e", "lonely_DAPI.tif", [_ch("DAPI")]),
        _rec("f", "well1_ch00.tif", [_ch("Channel 1", [0, 0, 255])]),
        _rec("g", "well1_ch01.tif", [_ch("Channel 2", [255, 0, 0])]),
        # Same stem in another folder: not paired across folders.
        _rec("h", "2940+3247_0066_GFP.tiff", [_ch("GFP", [0, 255, 0])], folder="other"),
    ]
    units, unpaired = edu.pair_files(files)
    pairs = {u["file_id"]: u["partner"] for u in units}
    assert pairs == {"a": "b", "c": "d", "f": "g"}
    assert {u["name"] for u in units} == {"2940+3247_0066", "2940+3247_0067", "well1"}
    reasons = {u["file_id"]: u["reason"] for u in unpaired}
    assert reasons == {"e": "no_edu", "h": "no_nucleus"}


def test_pairing_prefers_requested_colour_and_multichannel():
    files = [
        _rec("a", "x_DAPI.tif", [_ch("DAPI")]),
        _rec("b", "x_GFP.tif", [_ch("GFP")]),
        _rec("c", "x_RFP.tif", [_ch("RFP")]),
        _rec("m", "multi.nd2", [{"index": 0, "name": "DAPI", "color": [0, 0, 255]}, {"index": 1, "name": "Alexa Fluor 594", "color": [255, 0, 0]}]),
        _rec("n", "nonuc.nd2", [{"index": 0, "name": "GFP", "color": [0, 255, 0]}, {"index": 1, "name": "RFP", "color": [255, 0, 0]}]),
    ]
    units, unpaired = edu.pair_files(files, "red")
    assert {u["file_id"]: u["partner"] for u in units} == {"a": "c", "m": None}
    assert [u["reason"] for u in unpaired] == ["no_nucleus"]
    units, _ = edu.pair_files(files, "auto")
    assert {u["file_id"]: u["partner"] for u in units}["a"] == "b"  # green first
    p = edu.EduParams()
    assert edu.resolve_channels(files[3]["channels"], "multi.nd2", p) == (0, 1)


@pytest.mark.skipif(not DEMO.is_dir(), reason="ND2demo fixtures are local-only")
def test_demo_evos_fields():
    import tifffile

    stems = sorted({p.name.rsplit("_", 1)[0] for p in DEMO.glob("*_DAPI.tiff")})
    assert stems
    for stem in stems:
        dapi = tifffile.imread(DEMO / f"{stem}_DAPI.tiff")
        gfp = tifffile.imread(DEMO / f"{stem}_GFP.tiff")
        res = edu.analyze(dapi, gfp)
        means = [n["edu"] for n in res["nuclei"]]
        c = edu.counts(means, res["auto_thresholds"]["li"], {}, len(res["edu_objects"]), [])
        assert 900 <= c["nuclei"] <= 1900, (stem, c)
        assert 0.15 <= c["ratio"] <= 0.35, (stem, c)
        assert 0.12 <= c["ratio_independent"] <= 0.35, (stem, c)
