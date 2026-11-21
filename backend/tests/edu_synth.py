"""Synthetic EdU fields: round nuclei (some touching) in a nuclear channel, a known subset of
them EdU-positive in the EdU channel, plus a few EdU-bright specks outside any nucleus."""

from __future__ import annotations

import numpy as np

SIZE = 512
RADIUS = 11


def edu_field(seed: int = 3, positive_every: int = 4, touching: int = 6, debris: int = 3):
    """(dapi uint16, edu uint16, truth) with truth = {"nuclei", "positive", "debris"}."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    centers: list[tuple[float, float]] = []
    step = 40
    for gy in range(step, SIZE - step + 1, step):
        for gx in range(step, SIZE - step + 1, step):
            centers.append((gy + rng.uniform(-4, 4), gx + rng.uniform(-4, 4)))
    # Touching pairs: a second nucleus right next to some of the grid nuclei.
    for i in range(touching):
        cy, cx = centers[i * 7 + 3]
        centers.append((cy, cx + 1.8 * RADIUS))
    dapi = np.full((SIZE, SIZE), 40.0) + 0.05 * xx  # uneven background
    edu = np.full((SIZE, SIZE), 30.0) + 0.04 * yy
    positive = 0
    for i, (cy, cx) in enumerate(centers):
        r = RADIUS * rng.uniform(0.9, 1.1)
        disc = (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r
        dapi[disc] = np.maximum(dapi[disc], 600 + rng.uniform(-80, 80))
        if i % positive_every == 0:
            edu[disc] += 500 + rng.uniform(-150, 150)
            positive += 1
        else:
            edu[disc] += rng.uniform(0, 20)
    # EdU-bright specks between nuclei (dust, cytoplasmic signal): no DAPI.
    for k in range(debris):
        cy, cx = step * (k + 1) + step / 2, step / 2 + 4
        disc = (yy - cy) ** 2 + (xx - cx) ** 2 <= (0.8 * RADIUS) ** 2
        edu[disc] += 450
    dapi += rng.normal(0, 6, dapi.shape)
    edu += rng.normal(0, 6, edu.shape)
    truth = {"nuclei": len(centers), "positive": positive, "debris": debris}
    return np.clip(dapi, 0, 4095).astype(np.uint16), np.clip(edu, 0, 4095).astype(np.uint16), truth
