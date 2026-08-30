from __future__ import annotations

import numpy as np

from nd2utils.models import LutSetting
from nd2utils.render import parse_visible_mask, preview_rgb, split_mosaic


def test_parse_visible_mask():
    assert parse_visible_mask(None, 3) is None
    assert parse_visible_mask("", 3) is None
    assert parse_visible_mask("1,0,1", 3) == [True, False, True]
    assert parse_visible_mask("1,0", 3) == [True, False, True]
    assert parse_visible_mask("true,false,on", 3) == [True, False, True]


def test_split_mosaic_skips_hidden_channels():
    planes = [
        np.full((16, 16), 80.0, np.float32),
        np.full((16, 16), 160.0, np.float32),
        np.full((16, 16), 240.0, np.float32),
    ]
    luts = [
        LutSetting(min=0, max=255, color=[255, 0, 0]),
        LutSetting(min=0, max=255, color=[0, 255, 0]),
        LutSetting(min=0, max=255, color=[0, 0, 255]),
    ]
    colors = [lut.color or [255, 255, 255] for lut in luts]
    rgb = split_mosaic(planes, luts, colors, ["DAPI", "FITC", "TRITC"], visible=[True, False, True])
    assert rgb.ndim == 3
    assert rgb.shape[2] == 3
    assert rgb.shape[0] == 16
    assert rgb.shape[1] >= 32


def test_preview_rgb_visible_changes_pixels():
    planes = [
        np.linspace(0, 200, 64, dtype=np.float32).reshape(8, 8),
        np.linspace(200, 0, 64, dtype=np.float32).reshape(8, 8),
    ]
    channels = [
        {"name": "A", "color": [255, 0, 0]},
        {"name": "B", "color": [0, 255, 0]},
    ]
    full = preview_rgb(planes, channels, composite=True, scale_bar=False)
    only_a = preview_rgb(planes, channels, composite=True, scale_bar=False, visible=[True, False])
    assert full.shape == only_a.shape
    assert not np.array_equal(full, only_a)
    split = preview_rgb(planes, channels, composite=False, scale_bar=False, visible=[True, False])
    assert split.shape[0] == 8
    assert split.shape[1] == 8
