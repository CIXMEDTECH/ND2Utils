from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import tifffile
from conftest import ROOT

from nd2utils import naming, prepare, store

EVOS_JSON = {
    "Objective NA": 0.65,
    "ObjectiveSettings": {"Manufacturer": "EVOS", "PartNumber": "AMEP4935", "Magnification": 40.0, "NumericalAperture": 0.65},
    "Software": "Evos2 1.4",
    "MicronsPerPixel": 0.15537301516224949,
    "ChannelSettings": {"Name": "RFP", "Color": "#ffff0000"},
    "EpiChannelSettings": {"PseudoColor": "#ffff0000", "PseudoColorEnabled": True},
    "Emission Wavelength": 593.0,
}


def _evos_description(width: int, height: int, fov: float) -> str:
    return (
        '<?xml version="1.0" encoding="utf-16"?>\r\n'
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        '<Instrument ID="Instrument:1"><Microscope Manufacturer="Thermo Fisher Scientific" Model="EVOS M5000" /></Instrument>'
        '<Image ID="Image:1" Name="oe_-_40x_0008_RFP"><AcquisitionDate>2020-11-18T06:07:52</AcquisitionDate>'
        f'<Pixels ID="Pixels:1" DimensionOrder="XYZCT" Type="uint16" SizeX="{width}" SizeY="{height}" SizeZ="1" SizeC="1" SizeT="1" '
        f'PhysicalSizeX="{fov}" PhysicalSizeY="{fov * height / width}" PhysicalSizeZ="1">'
        '<Channel ID="Channel:RFP" Name="RFP" SamplesPerPixel="1" /><TiffData /></Pixels></Image></OME>\r\n'
        f"<!--\r\n{json.dumps(EVOS_JSON, indent=2)}\r\n-->"
    )


def _upload(client, path: Path, folder: str = "evos") -> dict:
    with path.open("rb") as fh:
        r = client.post("/api/files", params={"folder": folder}, files={"file": (path.name, fh)})
    assert r.status_code == 200, r.text
    return client.get(f"/api/files/{r.json()['id']}").json()


def _palette_tiff(path: Path, description: str | None) -> None:
    data = (np.arange(256 * 320, dtype=np.uint32).reshape(256, 320) % 256).astype(np.uint8)
    cmap = np.zeros((3, 256), np.uint16)
    cmap[0] = np.arange(256) * 257  # black → red ramp
    tifffile.imwrite(path, data, photometric="palette", colormap=cmap, description=description)


def test_evos_tiff_metadata(client, tmp_path):
    path = tmp_path / "oe_-_40x_0008_RFP.tiff"
    _palette_tiff(path, _evos_description(320, 256, 0.15537301516224949 * 320))
    rec = _upload(client, path)
    ch = rec["channels"][0]
    assert ch["name"] == "RFP" and ch["color"] == [255, 0, 0] and ch["emission_nm"] == 593.0
    assert rec["voxel_um"][0] == pytest.approx(0.155373, rel=1e-4) and rec["calibrated"] is True
    assert rec["magnification"] == 40 and rec["na"] == 0.65
    assert "40x" in rec["objective"] and "EVOS" in rec["instrument"]
    assert "MicronsPerPixel" in rec["text_info"]["Acquisition"]


def test_field_width_in_physical_size_is_converted(client, tmp_path):
    path = tmp_path / "fov.tif"
    desc = _evos_description(320, 256, 50.0).split("<!--")[0]  # OME only, no vendor JSON
    _palette_tiff(path, desc)
    rec = _upload(client, path)
    assert rec["voxel_um"][0] == pytest.approx(50.0 / 320)


def test_palette_colour_and_file_name_hints(client, tmp_path):
    path = tmp_path / "well3_20x_GFP.tif"
    tifffile.imwrite(path, np.zeros((64, 64), np.uint16))
    rec = _upload(client, path)
    assert rec["magnification"] == 20 and rec["magnification_source"] == "filename"
    assert rec["channels"][0]["name"] == "GFP" and rec["channels"][0]["color"] == [0, 255, 0]
    # A palette image without metadata takes its colour from the colormap.
    path2 = tmp_path / "plain.tif"
    _palette_tiff(path2, None)
    assert _upload(client, path2)["channels"][0]["color"] == [255, 0, 0]


def test_name_hints():
    assert naming.magnification_from_name("oe_-_4x_0008_RFP.tiff") == 4
    assert naming.magnification_from_name("img_100X.tif") == 100
    assert naming.magnification_from_name("sample_2024x.tif") is None
    assert naming.magnification_from_name("cell_1x2.tif") is None
    assert naming.fluor_from_name("a_DAPI.tif")[1] == [0, 0, 255]


def test_startup_refresh_upgrades_old_records(client, tmp_path):
    path = tmp_path / "oe_-_40x_0009_RFP.tiff"
    _palette_tiff(path, _evos_description(320, 256, 0.15537301516224949 * 320))
    rec = _upload(client, path)
    # As an older version stored it: generic channel, no optics, no revision.
    store.patch_files({rec["id"]: {"channels": [{**rec["channels"][0], "name": "Channel 1", "color": [255, 255, 255]}], "magnification": None, "meta_rev": 0}})
    prepare.backfill_metadata()
    fresh = client.get(f"/api/files/{rec['id']}").json()
    assert fresh["channels"][0]["name"] == "RFP" and fresh["channels"][0]["color"] == [255, 0, 0]
    assert fresh["magnification"] == 40 and fresh["meta_rev"] == prepare.META_REV


@pytest.mark.skipif(not (ROOT / "ND2demo" / "TIF").is_dir(), reason="local EVOS samples")
def test_real_evos_samples(client):
    for path in sorted((ROOT / "ND2demo" / "TIF").glob("*.tif*")):
        rec = _upload(client, path, "real")
        expected = naming.magnification_from_name(path.name)
        assert rec["magnification"] == expected and rec["channels"][0]["color"] == [255, 0, 0]
        assert rec["voxel_um"][0] < 2
