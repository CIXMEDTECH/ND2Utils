from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import tifffile
from fastapi.testclient import TestClient
from PIL import Image

from nd2utils.main import SESSION_COOKIE, app
from nd2utils.nd2io import close_all, open_nd2


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_reject_non_nd2(client, tmp_path: Path):
    png = tmp_path / "fake.nd2"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"not-an-nd2-file")
    r = client.post("/api/files", files={"file": ("fake.nd2", png.read_bytes(), "application/octet-stream")})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "not_nd2"


def test_reject_wrong_extension(client):
    r = client.post("/api/files", files={"file": ("photo.png", b"abc", "image/png")})
    assert r.status_code == 400


def test_open_cache_is_thread_safe(sample_dir: Path):
    path = sorted(sample_dir.glob("*.nd2"))[0]
    close_all()
    with ThreadPoolExecutor(max_workers=6) as pool:
        handles = list(pool.map(open_nd2, [path] * 6))
    assert len({id(handle) for handle in handles}) == 1
    close_all()


def _upload_samples(client, sample_dir: Path) -> list[dict]:
    records = []
    for path in sorted(sample_dir.glob("*.nd2")):
        response = client.post(
            "/api/files",
            files={"file": (path.name, path.read_bytes(), "application/octet-stream")},
        )
        assert response.status_code == 200, response.text
        records.append(response.json())
    assert len(records) == 3
    return records


def test_identify_samples(client, sample_dir: Path):
    files = _upload_samples(client, sample_dir)
    names = {f["name"] for f in files}
    assert names == {"MB2310343.nd2", "MB2310344.nd2", "MB2310345.nd2"}
    for rec in files:
        assert rec["status"] == "ready"
        assert rec["version"][:2] == [3, 0]
        assert rec["width"] == 512
        assert rec["height"] == 512
        ch_names = [c["name"] for c in rec["channels"]]
        assert ch_names == ["DAPI", "FITC", "TRITC"]
        assert rec["objective"] and "100x" in rec["objective"]
        assert rec["dtype"] == "uint16"
        detail = client.get(f"/api/files/{rec['id']}")
        assert detail.status_code == 200
        body = detail.json()
        assert "text_info" in body
        assert "DAPI" in body["text_info"].get("description", "")


def test_preview_and_plane(client, sample_dir: Path):
    files = _upload_samples(client, sample_dir)
    fid = files[0]["id"]
    preview = client.get(f"/api/files/{fid}/preview")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/jpeg"
    img = Image.open(BytesIO(preview.content))
    assert img.size[0] >= 512
    assert img.mode in ("RGB", "YCbCr")
    plane = client.get(f"/api/files/{fid}/plane")
    assert plane.status_code == 200
    assert plane.content[:4] == b"ND2P"
    hist = client.get(f"/api/files/{fid}/histogram?c=0")
    assert hist.status_code == 200
    assert hist.json()["max"] > 0


def test_preview_overlay_split_scale_and_visible(client, sample_dir: Path):
    files = _upload_samples(client, sample_dir)
    fid = files[0]["id"]
    overlay = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false")
    split = client.get(f"/api/files/{fid}/preview?composite=false&scale_bar=false")
    assert overlay.status_code == 200
    assert split.status_code == 200
    overlay_img = Image.open(BytesIO(overlay.content))
    split_img = Image.open(BytesIO(split.content))
    assert overlay_img.size == (512, 512)
    assert split_img.size[0] > 512 or split_img.size[1] > 512

    with_bar = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=true")
    without_bar = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false")
    assert with_bar.content != without_bar.content

    one = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false&visible=1,0,0")
    all_ch = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false&visible=1,1,1")
    assert one.status_code == 200
    assert all_ch.status_code == 200
    assert one.content != all_ch.content


