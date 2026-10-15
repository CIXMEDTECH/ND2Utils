from __future__ import annotations

import gzip
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image

from conftest import ROOT
from nd2utils import prepare


def _write_pyramid(path: Path, data: np.ndarray, levels: int = 3) -> None:
    """A tiled pyramidal OME-TIFF (CYX, SubIFDs), like the ones written by QuPath / bfconvert."""
    with tifffile.TiffWriter(path, bigtiff=True, ome=True) as tif:
        opts = dict(tile=(128, 128), photometric="minisblack", compression="zlib")
        tif.write(
            data,
            subifds=levels - 1,
            metadata={
                "axes": "CYX",
                "Channel": {"Name": ["DAPI", "CD3", "CD8"]},
                "PhysicalSizeX": 0.5,
                "PhysicalSizeY": 0.5,
            },
            **opts,
        )
        for i in range(1, levels):
            tif.write(data[:, :: 2**i, :: 2**i], subfiletype=1, **opts)


@pytest.fixture
def pyramid_file(tmp_path: Path) -> tuple[Path, np.ndarray]:
    rng = np.random.default_rng(1)
    data = rng.integers(0, 4000, (3, 1500, 2300), dtype=np.uint16)
    path = tmp_path / "slide.ome.tif"
    _write_pyramid(path, data)
    return path, data


def _upload(client, path: Path, name: str | None = None) -> dict:
    r = client.post("/api/files", files={"file": (name or path.name, path.read_bytes(), "application/octet-stream")})
    assert r.status_code == 200, r.text
    return r.json()


def _tile(client, file_id: str, **params) -> tuple[np.ndarray, int, int, int]:
    r = client.get(f"/api/files/{file_id}/slide/tile", params=params)
    assert r.status_code == 200, r.text
    buf = r.content
    if buf[:2] == b"\x1f\x8b":
        buf = gzip.decompress(buf)
    assert buf[:4] == b"ND2P"
    n = int.from_bytes(buf[6:8], "little")
    h = int.from_bytes(buf[8:12], "little")
    w = int.from_bytes(buf[12:16], "little")
    dtype = {0: np.uint8, 1: np.uint16, 2: np.float32}[buf[16]]
    item = np.dtype(dtype).itemsize
    offset, planes = 20, []
    for _ in range(n):
        offset += 44
        planes.append(np.frombuffer(buf, dtype=dtype, count=h * w, offset=offset).reshape(h, w))
        offset += h * w * item
    return np.stack(planes), n, h, w


def test_upload_identifies_ome_tiff(client, pyramid_file):
    path, data = pyramid_file
    rec = _upload(client, path)
    assert rec["format"] == "ome-tiff"
    assert (rec["width"], rec["height"]) == (2300, 1500)
    assert [c["name"] for c in rec["channels"]] == ["DAPI", "CD3", "CD8"]
    assert rec["voxel_um"][0] == pytest.approx(0.5)
    assert rec["levels"][:3] == [[2300, 1500], [1150, 750], [575, 375]]
    # Distinct default colors even though the file stores none; DAPI is blue.
    colors = [tuple(c["color"]) for c in rec["channels"]]
    assert len(set(colors)) == 3 and colors[0][2] > colors[0][0]
    listed = client.get("/api/files").json()["files"][0]
    assert listed["format"] == "ome-tiff"


def test_slide_info_and_tiles_match_source(client, pyramid_file):
    path, data = pyramid_file
    rec = _upload(client, path)
    info = client.get(f"/api/files/{rec['id']}/slide").json()
    assert info["tile_size"] == 512 and info["sizes"]["C"] == 3
    assert [lv["width"] for lv in info["levels"]] == [2300, 1150, 575]
    assert len(info["autoscale"]) == 3
    planes, n, h, w = _tile(client, rec["id"], level=0, x=4, y=2, c="0,2")
    assert (n, h, w) == (2, 1500 - 1024, 2300 - 2048)
    assert np.array_equal(planes[0], data[0, 1024:, 2048:])
    assert np.array_equal(planes[1], data[2, 1024:, 2048:])
    planes, *_ = _tile(client, rec["id"], level=1, x=1, y=0, c="1")
    assert np.array_equal(planes[0], data[1, ::2, ::2][:512, 512:1024])
    assert client.get(f"/api/files/{rec['id']}/slide/tile", params={"level": 0, "x": 9, "y": 0}).status_code == 400
    assert client.get(f"/api/files/{rec['id']}/slide/tile", params={"level": 7, "x": 0, "y": 0}).status_code == 400
    assert client.get(f"/api/files/{rec['id']}/slide/tile", params={"level": 0, "x": 0, "y": 0, "c": "5"}).status_code == 400


def test_workspace_preview_for_slide(client, pyramid_file):
    path, _ = pyramid_file
    rec = _upload(client, path)
    prepare.wait_idle()
    assert client.get("/api/files").json()["files"][0]["prepare"] == "ready"
    r = client.get(f"/api/files/{rec['id']}/display")
    assert r.status_code == 200
    body = gzip.decompress(r.content) if r.content[:2] == b"\x1f\x8b" else r.content
    assert int.from_bytes(body[6:8], "little") == 3
    # The overview is the finest level within 2048 px.
    assert int.from_bytes(body[12:16], "little") == 1150
    img = Image.open(BytesIO(client.get(f"/api/files/{rec['id']}/preview").content))
    assert img.size == (1150, 750)
    # ND2-only tools refuse slides instead of reading gigapixel planes.
    assert client.get(f"/api/files/{rec['id']}/histogram").json()["detail"]["code"] == "slide_file"
    r = client.post("/api/export", json={"file_ids": [rec["id"]], "format": "png"})
    assert r.status_code == 400


