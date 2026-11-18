"""Synthetic comet images with known geometry (shared by tests and manual checks)."""
from __future__ import annotations

import numpy as np


def comet_image(specs, shape=(768, 1024), background=18.0, noise=3.0, seed=0, tail="right"):
    """specs: list of (cx, cy, head_r, tail_len, tail_peak). Returns uint16-ish float image and
    the true head/tail DNA (sum above background) per comet."""
    rng = np.random.default_rng(seed)
    h, w = shape
    img = np.full(shape, background, np.float64)
    yy, xx = np.mgrid[0:h, 0:w]
    truth = []
    for cx, cy, r, length, peak in specs:
        head = 200.0 * np.clip(1.0 - ((xx - cx) ** 2 + (yy - cy) ** 2) / (r * r), 0, None) ** 0.5
        # Tail: starts at the head centre, decays to the right, narrows slowly.
        dx = xx - cx
        half_w = r * (1.0 - 0.35 * np.clip(dx / max(length, 1), 0, 1))
        inside = (dx > 0) & (dx < length) & (np.abs(yy - cy) < half_w)
        tail_profile = peak * np.exp(-1.5 * np.clip(dx, 0, None) / max(length, 1)) * np.clip(1 - (np.abs(yy - cy) / np.maximum(half_w, 1)) ** 2, 0, None)
        tail_signal = np.where(inside, tail_profile, 0.0)
        head_signal = head
        img += head_signal + tail_signal * (head_signal < 1)
        tail_dna = float((tail_signal * (head_signal < 1)).sum())
        head_dna = float(head_signal.sum())
        truth.append({"cx": cx, "cy": cy, "r": r, "tail_fraction": tail_dna / (tail_dna + head_dna)})
    img += rng.normal(0, noise, shape)
    img = np.clip(img, 0, 4095).astype(np.uint16)
    if tail == "left":
        img = img[:, ::-1]
    elif tail == "up":
        img = np.rot90(img, k=1)  # right → up
    elif tail == "down":
        img = np.rot90(img, k=-1)
    return img, truth


SPECS = [
    (150, 150, 30, 40, 120),
    (430, 160, 32, 120, 150),
    (720, 170, 28, 200, 170),
    (180, 500, 30, 80, 140),
    (500, 520, 31, 160, 160),
    (850, 560, 29, 10, 20),
]