def test_measure_rect(client, sample_dir: Path):
    files = _upload_samples(client, sample_dir)
    fid = files[0]["id"]
    r = client.post(
        f"/api/files/{fid}/measure",
        json={"tool": "rect", "points": [[10, 10], [200, 200]]},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["area_px"] > 0
    assert len(body["channels"]) == 3
    assert body["channels"][0]["mean"] >= 0


def test_export_ome_tiff_and_png_batch(client, sample_dir: Path):
    files = _upload_samples(client, sample_dir)
    ids = [f["id"] for f in files]
    r = client.post(
        "/api/export",
        json={"file_ids": ids, "format": "ome-tiff", "scope": "current", "channels_mode": "composite"},
    )
    assert r.status_code == 200
    job_id = r.json()["id"]
    job = client.get(f"/api/jobs/{job_id}")
    assert job.status_code == 200
    body = job.json()
    assert body["status"] == "done"
    assert "OME-TIFF" in (body.get("download_name") or "")
    assert "MB2310343" in (body.get("download_name") or "")
    dl = client.get(f"/api/jobs/{job_id}/download")
    assert dl.status_code == 200
    zf = ZipFile(BytesIO(dl.content))
    names = zf.namelist()
    assert any(n.endswith(".ome.tif") for n in names)
    joined = " ".join(names)
    assert "MB2310343" in joined
    assert "MB2310344" in joined
    assert "MB2310345" in joined
    tif_name = next(n for n in names if n.endswith(".ome.tif"))
    with tifffile.TiffFile(zf.open(tif_name)) as tif:
        arr = tif.asarray()
        assert tif.ome_metadata and 'SignificantBits="12"' in tif.ome_metadata
    assert arr.dtype == np.uint16
    assert arr.ndim in (2, 3)
    if arr.ndim == 3:
        assert arr.shape[0] == 3
    assert int(arr.max()) > 0
    display_name = next(n for n in names if n.endswith("_DISPLAY.tif"))
    display = tifffile.imread(zf.open(display_name))
    assert display.dtype == np.uint8
    assert display.ndim == 3 and display.shape[-1] == 3
    assert int(display.max()) > 40
    assert float(display.mean()) > 1.0
    assert any(n.endswith("README_DISPLAY_FILES.txt") for n in names)

    r2 = client.post(
        "/api/export",
        json={"file_ids": ids[:1], "format": "png", "scope": "current", "channels_mode": "composite", "scale_bar": True},
    )
    job2 = client.get(f"/api/jobs/{r2.json()['id']}").json()
    assert job2["status"] == "done"
    assert "PNG" in (job2.get("download_name") or "")
    dl2 = client.get(f"/api/jobs/{job2['id']}/download")
    z2 = ZipFile(BytesIO(dl2.content))
    png_name = next(n for n in z2.namelist() if n.endswith(".png"))
    img = Image.open(z2.open(png_name))
    assert img.mode in ("RGB", "P", "RGBA")
    assert img.size[0] >= 512


def test_export_tiff_is_viewable_rgb(client, sample_dir: Path):
    files = _upload_samples(client, sample_dir)
    fid = files[0]["id"]
    r = client.post(
        "/api/export",
        json={
            "file_ids": [fid],
            "format": "tiff",
            "scope": "current",
            "channels_mode": "both",
            "scale_bar": False,
            "include_metadata": True,
        },
    )
    assert r.status_code == 200
    job = client.get(f"/api/jobs/{r.json()['id']}").json()
    assert job["status"] == "done"
    assert "TIFF" in (job.get("download_name") or "")
    assert Path(files[0]["name"]).stem in (job.get("download_name") or "")
    dl = client.get(f"/api/jobs/{job['id']}/download")
    zf = ZipFile(BytesIO(dl.content))
    names = zf.namelist()
    tifs = [n for n in names if n.endswith(".tif") and not n.endswith(".ome.tif")]
    assert any(n.endswith("_composite.tif") for n in tifs)
    assert any("_DAPI.tif" in n for n in tifs)
    assert any("_FITC.tif" in n for n in tifs)
    assert any("_TRITC.tif" in n for n in tifs)
    assert any(n.endswith("_metadata.json") for n in names)
    composite = next(n for n in tifs if n.endswith("_composite.tif"))
    arr = tifffile.imread(zf.open(composite))
    assert arr.dtype == np.uint8
    assert arr.ndim == 3
    assert arr.shape[-1] == 3
    assert arr.max() > 40
    assert float(arr.mean()) > 1.0
    with tifffile.TiffFile(zf.open(composite)) as tif:
        page = tif.pages[0]
        assert page.photometric == 2
        assert page.bitspersample in (8, (8, 8, 8))


def test_projection_without_z(client, sample_dir: Path):
    files = _upload_samples(client, sample_dir)
    r = client.get(f"/api/files/{files[0]['id']}/projection?axis=Z")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "no_axis"


def test_browser_sessions_isolate_uploads_files_and_jobs(client, sample_dir: Path):
    sample = sorted(sample_dir.glob("*.nd2"))[0]
    uploaded = client.post(
        "/api/files",
        files={"file": (sample.name, sample.read_bytes(), "application/octet-stream")},
    )
    assert uploaded.status_code == 200
    assert "_owner" not in uploaded.json()
    file_id = uploaded.json()["id"]
    owner_cookie = client.cookies.get(SESSION_COOKIE)
    assert owner_cookie
    assert "HttpOnly" in uploaded.headers.get("set-cookie", "")
    assert "SameSite=lax" in uploaded.headers.get("set-cookie", "")

    export = client.post(
        "/api/export",
        json={"file_ids": [file_id], "format": "tiff", "scope": "current", "channels_mode": "composite"},
    )
    assert export.status_code == 200
    job_id = export.json()["id"]
    owner_job = client.get(f"/api/jobs/{job_id}")
    assert owner_job.status_code == 200
    assert "_owner" not in owner_job.json()
    assert client.get(f"/api/jobs/{job_id}/download").status_code == 200

    chunk_init = client.post("/api/uploads/init", json={"filename": "large.nd2", "size": 3})
    assert chunk_init.status_code == 200
    upload_id = chunk_init.json()["upload_id"]

    with TestClient(app) as other:
        assert other.get("/api/health").status_code == 200
        assert other.cookies.get(SESSION_COOKIE)
        assert other.cookies.get(SESSION_COOKIE) != owner_cookie
        assert other.get("/api/files").json()["files"] == []
        assert other.get(f"/api/files/{file_id}").status_code == 404
        for suffix in ("preview", "plane", "histogram", "autoscale", "projection", "tiles", "orthogonal"):
            assert other.get(f"/api/files/{file_id}/{suffix}").status_code == 404
        assert other.post(
            f"/api/files/{file_id}/measure",
            json={"tool": "point", "points": [[0, 0]]},
        ).status_code == 404
        assert other.delete(f"/api/files/{file_id}").status_code == 404
        denied_export = other.post(
            "/api/export",
            json={"file_ids": [file_id], "format": "tiff", "scope": "current", "channels_mode": "composite"},
        )
        assert denied_export.status_code == 404
        assert other.get("/api/jobs").json()["jobs"] == []
        assert other.get(f"/api/jobs/{job_id}").status_code == 404
        assert other.get(f"/api/jobs/{job_id}/events").status_code == 404
        assert other.get(f"/api/jobs/{job_id}/download").status_code == 404
        denied_chunk = other.put(
            f"/api/uploads/{upload_id}/chunk?offset=0",
            files={"file": ("chunk", b"abc", "application/octet-stream")},
        )
        assert denied_chunk.status_code == 404
        assert other.post(f"/api/uploads/{upload_id}/complete").status_code == 404

    assert [item["id"] for item in client.get("/api/files").json()["files"]] == [file_id]
    assert [item["id"] for item in client.get("/api/jobs").json()["jobs"]] == [job_id]
    accepted_chunk = client.put(
        f"/api/uploads/{upload_id}/chunk?offset=0",
        files={"file": ("chunk", b"abc", "application/octet-stream")},
    )
    assert accepted_chunk.status_code == 200
