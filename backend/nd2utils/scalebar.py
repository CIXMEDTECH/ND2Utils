"""Scale bar length chosen from the optics, so every image of one magnification gets the same bar.

The length comes from the effective magnification (objective × confocal zoom):

    ≤5x 500 µm · ≤12x 200 · ≤25x 100 · ≤45x 50 · ≤70x 20 · ≤150x 10 · ≤350x 5 · above 2 µm

and is moved along the 1-2-5 ladder only when it would be wider than 40 % of the image or
shorter than 8 % of it (at least 24 px) — readable on large fields of view as well. Without a magnification the old rule (about a sixth of the width) applies.
The frontend has the same table in src/lib/scalebar.ts.
"""

from __future__ import annotations

import math

PRESETS: tuple[tuple[float, float], ...] = (
    (5, 500),
    (12, 200),
    (25, 100),
    (45, 50),
    (70, 20),
    (150, 10),
    (350, 5),
)
FALLBACK_UM = 2.0
MIN_PX = 24
MIN_FRACTION = 0.08
MAX_FRACTION = 0.4

# 0.1 … 5000 µm in 1-2-5 steps.
LADDER: tuple[float, ...] = tuple(m * 10.0**e for e in range(-1, 4) for m in (1, 2, 5))


def effective_magnification(magnification: float | None, zoom: float | None = None) -> float | None:
    if not magnification or magnification <= 0:
        return None
    z = zoom if zoom and zoom > 0 else 1.0
    return float(magnification) * z


def preset_um(magnification: float | None, zoom: float | None = None) -> float | None:
    eff = effective_magnification(magnification, zoom)
    if eff is None:
        return None
    for limit, um in PRESETS:
        if eff <= limit:
            return float(um)
    return FALLBACK_UM


def _width_rule(um_per_px: float, width_px: int) -> float:
    target_um = min(max(width_px / 6.0, MIN_PX), max(width_px * MAX_FRACTION, 8.0)) * um_per_px
    exp = math.floor(math.log10(target_um))
    frac = target_um / 10**exp
    nice = 1.0 if frac < 1.5 else 2.0 if frac < 3.5 else 5.0 if frac < 7.5 else 10.0
    return nice * 10**exp


def _fit(um: float, um_per_px: float, width_px: int) -> float:
    """Step along the ladder until the bar fits the image (and is not a sliver)."""
    steps = list(LADDER)
    idx = min(range(len(steps)), key=lambda i: abs(math.log(steps[i] / um))) if um > 0 else 0
    while idx > 0 and steps[idx] / um_per_px > width_px * MAX_FRACTION:
        idx -= 1
    floor = max(MIN_PX, width_px * MIN_FRACTION)
    while idx < len(steps) - 1 and steps[idx] / um_per_px < floor and steps[idx + 1] / um_per_px <= width_px * MAX_FRACTION:
        idx += 1
    return steps[idx]


def auto_scale_um(
    um_per_px: float,
    width_px: int,
    magnification: float | None = None,
    zoom: float | None = None,
    length_um: float | None = None,
) -> tuple[float, int] | None:
    """(length in µm, length in px) of the bar for an image `width_px` wide, or None when the
    image is not calibrated. `length_um` forces a length (e.g. one bar for a whole figure)."""
    if not um_per_px or um_per_px <= 0 or width_px <= 0:
        return None
    if length_um and length_um > 0:
        um = float(length_um)
    else:
        preset = preset_um(magnification, zoom)
        um = _fit(preset, um_per_px, width_px) if preset else _width_rule(um_per_px, width_px)
    px = max(int(round(um / um_per_px)), 1)
    if width_px > 24 and px > width_px - 24:
        px = max(8, width_px - 24)
    return float(um), px
