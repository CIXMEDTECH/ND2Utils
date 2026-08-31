from __future__ import annotations

import numpy as np
import tifffile

from nd2utils.export_jobs import _archive_name, _coord_tag, _export_filename, _safe_stem, _write_display_tiff


def test_safe_stem_strips_extension_and_odd_chars():
    assert _safe_stem("MB2310345.nd2") == "MB2310345"
    assert _safe_stem("exp 01 (rep).nd2") == "exp_01__rep_"
    assert _safe_stem("") == "nd2"


def test_coord_tag_is_one_based_and_skips_singleton_axes():
    assert _coord_tag(0, 0, 0, {"C": 3, "Y": 512, "X": 512}) == ""
    assert _coord_tag(2, 4, 0, {"T": 10, "Z": 12, "Y": 64, "X": 64}) == "T003_Z005"
    assert _coord_tag(0, 0, 8, {"P": 12, "Y": 64, "X": 64}) == "XY09"


def test_export_filename_joins_optional_parts():
    assert _export_filename("MB2310345", ext="tif") == "MB2310345.tif"
    assert _export_filename("MB2310345", role="DAPI", ext="tif") == "MB2310345_DAPI.tif"
    assert (
        _export_filename("MB2310345", tag="T001_Z003", role="composite", ext="ome.tif")
        == "MB2310345_T001_Z003_composite.ome.tif"
    )
    assert _export_filename("MB2310345", role="metadata", ext="json") == "MB2310345_metadata.json"


def test_archive_name_uses_stems_format_and_timestamp():
    created = 1756630800.0  # 2025-08-31 09:00 UTC-ish; localtime varies
    one = _archive_name(["MB2310345"], "tiff", created, "abc123def")
    assert one.startswith("MB2310345_TIFF_")
    assert one.endswith(".zip")
    two = _archive_name(["MB2310345", "MB2310344"], "ome-tiff", created, "abc123def")
    assert "MB2310345_MB2310344_OME-TIFF_" in two
    many = _archive_name(["A", "B", "C"], "png", created, "abc123def")
    assert many.startswith("A_and_2_more_PNG_")


def test_display_tiff_scales_normalized_float_rgb(tmp_path):
    rgb = np.zeros((12, 12, 3), dtype=np.float32)
    rgb[..., 1] = 0.75
    path = tmp_path / "normalized.tif"

    _write_display_tiff(path, rgb)

    saved = tifffile.imread(path)
    assert saved.dtype == np.uint8
    assert saved.shape == (12, 12, 3)
    assert int(saved[..., 1].max()) >= 190
    assert int(saved[..., 0].max()) == 0
