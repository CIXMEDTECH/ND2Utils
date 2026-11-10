from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import tifffile
from fastapi.testclient import TestClient
from PIL import Image

from conftest import admin_code, login
from nd2utils import auth
from nd2utils.config import settings
from nd2utils.main import SESSION_COOKIE, app
from nd2utils.nd2io import close_all, open_nd2
from nd2utils.store import get_owned_file, list_files, purge_expired, update_file


def _upload(client, path: Path, folder: str = "") -> dict:
    response = client.post(
        "/api/files",
        params={"folder": folder},
        files={"file": (path.name, path.read_bytes(), "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _upload_samples(client, samples: list[Path], folder: str = "") -> list[dict]:
    return [_upload(client, path, folder) for path in samples]


def _export(client, body: dict) -> tuple[dict, ZipFile]:
    r = client.post("/api/export", json=body)
    assert r.status_code == 200, r.text
    job_id = r.json()["id"]
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "done", job
    dl = client.get(f"/api/jobs/{job_id}/download")
    assert dl.status_code == 200
    return job, ZipFile(BytesIO(dl.content))


# --- auth ---------------------------------------------------------------------


def test_health_is_public(anon):
    r = anon.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_api_requires_login(anon):
    assert anon.get("/api/files").status_code == 401
    assert anon.get("/api/jobs").status_code == 401
    assert anon.post("/api/export", json={"file_ids": ["x"], "format": "png"}).status_code == 401
    assert anon.get("/api/admin/codes").status_code == 401
    assert anon.get("/api/auth/me").json() == {"authenticated": False, "user": None}
    # The SPA itself (login screen) stays reachable.
    assert anon.get("/").status_code == 200


def test_admin_code_generated_once_and_logged(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    first = auth.ensure_admin()
    assert first["code"] in capsys.readouterr().out
    assert auth.ensure_admin()["id"] == first["id"]
    assert first["code"] not in capsys.readouterr().out
    assert not list(tmp_path.glob("*.txt"))


def test_single_admin_code():
    admins = [rec for rec in auth.list_codes() if rec["role"] == "admin"]
    assert len(admins) == 1
    assert admins[0]["kind"] == "permanent" and admins[0]["expires_at"] is None


def test_login_logout_and_bad_code(anon):
    assert anon.post("/api/auth/login", json={"code": "NOPE-NOPE"}).status_code == 401
    code = admin_code()
    r = anon.post("/api/auth/login", json={"code": code.lower().replace("-", " ")})
    assert r.status_code == 200
    assert "HttpOnly" in r.headers.get("set-cookie", "")
    assert "SameSite=lax" in r.headers.get("set-cookie", "")
    me = anon.get("/api/auth/me").json()
    assert me["authenticated"] and me["user"]["role"] == "admin"
    assert "code" not in me["user"]
    assert anon.get("/api/files").status_code == 200
    anon.post("/api/auth/logout")
    assert anon.get("/api/files").status_code == 401


def test_admin_issues_codes_with_expiry(admin):
    r = admin.post("/api/admin/codes", json={"label": "Lab A", "kind": "permanent", "expires_at": None})
    assert r.status_code == 200
    issued = r.json()
    assert issued["code"] and issued["kind"] == "permanent" and issued["status"] == "active"
    past = admin.post("/api/admin/codes", json={"label": "x", "kind": "temporary", "expires_at": time.time() - 5})
    assert past.status_code == 400

    listed = admin.get("/api/admin/codes").json()["codes"]
    assert listed[0]["role"] == "admin"
    assert any(c["id"] == issued["id"] for c in listed)

    with TestClient(app) as user:
        login(user, issued["code"])
        assert user.get("/api/auth/me").json()["user"]["kind"] == "permanent"
        assert user.get("/api/admin/codes").status_code == 403

        # Expiring the code ends the session and blocks new logins.
        patched = admin.patch(f"/api/admin/codes/{issued['id']}", json={"expires_at": time.time() - 1})
        assert patched.json()["status"] == "expired"
        assert user.get("/api/files").status_code == 401
        assert user.post("/api/auth/login", json={"code": issued["code"]}).status_code == 401

        # Explicit null = never expires again.
        assert admin.patch(f"/api/admin/codes/{issued['id']}", json={"expires_at": None}).json()["status"] == "active"
        login(user, issued["code"])
        admin.patch(f"/api/admin/codes/{issued['id']}", json={"disabled": True})
        assert user.get("/api/files").status_code == 401

    admin_id = listed[0]["id"]
    assert admin.delete(f"/api/admin/codes/{admin_id}").status_code == 403
    assert admin.patch(f"/api/admin/codes/{admin_id}", json={"expires_at": time.time() - 1}).json()["status"] == "active"
    assert admin.delete(f"/api/admin/codes/{issued['id']}").status_code == 200


def test_regenerate_code_invalidates_old_one(admin):
    issued = admin.post("/api/admin/codes", json={"label": "rotate"}).json()
    new = admin.post(f"/api/admin/codes/{issued['id']}/regenerate").json()
    assert new["code"] != issued["code"]
    with TestClient(app) as user:
        assert user.post("/api/auth/login", json={"code": issued["code"]}).status_code == 401
        login(user, new["code"])


def test_login_rate_limit(anon):
    for _ in range(10):
        anon.post("/api/auth/login", json={"code": "WRONG-CODE"})
    assert anon.post("/api/auth/login", json={"code": "WRONG-CODE"}).status_code == 429
    auth._FAILURES.clear()


# --- workspace ----------------------------------------------------------------


def test_reject_non_nd2(client, tmp_path: Path):
    png = tmp_path / "fake.nd2"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"not-an-nd2-file")
    r = client.post("/api/files", files={"file": ("fake.nd2", png.read_bytes(), "application/octet-stream")})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "not_nd2"
    assert client.get("/api/files").json()["files"] == []


def test_reject_wrong_extension_and_bad_folder(client):
    r = client.post("/api/files", files={"file": ("photo.png", b"abc", "image/png")})
    assert r.status_code == 400
    r = client.post("/api/files", params={"folder": "../etc"}, files={"file": ("a.nd2", b"abc", "image/png")})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "bad_path"


def test_folders_create_rename_delete(client, sample_files):
    assert client.post("/api/folders", json={"path": "empty/inner"}).status_code == 200
    rec = _upload(client, sample_files[0], "exp 1/day 0")
    listing = client.get("/api/files").json()
    assert listing["folders"] == ["empty", "empty/inner", "exp 1", "exp 1/day 0"]
    assert listing["files"][0]["folder"] == "exp 1/day 0"

    # Same name into the same folder replaces the previous copy.
    again = _upload(client, sample_files[0], "exp 1/day 0")
    assert [f["id"] for f in client.get("/api/files").json()["files"]] == [again["id"]]
    assert client.get(f"/api/files/{rec['id']}").status_code == 404

    assert client.post("/api/folders/rename", json={"path": "exp 1", "new_path": "empty"}).status_code == 409
    assert client.post("/api/folders/rename", json={"path": "exp 1", "new_path": "exp 1/x"}).status_code == 400
    r = client.post("/api/folders/rename", json={"path": "exp 1", "new_path": "Experiment"})
    assert r.status_code == 200
    listing = client.get("/api/files").json()
    assert listing["files"][0]["folder"] == "Experiment/day 0"
    assert "exp 1" not in listing["folders"]

    moved = client.patch(f"/api/files/{again['id']}", json={"folder": "empty", "name": "renamed.nd2"}).json()
    assert moved["folder"] == "empty" and moved["name"] == "renamed.nd2"

    r = client.post("/api/folders/delete", json={"path": "empty"})
    assert r.json()["removed_files"] == [again["id"]]
    assert client.get("/api/files").json() == {"files": [], "folders": ["Experiment", "Experiment/day 0"]}


def test_open_cache_is_thread_safe(sample_files):
    path = sample_files[0]
    close_all()
    with ThreadPoolExecutor(max_workers=6) as pool:
        handles = list(pool.map(open_nd2, [path] * 6))
    assert len({id(handle) for handle in handles}) == 1
    close_all()


def test_identify_samples(client, sample_files):
    files = _upload_samples(client, sample_files)
    assert {f["name"] for f in files} == {p.name for p in sample_files}
    for rec in files:
        assert rec["status"] == "ready"
        assert rec["version"][:2] == [3, 0]
        assert rec["width"] >= 256 and rec["height"] >= 256
        assert [c["name"] for c in rec["channels"]] == ["DAPI", "TRITC"]
        assert rec["dtype"] == "uint16"
        assert rec["bits_significant"] == 12
        detail = client.get(f"/api/files/{rec['id']}")
        assert detail.status_code == 200
        assert "text_info" in detail.json()


def test_preview_and_plane(client, sample_files):
    fid = _upload(client, sample_files[0])["id"]
    preview = client.get(f"/api/files/{fid}/preview")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/jpeg"
    img = Image.open(BytesIO(preview.content))
    assert img.mode in ("RGB", "YCbCr")
    plane = client.get(f"/api/files/{fid}/plane")
    assert plane.status_code == 200
    assert plane.content[:4] == b"ND2P"
    hist = client.get(f"/api/files/{fid}/histogram?c=0")
    assert hist.status_code == 200
    assert hist.json()["max"] > 0


def test_preview_overlay_split_scale_and_visible(client, sample_files):
    rec = _upload(client, sample_files[0])
    fid = rec["id"]
    overlay = Image.open(BytesIO(client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false").content))
    split = Image.open(BytesIO(client.get(f"/api/files/{fid}/preview?composite=false&scale_bar=false").content))
    assert overlay.size == (rec["width"], rec["height"])
    assert split.size[0] > rec["width"] or split.size[1] > rec["height"]

    with_bar = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=true")
    without_bar = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false")
    assert with_bar.content != without_bar.content

    one = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false&visible=1,0")
    both = client.get(f"/api/files/{fid}/preview?composite=true&scale_bar=false&visible=1,1")
    assert one.content != both.content


def test_measure_rect(client, sample_files):
    fid = _upload(client, sample_files[0])["id"]
    r = client.post(f"/api/files/{fid}/measure", json={"tool": "rect", "points": [[10, 10], [200, 200]]})
    assert r.status_code == 200
    body = r.json()
    assert body["area_px"] > 0
    assert len(body["channels"]) == 2


def test_projection_without_z(client, sample_files):
    fid = _upload(client, sample_files[0])["id"]
    r = client.get(f"/api/files/{fid}/projection?axis=Z")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "no_axis"


# --- export -------------------------------------------------------------------


def test_export_folder_mirrors_workspace_structure(client, sample_files):
    a = _upload(client, sample_files[0], "20260918H2/vector 6h")
    b = _upload(client, sample_files[1], "20260918H2/CDC6 12h")
    _upload(client, sample_files[2], "other")
    job, zf = _export(client, {"folders": ["20260918H2"], "format": "png", "channels_mode": "both"})
    assert job["download_name"].startswith("20260918H2_PNG_")
    assert sorted(job["file_ids"]) == sorted([a["id"], b["id"]])
    names = zf.namelist()
    stem_a = Path(a["name"]).stem
    stem_b = Path(b["name"]).stem
    assert f"20260918H2/vector 6h/{stem_a}_composite.png" in names
    assert f"20260918H2/vector 6h/{stem_a}_DAPI.png" in names
    assert f"20260918H2/vector 6h/{stem_a}_TRITC.png" in names
    assert f"20260918H2/vector 6h/{stem_a}_metadata.json" in names
    assert f"20260918H2/CDC6 12h/{stem_b}_TRITC.png" in names
    assert not any(n.startswith("other/") for n in names)

    # A single file keeps its folder too.
    _, zf = _export(client, {"file_ids": [a["id"]], "format": "jpeg", "channels_mode": "split"})
    assert sorted(zf.namelist()) == sorted(
        f"20260918H2/vector 6h/{stem_a}_{suffix}"
        for suffix in ("DAPI.jpg", "TRITC.jpg", "metadata.json")
    )


def test_export_channel_files_are_not_black(client, sample_files):
    rec = _upload(client, sample_files[0])
    for fmt, ext in (("png", ".png"), ("jpeg", ".jpg"), ("tiff", ".tif")):
        _, zf = _export(
            client,
            {"file_ids": [rec["id"]], "format": fmt, "channels_mode": "split", "scale_bar": False},
        )
        channel_files = [n for n in zf.namelist() if n.endswith(ext)]
        assert len(channel_files) == 2
        for name in channel_files:
            data = zf.read(name)
            arr = tifffile.imread(BytesIO(data)) if ext == ".tif" else np.asarray(Image.open(BytesIO(data)))
            assert arr.dtype == np.uint8 and arr.shape[-1] == 3
            assert int(arr.max()) > 200, name
            assert float((arr.max(axis=-1) > 40).mean()) > 0.01, name


def test_export_ome_tiff_raw_plus_viewable(client, sample_files):
    rec = _upload(client, sample_files[0])
    stem = Path(rec["name"]).stem
    job, zf = _export(client, {"file_ids": [rec["id"]], "format": "ome-tiff", "channels_mode": "both"})
    assert "OME-TIFF" in job["download_name"] and stem in job["download_name"]
    names = set(zf.namelist())
    for base in ("composite", "DAPI", "TRITC"):
        assert f"{stem}_{base}.ome.tif" in names
        assert f"{stem}_{base}.tif" in names
    assert "README_EXPORT.txt" in names

    with tifffile.TiffFile(zf.open(f"{stem}_composite.ome.tif")) as tif:
        raw = tif.asarray()
        assert tif.ome_metadata and 'SignificantBits="12"' in tif.ome_metadata
    assert raw.dtype == np.uint16 and raw.shape[0] == 2
    with tifffile.TiffFile(zf.open(f"{stem}_DAPI.ome.tif")) as tif:
        dapi_raw = tif.asarray()
        assert 'Name="DAPI"' in tif.ome_metadata
    assert np.array_equal(dapi_raw, raw[0])

    for base in ("composite", "DAPI", "TRITC"):
        view = tifffile.imread(zf.open(f"{stem}_{base}.tif"))
        assert view.dtype == np.uint8 and view.shape[-1] == 3
        assert int(view.max()) > 200


def test_export_skips_hidden_channels(client, sample_files):
    rec = _upload(client, sample_files[0])
    _, zf = _export(
        client,
        {"file_ids": [rec["id"]], "format": "png", "channels_mode": "split", "visible": [True, False]},
    )
    pngs = [n for n in zf.namelist() if n.endswith(".png")]
    assert len(pngs) == 1 and pngs[0].endswith("_DAPI.png")


def test_export_tiff_is_viewable_rgb(client, sample_files):
    rec = _upload(client, sample_files[0])
    _, zf = _export(
        client,
        {"file_ids": [rec["id"]], "format": "tiff", "channels_mode": "both", "scale_bar": False},
    )
    composite = next(n for n in zf.namelist() if n.endswith("_composite.tif"))
    with tifffile.TiffFile(zf.open(composite)) as tif:
        page = tif.pages[0]
        assert page.photometric == 2
        assert page.bitspersample in (8, (8, 8, 8))


def test_export_empty_folder_is_rejected(client):
    client.post("/api/folders", json={"path": "nothing"})
    r = client.post("/api/export", json={"folders": ["nothing"], "format": "png"})
    assert r.status_code == 400
    assert client.post("/api/export", json={"folders": ["missing"], "format": "png"}).status_code == 404


# --- isolation & retention ----------------------------------------------------


def test_access_codes_isolate_workspaces(client, sample_files):
    uploaded = _upload(client, sample_files[0], "mine")
    file_id = uploaded["id"]
    assert "_owner" not in uploaded
    job_id = client.post(
        "/api/export",
        json={"file_ids": [file_id], "format": "tiff", "scope": "current", "channels_mode": "composite"},
    ).json()["id"]
    upload_id = client.post("/api/uploads/init", json={"filename": "large.nd2", "size": 3}).json()["upload_id"]

    other_rec = auth.create_code(label="other", kind="temporary", expires_at=None)
    with TestClient(app) as other:
        login(other, other_rec["code"])
        assert other.cookies.get(SESSION_COOKIE) != client.cookies.get(SESSION_COOKIE)
        assert other.get("/api/files").json() == {"files": [], "folders": []}
        assert other.get(f"/api/files/{file_id}").status_code == 404
        for suffix in ("preview", "plane", "histogram", "autoscale", "projection", "tiles", "orthogonal"):
            assert other.get(f"/api/files/{file_id}/{suffix}").status_code == 404
        assert other.post(f"/api/files/{file_id}/measure", json={"tool": "point", "points": [[0, 0]]}).status_code == 404
        assert other.delete(f"/api/files/{file_id}").status_code == 404
        assert other.patch(f"/api/files/{file_id}", json={"name": "x.nd2"}).status_code == 404
        assert other.post("/api/export", json={"file_ids": [file_id], "format": "tiff"}).status_code == 404
        assert other.post("/api/export", json={"folders": ["mine"], "format": "tiff"}).status_code == 404
        assert other.post("/api/folders/delete", json={"path": "mine"}).status_code == 404
        assert other.get("/api/jobs").json()["jobs"] == []
        for suffix in ("", "/events", "/download"):
            assert other.get(f"/api/jobs/{job_id}{suffix}").status_code == 404
        denied = other.put(
            f"/api/uploads/{upload_id}/chunk?offset=0",
            files={"file": ("chunk", b"abc", "application/octet-stream")},
        )
        assert denied.status_code == 404
        assert other.post(f"/api/uploads/{upload_id}/complete").status_code == 404

    assert [item["id"] for item in client.get("/api/files").json()["files"]] == [file_id]
    assert [item["id"] for item in client.get("/api/jobs").json()["jobs"]] == [job_id]


def test_same_code_shares_workspace_across_browsers(client, sample_files):
    rec = _upload(client, sample_files[0])
    code = auth.get_code(client.code_id)["code"]
    with TestClient(app) as second:
        login(second, code)
        assert [f["id"] for f in second.get("/api/files").json()["files"]] == [rec["id"]]


def test_retention_temporary_vs_permanent(admin, sample_files):
    temp = auth.create_code(label="temp", kind="temporary", expires_at=None)
    perm = auth.create_code(label="perm", kind="permanent", expires_at=None)
    ids = {}
    for rec in (temp, perm):
        with TestClient(app) as c:
            login(c, rec["code"])
            ids[rec["id"]] = _upload(c, sample_files[0])["id"]
    old = time.time() - settings.ttl_hours * 3600 - 10
    for owner, fid in ids.items():
        update_file(fid, owner, {"created_at": old})

    purge_expired()
    assert get_owned_file(ids[temp["id"]], temp["id"]) is None
    assert get_owned_file(ids[perm["id"]], perm["id"]) is not None

    # A permanent code that expires keeps its data; a temporary one loses it.
    temp2 = auth.create_code(label="temp2", kind="temporary", expires_at=None)
    with TestClient(app) as c:
        login(c, temp2["code"])
        fid = _upload(c, sample_files[0])["id"]
    admin.patch(f"/api/admin/codes/{temp2['id']}", json={"expires_at": time.time() - 1})
    admin.patch(f"/api/admin/codes/{perm['id']}", json={"expires_at": time.time() - 1})
    assert list_files(temp2["id"]) == []
    assert get_owned_file(fid, temp2["id"]) is None
    assert get_owned_file(ids[perm["id"]], perm["id"]) is not None

    # Deleting a code removes its workspace immediately.
    admin.delete(f"/api/admin/codes/{perm['id']}")
    assert list_files(perm["id"]) == []


# --- static frontend caching ----------------------------------------------------


def test_frontend_cache_headers(anon):
    from nd2utils.main import FRONTEND_DIST

    if not (FRONTEND_DIST / "index.html").exists():
        import pytest

        pytest.skip("frontend is not built")
    index = anon.get("/")
    assert index.status_code == 200
    assert index.headers["cache-control"] == "no-cache"
    deep = anon.get("/workspace")
    assert deep.headers["content-type"].startswith("text/html")
    assert deep.headers["cache-control"] == "no-cache"

    bundle = next((FRONTEND_DIST / "assets").glob("*.js"))
    asset = anon.get(f"/assets/{bundle.name}")
    assert asset.status_code == 200
    assert "immutable" in asset.headers["cache-control"]

    # A bundle from an older build must 404, not come back as index.html.
    missing = anon.get("/assets/index-0ldBuild.js")
    assert missing.status_code == 404
    assert missing.headers["cache-control"] == "no-store"
    assert "text/html" not in missing.headers.get("content-type", "")


def test_api_responses_are_not_cacheable(anon):
    assert anon.get("/api/auth/me").headers["cache-control"] == "no-store"
    assert anon.get("/api/files").headers["cache-control"] == "no-store"


# --- background preparation ---------------------------------------------------


def test_import_prepares_previews_in_background(client, sample_files):
    from nd2utils import prepare
    from nd2utils.nd2io import PLANE_MAGIC
    from nd2utils.store import load_index

    rec = _upload(client, sample_files[0])
    assert rec["prepare"] == "pending"
    prepare.wait_idle()
    listed = client.get("/api/files").json()["files"][0]
    assert listed["prepare"] == "ready"
    assert prepare.is_prepared(rec["id"])

    # Heavy metadata is kept out of index.json but still served in the detail view.
    assert "text_info" not in load_index()[rec["id"]]
    assert "text_info" in client.get(f"/api/files/{rec['id']}").json()

    display = client.get(f"/api/files/{rec['id']}/display")
    assert display.status_code == 200
    assert display.headers["content-encoding"] == "gzip"
    body = display.content
    assert body[:4] == PLANE_MAGIC
    assert body[16] == 0  # uint8 channels, already contrast-mapped
    n, h, w = int.from_bytes(body[6:8], "little"), int.from_bytes(body[8:12], "little"), int.from_bytes(body[12:16], "little")
    assert n == 2 and (w, h) == (rec["width"], rec["height"])
    first = np.frombuffer(body, dtype=np.uint8, count=h * w, offset=20 + 44)
    assert first.max() >= 250 and first.mean() > 1

    plane = client.get(f"/api/files/{rec['id']}/plane")
    assert plane.headers["content-encoding"] == "gzip"
    assert plane.content[16] == 1 and len(plane.content) == 20 + 2 * (44 + h * w * 2)
    scaled = client.get(f"/api/files/{rec['id']}/autoscale").json()["channels"]
    assert len(scaled) == 2 and scaled[0]["max"] > scaled[0]["min"]
    # Positions other than the first plane are computed on demand.
    assert client.get(f"/api/files/{rec['id']}/display?t=3").status_code == 200


def test_unprepared_file_is_built_on_first_view(client, sample_files):
    import shutil as _shutil

    from nd2utils import prepare

    rec = _upload(client, sample_files[0])
    prepare.wait_idle()
    _shutil.rmtree(settings.cache_dir / rec["id"])
    assert client.get(f"/api/files/{rec['id']}/display").status_code == 200
    assert prepare.is_prepared(rec["id"])


def test_migrate_index_moves_metadata_out(client, sample_files):
    from nd2utils import jsoncache
    from nd2utils.store import load_index, migrate_index, save_index

    rec = _upload(client, sample_files[0])
    index = load_index()
    index[rec["id"]] = {**index[rec["id"]], "text_info": {"legacy": "yes"}}
    save_index(index)
    jsoncache.forget(settings.index_path)
    migrate_index()
    assert "text_info" not in load_index()[rec["id"]]
    assert client.get(f"/api/files/{rec['id']}").json()["text_info"] == {"legacy": "yes"}


# --- admin transfer -----------------------------------------------------------


def test_admin_copy_and_move_between_workspaces(admin, sample_files):
    from nd2utils import prepare

    a = auth.create_code(label="A", kind="permanent", expires_at=None)
    b = auth.create_code(label="B", kind="temporary", expires_at=None)
    with TestClient(app) as ca:
        login(ca, a["code"])
        f1 = _upload(ca, sample_files[0], "exp/day 1")
        f2 = _upload(ca, sample_files[1], "exp/day 2")
        loose = _upload(ca, sample_files[2], "")
        ca.post("/api/folders", json={"path": "exp/empty"})
        prepare.wait_idle()

        listing = admin.get(f"/api/admin/workspaces/{a['id']}").json()
        assert {f["id"] for f in listing["files"]} == {f1["id"], f2["id"], loose["id"]}
        with TestClient(app) as user:
            login(user, auth.create_code(label="x", kind="temporary", expires_at=None)["code"])
            assert user.get(f"/api/admin/workspaces/{a['id']}").status_code == 403
            assert user.post("/api/admin/transfer", json={"source": a["id"], "target": b["id"], "folders": ["exp"]}).status_code == 403

        # Copy a folder: it keeps its name and inner structure under the target folder.
        r = admin.post(
            "/api/admin/transfer",
            json={"source": a["id"], "target": b["id"], "folders": ["exp"], "file_ids": [loose["id"]], "target_folder": "from A"},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"copied": 3, "moved": 0, "skipped": 0, "replaced": 0}
        with TestClient(app) as cb:
            login(cb, b["code"])
            got = cb.get("/api/files").json()
            assert sorted((f["folder"], f["name"]) for f in got["files"]) == sorted(
                [("from A/exp/day 1", f1["name"]), ("from A/exp/day 2", f2["name"]), ("from A", loose["name"])]
            )
            assert "from A/exp/empty" in got["folders"]
            copied = next(f for f in got["files"] if f["name"] == f1["name"])
            assert copied["id"] != f1["id"]
            assert cb.get(f"/api/files/{copied['id']}/display").status_code == 200
            assert "text_info" in cb.get(f"/api/files/{copied['id']}").json()
        # The source is untouched by a copy, and both copies are independent.
        assert len(ca.get("/api/files").json()["files"]) == 3
        assert ca.delete(f"/api/files/{f1['id']}").status_code == 200
        assert get_owned_file(copied["id"], b["id"]) is not None
        assert (settings.uploads_dir / copied["id"] / "source.nd2").is_file()

        # Copying again: same names are skipped, or replaced on request.
        again = {"source": a["id"], "target": b["id"], "folders": ["exp"], "target_folder": "from A"}
        assert admin.post("/api/admin/transfer", json=again).json()["skipped"] == 1
        assert admin.post("/api/admin/transfer", json={**again, "conflict": "replace"}).json() == {
            "copied": 1, "moved": 0, "skipped": 0, "replaced": 1,
        }

        # Move: the files leave the source workspace together with the folder.
        r = admin.post("/api/admin/transfer", json={**again, "mode": "move", "conflict": "replace"})
        assert r.json()["moved"] == 1
        left = ca.get("/api/files").json()
        assert [f["id"] for f in left["files"]] == [loose["id"]]
        assert not any(f.startswith("exp") for f in left["folders"])
        moved = get_owned_file(f2["id"], b["id"])
        assert moved and moved["folder"] == "from A/exp/day 2"


def test_admin_transfer_within_workspace(admin, sample_files):
    a = auth.create_code(label="A", kind="permanent", expires_at=None)
    with TestClient(app) as ca:
        login(ca, a["code"])
        f1 = _upload(ca, sample_files[0], "x/y")
        body = {"source": a["id"], "target": a["id"]}
        assert admin.post("/api/admin/transfer", json={**body, "folders": ["x"], "target_folder": "x/y", "mode": "move"}).status_code == 400
        # Copying a file onto itself is a no-op, never a duplicate.
        r = admin.post("/api/admin/transfer", json={**body, "file_ids": [f1["id"]], "target_folder": "x/y", "conflict": "replace"})
        assert r.json()["skipped"] == 1
        r = admin.post("/api/admin/transfer", json={**body, "folders": ["x/y"], "target_folder": "z", "mode": "move"})
        assert r.json()["moved"] == 1
        files = ca.get("/api/files").json()
        assert files["files"][0]["folder"] == "z/y"
        assert "x/y" not in files["folders"] and "x" in files["folders"]
        assert admin.post("/api/admin/transfer", json={**body, "folders": ["nope"]}).status_code == 404


def test_admin_transfer_whole_workspace(admin, sample_files):
    a = auth.create_code(label="A", kind="temporary", expires_at=None)
    b = auth.create_code(label="B", kind="permanent", expires_at=None)
    with TestClient(app) as ca:
        login(ca, a["code"])
        _upload(ca, sample_files[0], "p/q")
        _upload(ca, sample_files[1], "")
        body = {"source": a["id"], "folders": [""], "mode": "move"}
        assert admin.post("/api/admin/transfer", json={**body, "target": a["id"], "target_folder": "x"}).status_code == 400
        r = admin.post("/api/admin/transfer", json={**body, "target": b["id"], "target_folder": "old A"})
        assert r.json()["moved"] == 2
        assert ca.get("/api/files").json() == {"files": [], "folders": []}
        assert sorted(f["folder"] for f in list_files(b["id"])) == ["old A", "old A/p/q"]


def test_crop_file_creates_new_workspace_file_and_exports(client, sample_files):
    src = _upload(client, sample_files[0], "crops")
    w0, h0 = int(src["width"]), int(src["height"])
    cw, ch = max(32, w0 // 2), max(32, h0 // 2)
    r = client.post(
        f"/api/files/{src['id']}/crop",
        json={"x": 10, "y": 12, "w": cw, "h": ch, "name": "cropped_1to1.nd2"},
    )
    assert r.status_code == 200, r.text
    cropped = r.json()
    assert cropped["id"] != src["id"]
    assert cropped["name"] == "cropped_1to1.nd2"
    assert cropped["folder"] == "crops"
    assert cropped["width"] == cw and cropped["height"] == ch
    assert cropped["cropped"] is True
    assert cropped["crop"]["x"] == 10 and cropped["crop"]["y"] == 12
    assert cropped["voxel_um"] == src["voxel_um"]
    assert cropped["prepare"] == "ready"

    # Preview and display plane reflect cropped dimensions
    prev = Image.open(BytesIO(client.get(f"/api/files/{cropped['id']}/preview").content))
    assert prev.size == (cw, ch)

    # Secondary crop on already-cropped file accumulates coordinates
    cw2, ch2 = max(16, cw // 2), max(16, ch // 2)
    r2 = client.post(
        f"/api/files/{cropped['id']}/crop",
        json={"x": 5, "y": 6, "w": cw2, "h": ch2},
    )
    assert r2.status_code == 200, r2.text
    cropped2 = r2.json()
    assert cropped2["width"] == cw2 and cropped2["height"] == ch2
    assert cropped2["crop"]["x"] == 15 and cropped2["crop"]["y"] == 18

    # Exporting the cropped file produces images of the cropped dimensions
    _, zf = _export(client, {"file_ids": [cropped["id"]], "format": "png", "scale_bar": True})
    png_names = [n for n in zf.namelist() if n.endswith(".png")]
    assert len(png_names) >= 1
    exported_img = Image.open(BytesIO(zf.read(png_names[0])))
    assert exported_img.size == (cw, ch)


def test_projects_crud_and_cleanup(client, sample_files):
    f1 = _upload(client, sample_files[0], "studio")
    f2 = _upload(client, sample_files[1], "studio")

    # Create a project with f1 and f2
    r = client.post(
        "/api/projects",
        json={
            "name": "Fig2 Nucleus & Dim Blue",
            "file_ids": [f1["id"], f2["id"]],
            "settings": {"aspectPreset": "1:1"},
        },
    )
    assert r.status_code == 200, r.text
    proj = r.json()
    assert proj["name"] == "Fig2 Nucleus & Dim Blue"
    assert proj["file_ids"] == [f1["id"], f2["id"]]
    assert proj["settings"]["aspectPreset"] == "1:1"

    # List projects
    listed = client.get("/api/projects").json()["projects"]
    assert any(p["id"] == proj["id"] for p in listed)

    # Update project
    r_patch = client.patch(
        f"/api/projects/{proj['id']}",
        json={"name": "Fig2 Updated", "settings": {"aspectPreset": "4:3"}},
    )
    assert r_patch.status_code == 200
    assert r_patch.json()["name"] == "Fig2 Updated"
    assert r_patch.json()["settings"]["aspectPreset"] == "4:3"

    # Deleting f1 removes it from project.file_ids automatically
    client.delete(f"/api/files/{f1['id']}")
    proj_after = client.get(f"/api/projects/{proj['id']}").json()
    assert proj_after["file_ids"] == [f2["id"]]

    # Delete project
    assert client.delete(f"/api/projects/{proj['id']}").status_code == 200
    assert client.get(f"/api/projects/{proj['id']}").status_code == 404


def test_segment_nuclei_and_api_endpoint(client, sample_files):
    from nd2utils.models import NucleusParams
    from nd2utils.render import identify_nucleus_channel, segment_nuclei

    # Unit test segment_nuclei on a synthetic 256x256 plane with a circular nucleus at (140, 110)
    yy, xx = np.ogrid[:256, :256]
    gfp_plane = np.full((256, 256), 10, dtype=np.uint16)
    dapi_plane = np.full((256, 256), 15, dtype=np.uint16)
    mask_circle = (xx - 140) ** 2 + (yy - 110) ** 2 <= 28**2
    dapi_plane[mask_circle] = 900

    channels = [
        {"index": 0, "name": "GFP", "color": "#00ff00"},
        {"index": 1, "name": "DAPI", "color": "#4ea8ff"},
    ]
    assert identify_nucleus_channel(channels) == 1

    res = segment_nuclei(
        [gfp_plane, dapi_plane],
        channels,
        um_per_px=0.25,
        params=NucleusParams(min_area_um2=20.0, max_area_um2=2000.0),
    )
    assert res["channel_index"] == 1
    assert len(res["nuclei"]) == 1
    nuc = res["nuclei"][0]
    assert abs(nuc["cx"] - 140.0) < 2.0
    assert abs(nuc["cy"] - 110.0) < 2.0
    assert nuc["circularity"] > 0.7
    assert len(nuc["contour"]) >= 8

    # Integration test /api/files/{id}/nuclei on an uploaded file
    uploaded = _upload(client, sample_files[0], "")
    r = client.post(
        f"/api/files/{uploaded['id']}/nuclei",
        json={"min_area_um2": 1.0, "max_area_um2": 50000.0, "min_circularity": 0.1, "exclude_edges": False},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "channel_index" in body
    assert isinstance(body["nuclei"], list)


def test_batch_apply_inplace_and_new_with_brightness_and_reset(client, sample_files):
    f1 = _upload(client, sample_files[0], "batch")
    w0, h0 = int(f1["width"]), int(f1["height"])
    cw, ch = max(32, w0 // 2), max(32, h0 // 2)

    # First export baseline PNG to compare pixel intensity before dimming
    _, zf_base = _export(client, {"file_ids": [f1["id"]], "format": "png", "scale_bar": False})
    base_png = [n for n in zf_base.namelist() if n.endswith(".png")][0]
    base_arr = np.asarray(Image.open(BytesIO(zf_base.read(base_png))))

    # Apply in-place crop + dim channel 0 brightness to 0.35
    r = client.post(
        "/api/files/batch-apply",
        json={
            "mode": "inplace",
            "unified_channel_edits": [{"index": 0, "brightness": 0.35}],
            "items": [
                {
                    "file_id": f1["id"],
                    "crop": {"x": 8, "y": 8, "w": cw, "h": ch, "ratio_label": "1:1"},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    updated = r.json()["files"][0]
    assert updated["id"] == f1["id"]
    assert updated["cropped"] is True
    assert updated["edited"] is True
    assert updated["width"] == cw and updated["height"] == ch
    assert abs(updated["channels"][0]["brightness"] - 0.35) < 1e-4

    # Export after in-place edit and verify cropped size and dimmed intensity
    _, zf_dim = _export(client, {"file_ids": [f1["id"]], "format": "png", "scale_bar": False})
    dim_png = [n for n in zf_dim.namelist() if n.endswith(".png")][0]
    dim_arr = np.asarray(Image.open(BytesIO(zf_dim.read(dim_png))))
    assert dim_arr.shape[:2] == (ch, cw)
    base_crop = base_arr[8 : 8 + ch, 8 : 8 + cw]
    if base_crop.mean() > 1.0:
        assert dim_arr.mean() < base_crop.mean()

    # Batch-apply in mode="new" with auto_nucleus=True
    r_new = client.post(
        "/api/files/batch-apply",
        json={
            "mode": "new",
            "auto_nucleus": True,
            "aspect_ratio": 1.0,
            "crop_size_px": max(24, cw // 2),
            "ratio_label": "1:1",
            "items": [{"file_id": f1["id"]}],
        },
    )
    assert r_new.status_code == 200, r_new.text
    new_file = r_new.json()["files"][0]
    assert new_file["id"] != f1["id"]
    assert new_file["cropped"] is True

    # Reset f1 back to its original uncropped and unedited state
    r_reset = client.post(f"/api/files/{f1['id']}/reset")
    assert r_reset.status_code == 200, r_reset.text
    restored = r_reset.json()
    assert restored["cropped"] is False
    assert restored["edited"] is False
    assert restored["width"] == w0 and restored["height"] == h0
    assert abs(restored["channels"][0].get("brightness", 1.0) - 1.0) < 1e-4


def test_export_separate_scale_bars_flat_structure_and_studio_live_crop(client, sample_files):
    f1 = _upload(client, sample_files[0], "exp/day1/groupA")
    w0, h0 = int(f1["width"]), int(f1["height"])
    cw, ch = max(40, w0 // 2), max(40, h0 // 2)

    # Export with flat_structure=True, separate_scale_bar=True, and Studio live crops_by_file + channel_edits_by_file
    _, zf = _export(
        client,
        {
            "file_ids": [f1["id"]],
            "format": "png",
            "scale_bar": True,
            "separate_scale_bar": True,
            "flat_structure": True,
            "crops_by_file": {f1["id"]: {"x": 10, "y": 10, "w": cw, "h": ch, "ratio_label": "1:1"}},
            "channel_edits_by_file": {f1["id"]: [{"index": 0, "brightness": 0.4}]},
        },
    )
    names = zf.namelist()
    # Because flat_structure=True, no files are nested inside subdirectories
    assert all("/" not in name for name in names), names

    # Check standalone scale bar images exist for each scale bar style
    scalebar_files = [n for n in names if n.startswith("scalebar_") and n.endswith(".png")]
    assert len(scalebar_files) == 6
    expected_styles = {
        "white_labeled",
        "white_bar_only",
        "black_labeled",
        "dark_badge",
        "cropped_white_labeled",
        "cropped_white_bar_only",
    }
    for style in expected_styles:
        matched = [n for n in scalebar_files if n.endswith(f"x{ch}_{style}.png")]
        assert len(matched) == 1
        sb_img = Image.open(BytesIO(zf.read(matched[0])))
        assert sb_img.mode == "RGBA"
        if not style.startswith("cropped_"):
            assert sb_img.size == (cw, ch)

    # Check main exported PNG has the live Studio crop size
    main_pngs = [n for n in names if n.endswith(".png") and not n.startswith("scalebar_")]
    assert len(main_pngs) == 1
    main_img = Image.open(BytesIO(zf.read(main_pngs[0])))
    assert main_img.size == (cw, ch)


def test_studio_export_to_workspace_and_no_double_crop(client, sample_files):
    f1 = _upload(client, sample_files[0], "raw")
    w0, h0 = int(f1["width"]), int(f1["height"])
    cw, ch = max(48, int(w0 * 0.6)), max(48, int(h0 * 0.6))

    # 1. Crop in-place in Studio
    r_inplace = client.post(
        "/api/files/batch-apply",
        json={
            "mode": "inplace",
            "items": [
                {
                    "file_id": f1["id"],
                    "crop": {"x": 8, "y": 8, "w": cw, "h": ch, "ratio_label": "1:1"},
                    "channel_edits": [{"index": 0, "brightness": 0.6}],
                }
            ],
        },
    )
    assert r_inplace.status_code == 200
    after_inplace = r_inplace.json()["files"][0]
    assert after_inplace["width"] == cw and after_inplace["height"] == ch

    # 2. Subsequent channel adjustment in Studio (preview mode: crop=None) must NOT re-crop
    r_adjust = client.post(
        "/api/files/batch-apply",
        json={
            "mode": "inplace",
            "items": [
                {
                    "file_id": f1["id"],
                    "channel_edits": [{"index": 0, "brightness": 0.45}],
                }
            ],
        },
    )
    assert r_adjust.status_code == 200
    after_adjust = r_adjust.json()["files"][0]
    assert after_adjust["width"] == cw and after_adjust["height"] == ch

    # 3. Export processed image to a new Workspace folder ("Studio_Exports/Fig1")
    r_ws = client.post(
        "/api/files/batch-apply",
        json={
            "mode": "new",
            "folder": "Studio_Exports/Fig1",
            "items": [
                {
                    "file_id": f1["id"],
                    "channel_edits": [{"index": 0, "brightness": 0.45}],
                }
            ],
        },
    )
    assert r_ws.status_code == 200
    ws_file = r_ws.json()["files"][0]
    assert ws_file["id"] != f1["id"]
    assert ws_file["folder"] == "Studio_Exports/Fig1"
    assert ws_file["width"] == cw and ws_file["height"] == ch
    assert ws_file["cropped"] is True

    listing = client.get("/api/files").json()
    assert "Studio_Exports/Fig1" in listing["folders"]



