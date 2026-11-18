from __future__ import annotations

import math

import numpy as np
import pytest
from comet_synth import SPECS, comet_image

from nd2utils.comet import CometParams, analyze, describe, huang_threshold


def _java_huang(data: list[int]) -> int:
    """Line-by-line port of ImageJ AutoThresholder.Huang, the reference."""
    first = next((i for i in range(256) if data[i] != 0), 0)
    last = 255
    for ih in range(255, first - 1, -1):
        if data[ih] != 0:
            last = ih
            break
    if last == first:
        return first
    term = 1.0 / (last - first)
    mu0 = [0.0] * 256
    s = n = 0.0
    for ih in range(first, 256):
        s += ih * data[ih]
        n += data[ih]
        mu0[ih] = s / n
    mu1 = [0.0] * 256
    s = n = 0.0
    for ih in range(last, 0, -1):
        s += ih * data[ih]
        n += data[ih]
        mu1[ih - 1] = s / n
    best, thr = math.inf, -1
    for it in range(256):
        ent = 0.0
        for ih in range(256):
            mu = 1.0 / (1.0 + term * abs(ih - (mu0[it] if ih <= it else mu1[it])))
            if not (mu < 1e-6 or mu > 0.999999):
                ent += data[ih] * (-mu * math.log(mu) - (1 - mu) * math.log(1 - mu))
        if ent < best:
            best, thr = ent, it
    return thr


def test_huang_matches_imagej():
    rng = np.random.default_rng(7)
    for _ in range(12):
        a = np.concatenate([rng.normal(rng.uniform(5, 60), rng.uniform(2, 15), 20000), rng.normal(rng.uniform(80, 220), rng.uniform(5, 40), 3000)])
        hist = np.bincount(np.clip(a, 0, 255).astype(int), minlength=256)
        assert huang_threshold(hist) == _java_huang([int(v) for v in hist])


@pytest.fixture(scope="module")
def result():
    img, truth = comet_image(SPECS)
    return analyze([img], CometParams()), truth


def test_finds_every_comet_with_its_head(result):
    res, truth = result
    comets = [c for c in res["comets"] if c["status"] != "invalid"]
    assert len(comets) == len(SPECS)
    for t in truth:
        nearest = min(comets, key=lambda c: (c["head"]["cx"] - t["cx"]) ** 2 + (c["head"]["cy"] - t["cy"]) ** 2)
        assert abs(nearest["head"]["cx"] - t["cx"]) <= 3 and abs(nearest["head"]["cy"] - t["cy"]) <= 3
        assert abs(nearest["head"]["r"] - t["r"]) <= 4


def test_tail_dna_follows_ground_truth(result):
    res, truth = result
    comets = sorted((c for c in res["comets"] if c["status"] != "invalid"), key=lambda c: (c["head"]["cy"] > 300, c["head"]["cx"]))
    expected = sorted(truth, key=lambda t: (t["cy"] > 300, t["cx"]))
    for c, t in zip(comets, expected):
        assert c["metrics"]["TailDNAPercent"] == pytest.approx(100 * t["tail_fraction"], abs=6)
    # Formulas: DNA = area × mean; percentages add up; moments from tail length and fraction.
    for c in comets:
        m = c["metrics"]
        assert m["HeadDNAPercent"] + m["TailDNAPercent"] == pytest.approx(100, abs=1e-6)
        assert m["TailMoment"] == pytest.approx(m["TailLength"] * m["TailDNAPercent"] / 100, rel=1e-3, abs=1e-3)
        assert m["CometDNA"] == pytest.approx(m["CometArea"] * m["CometIntensity"], rel=1e-6)


@pytest.mark.parametrize("tail", ["left", "up", "down"])
def test_other_directions_give_the_same_numbers(result, tail):
    base, _ = result
    img, _ = comet_image(SPECS, tail=tail)
    res = analyze([img], CometParams(tail=tail))
    a = sorted(c["metrics"]["TailDNAPercent"] for c in base["comets"] if c["status"] != "invalid")
    b = sorted(c["metrics"]["TailDNAPercent"] for c in res["comets"] if c["status"] != "invalid")
    assert a == pytest.approx(b, abs=1e-6)
    # Head positions are reported in the image as uploaded (inside the image, on a bright spot).
    for c in res["comets"]:
        if c["status"] == "invalid":
            continue
        x, y = int(c["head"]["cx"]), int(c["head"]["cy"])
        assert 0 <= x < img.shape[1] and 0 <= y < img.shape[0]
        assert img[y, x] > 150


def test_edge_and_elongated_shapes_are_rejected():
    img, _ = comet_image([(20, 300, 30, 60, 140), (500, 300, 30, 80, 140)], shape=(600, 800))  # first one is cut by the border
    # A tall bar: height ≥ 2 × width.
    img[100:220, 650:690] = 220
    res = analyze([img], CometParams())
    good = [c for c in res["comets"] if c["status"] != "invalid"]
    assert len(good) == 1 and abs(good[0]["head"]["cx"] - 500) <= 3


def test_calibrated_columns_and_statistics():
    img, _ = comet_image(SPECS[:2])
    res = analyze([img], CometParams(), um_per_px=0.5)
    m = next(c for c in res["comets"] if c["status"] != "invalid")["metrics"]
    assert m["TailLength_um"] == pytest.approx(m["TailLength"] * 0.5)
    stats = describe([1, 2, 3, 4])
    assert stats["median"] == 2.5 and stats["n"] == 4 and stats["sd"] == pytest.approx(1.2909944)