def test_non_pyramidal_tiff_gets_virtual_levels(client, tmp_path: Path):
    rng = np.random.default_rng(2)
    rgb = rng.integers(0, 255, (3000, 2600, 3), dtype=np.uint8)
    path = tmp_path / "brightfield.tif"
    tifffile.imwrite(path, rgb, photometric="rgb", rowsperstrip=37)
    rec = _upload(client, path)
    assert rec["format"] == "tiff"
    assert [c["name"] for c in rec["channels"]] == ["Red", "Green", "Blue"]
    info = client.get(f"/api/files/{rec['id']}/slide").json()
    assert [(lv["width"], lv["virtual"]) for lv in info["levels"]] == [(2600, False), (1300, True), (650, True)]
    planes, n, h, w = _tile(client, rec["id"], level=0, x=1, y=3, c="1")
    assert np.array_equal(planes[0], rgb[1536:2048, 512:1024, 1])
    planes, *_ = _tile(client, rec["id"], level=2, x=0, y=0, c="0")
    assert planes.shape[1:] == (512, 512)


def _run_export(client, file_id: str, body: dict) -> tuple[dict, bytes]:
    r = client.post(f"/api/files/{file_id}/slide/export", json=body)
    assert r.status_code == 200, r.text
    job = client.get(f"/api/jobs/{r.json()['id']}").json()
    assert job["status"] == "done", job
    dl = client.get(f"/api/jobs/{job['id']}/download")
    assert dl.status_code == 200
    return job, dl.content


def test_export_region_ome_tiff_keeps_values_and_pyramid(client, pyramid_file, tmp_path: Path):
    path, data = pyramid_file
    rec = _upload(client, path)
    job, content = _run_export(
        client, rec["id"], {"format": "ome-tiff", "region": [100, 200, 1300, 700], "channels": [2, 0]}
    )
    assert job["download_name"].endswith(".ome.tif") and "C3+1" in job["download_name"]
    out = tmp_path / "out.ome.tif"
    out.write_bytes(content)
    with tifffile.TiffFile(out) as tif:
        assert tif.is_ome
        series = tif.series[0]
        assert series.shape == (2, 700, 1300)
        arr = series.asarray()
        assert np.array_equal(arr[0], data[2, 200:900, 100:1400])
        assert np.array_equal(arr[1], data[0, 200:900, 100:1400])
        assert len(series.levels) >= 2
        assert "CD8" in tif.ome_metadata


def test_export_composite_png_and_tiff(client, pyramid_file, tmp_path: Path):
    path, _ = pyramid_file
    rec = _upload(client, path)
    luts = [
        {"min": 0, "max": 4000, "gamma": 1, "visible": True, "color": [255, 0, 0]},
        {"min": 0, "max": 4000, "gamma": 1, "visible": False, "color": [0, 255, 0]},
        {"min": 0, "max": 4000, "gamma": 1, "visible": True, "color": [0, 0, 255]},
    ]
    job, content = _run_export(client, rec["id"], {"format": "png", "level": 1, "luts": luts, "scale_bar": True})
    img = np.asarray(Image.open(BytesIO(content)))
    assert img.shape == (750, 1150, 3)
    assert img[..., 1][:600].max() == 0 and img[..., 0].max() > 200  # hidden channel stays dark
    # The scale bar box is drawn in the bottom-right corner.
    assert (img[-20:-10, -40:-20] == [240, 244, 248]).all(axis=-1).any()
    job, content = _run_export(
        client, rec["id"], {"format": "tiff", "region": [0, 0, 600, 500], "luts": luts, "scale_bar": False}
    )
    out = tmp_path / "c.tif"
    out.write_bytes(content)
    assert tifffile.imread(out).shape == (500, 600, 3)


def test_export_rejects_huge_png(client, pyramid_file, monkeypatch):
    from nd2utils import slide_export

    monkeypatch.setattr(slide_export, "MAX_RASTER_PIXELS", 1000)
    path, _ = pyramid_file
    rec = _upload(client, path)
    r = client.post(f"/api/files/{rec['id']}/slide/export", json={"format": "png"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "too_large"


def test_rename_keeps_kind(client, pyramid_file):
    path, _ = pyramid_file
    rec = _upload(client, path)
    assert client.patch(f"/api/files/{rec['id']}", json={"name": "x.nd2"}).status_code == 400
    assert client.patch(f"/api/files/{rec['id']}", json={"name": "renamed.ome.tiff"}).status_code == 200


def test_reject_fake_tiff(client):
    r = client.post("/api/files", files={"file": ("fake.ome.tif", b"not a tiff at all", "image/tiff")})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "not_tiff"


def test_real_whole_slide_sample():
    """The 8-channel whole slide from ND2demo (local-only fixture), read without the API."""
    from nd2utils import ometiff

    path = ROOT / "ND2demo" / "OME" / "hx.ome.tiff"
    if not path.is_file():
        pytest.skip("ND2demo fixtures are local-only and not shipped in git")
    rec = ometiff.identify_path(path, "real", path.name, path.stat().st_size, 0)
    assert rec["format"] == "ome-tiff" and len(rec["channels"]) == 8
    assert rec["voxel_um"][0] == pytest.approx(0.531)
    slide = ometiff.open_slide(path)
    assert not ometiff.needs_pyramid(slide)
    tile = ometiff.tile_planes(slide, 0, 30, 60, [0, 4])
    assert tile[0].shape == (512, 512) and tile[0].dtype == np.uint8
