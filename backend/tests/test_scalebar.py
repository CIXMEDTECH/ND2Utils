from __future__ import annotations

import numpy as np
import pytest

from nd2utils.render import draw_scale_bar, nice_scale_um
from nd2utils.scalebar import auto_scale_um, preset_um


@pytest.mark.parametrize(
    "mag, zoom, expected",
    [(4, None, 500), (10, 1, 200), (20, None, 100), (40, None, 50), (60, None, 20), (100, 1, 10), (100, 3, 5), (100, 5, 2)],
)
def test_presets_follow_effective_magnification(mag, zoom, expected):
    assert preset_um(mag, zoom) == expected


def test_same_field_of_view_gives_the_same_length():
    # 100x: a 512 px zoom-1 scan and a 1024 px zoom-2 scan cover the same 177 µm → same bar,
    # stepped up from the 10/5 µm presets to stay at least 8 % of the width.
    assert auto_scale_um(0.3453, 512, 100, 1.0)[0] == 20
    assert auto_scale_um(0.1726, 1024, 100, 2.0)[0] == 20
    # zoom 3 → 300x effective → 5 µm, already wide enough on 512 px
    assert auto_scale_um(0.1151, 512, 100, 3.0)[0] == 5
    # a 2048 px 100x tile (132 µm): 10 µm would be 155 px < 8 % → 20 µm
    assert auto_scale_um(0.0645, 2048, 100, 1.0)[0] == 20


def test_too_long_preset_steps_down_the_ladder():
    um, px = auto_scale_um(1.6, 512, 4)  # 500 µm would be 312 px > 40 %
    assert um == 200 and px <= 512 * 0.4


def test_tiny_bar_steps_up():
    um, px = auto_scale_um(0.05, 2048, 10)  # 200 µm = 4000 px → down; never below 24 px
    assert px >= 24 and px <= 2048 * 0.4


def test_without_magnification_falls_back_to_width_rule():
    assert auto_scale_um(0.5, 600)[0] == nice_scale_um(0.5, 600)[0]


def test_forced_length_and_uncalibrated():
    assert auto_scale_um(0.2, 800, 100, length_um=20)[0] == 20
    assert auto_scale_um(0, 800, 100) is None


def test_draw_scale_bar_scales_with_image():
    small = draw_scale_bar(np.zeros((256, 256, 3), np.uint8), 0.3, magnification=100)
    large = draw_scale_bar(np.zeros((2048, 2048, 3), np.uint8), 0.0375, magnification=100)
    # The label box grows with the image: more bright pixels on the large one.
    assert (large > 200).sum() > 4 * (small > 200).sum()
