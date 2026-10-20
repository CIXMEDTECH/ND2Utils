from __future__ import annotations

import gzip
from pathlib import Path

import numpy as np
import pytest
import tifffile

from nd2utils import prepare
from nd2utils.config import settings


def _write_slide(path: Path, shape=(2, 600, 900)) -> None:
    data = np.random.default_rng(3).integers(0, 4000, shape, dtype=np.uint16)
    tifffile.imwrite(path, data, ome=True, metadata={"axes": "CYX", "Channel": {"Name": ["A", "B"]}})


def _upload(client, path: Path, folder: str = "") -> dict:
    r = client.post(
        "/api/files",
        params={"folder": folder},
        files={"file": (path.name, path.read_bytes(), "application/octet-stream")},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _listed(client, file_id: str) -> dict:
    return next(f for f in client.get("/api/files").json()["files"] if f["id"] == file_id)


@pytest.fixture
def reset_perf(admin):
    yield
    admin.post("/api/admin/performance/reset")


def test_cache_settings_reach_every_user(admin, client, reset_perf):
    s = client.get("/api/settings").json()
    assert s["local_cache"] is True and s["local_cache_auto"] is True and s["cache_rebuild"] is True
    assert s["local_cache_bytes"] == 2048 * 1024 * 1024
    view = admin.get("/api/admin/performance").json()
    assert view["schema"]["local_cache"] == {"type": "bool", "default": True}

    r = admin.put("/api/admin/performance", json={"local_cache": False, "local_cache_mb": 128, "cache_rebuild_users": False})
    assert r.status_code == 200, r.text
    s = client.get("/api/settings").json()
    # Automatic caching needs the local cache itself.
    assert s["local_cache"] is False and s["local_cache_auto"] is False
    assert s["local_cache_bytes"] == 128 * 1024 * 1024
    assert s["cache_rebuild"] is False
    # Administrators may always rebuild.
    assert admin.get("/api/settings").json()["cache_rebuild"] is True

    assert admin.put("/api/admin/performance", json={"local_cache": 1}).status_code == 400
    assert admin.put("/api/admin/performance", json={"local_cache_mb": 1}).status_code == 400


def test_rebuild_cache_prepares_again_with_new_version(client, tmp_path):
    path = tmp_path / "a.ome.tif"
    _write_slide(path)
    rec = _upload(client, path, folder="run1/day2")
    prepare.wait_idle()
    first = _listed(client, rec["id"])
    assert first["prepare"] == "ready" and first["prepared_at"]
    version = client.get(f"/api/files/{rec['id']}/slide").json()["version"]
    assert version == first["prepared_at"]

    r = client.post("/api/cache/rebuild", json={"folders": ["run1"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 1}
    prepare.wait_idle()
    again = _listed(client, rec["id"])
    assert again["prepare"] == "ready"
    assert again["prepared_at"] > first["prepared_at"]
    assert prepare.is_prepared(rec["id"])

    assert client.post("/api/cache/rebuild", json={"file_ids": [rec["id"]]}).json() == {"count": 1}
    prepare.wait_idle()
    assert client.post("/api/cache/rebuild", json={"folders": ["nope"]}).status_code == 404
    assert client.post("/api/cache/rebuild", json={"file_ids": ["0" * 32]}).status_code == 404


def test_rebuild_cache_can_be_turned_off_for_users(admin, client, tmp_path, reset_perf):
    path = tmp_path / "b.ome.tif"
    _write_slide(path)
    rec = _upload(client, path)
    prepare.wait_idle()
    admin.put("/api/admin/performance", json={"cache_rebuild_users": False})
    assert client.post("/api/cache/rebuild", json={"file_ids": [rec["id"]]}).status_code == 403
    # Someone else's file is not found, even for an administrator.
    assert admin.post("/api/cache/rebuild", json={"file_ids": [rec["id"]]}).status_code == 404


def test_rebuild_during_preparation_runs_again(client, tmp_path, monkeypatch):
    path = tmp_path / "c.ome.tif"
    _write_slide(path)
    rec = _upload(client, path)
    prepare.wait_idle()
    # A rebuild while the file is still queued must not be swallowed by the queued run.
    calls = []
    real = prepare._run
    monkeypatch.setattr(prepare, "_run", lambda file_id: (calls.append(file_id), real(file_id)))
    prepare.schedule(rec["id"])
    prepare.rebuild([rec["id"]])
    prepare.wait_idle()
    prepare.wait_idle()
    assert len(calls) >= 1
    assert _listed(client, rec["id"])["prepare"] == "ready"
    assert prepare.is_prepared(rec["id"])


def test_display_wire_gzip_and_tile_versions(client, tmp_path, reset_perf, admin):
    path = tmp_path / "d.ome.tif"
    _write_slide(path)
    rec = _upload(client, path)
    prepare.wait_idle()
    r = client.get(f"/api/files/{rec['id']}/display", params={"wire": "gzip"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/gzip"
    assert "content-encoding" not in r.headers
    assert gzip.decompress(r.content)[:4] == b"ND2P"
    assert r.headers["cache-control"] == "no-store"

    tile = client.get(f"/api/files/{rec['id']}/slide/tile", params={"level": 0, "x": 0, "y": 0})
    assert tile.headers["cache-control"] == "private, max-age=3600"
    tile = client.get(f"/api/files/{rec['id']}/slide/tile", params={"level": 0, "x": 0, "y": 0, "v": "1.5"})
    assert tile.headers["cache-control"] == "private, max-age=604800"
    admin.put("/api/admin/performance", json={"local_cache": False})
    tile = client.get(f"/api/files/{rec['id']}/slide/tile", params={"level": 0, "x": 0, "y": 0, "v": "1.5"})
    assert tile.headers["cache-control"] == "private, max-age=3600"


def test_display_is_reduced_to_preview_size():
    planes = [np.full((5000, 3000), 1000, dtype=np.uint16), np.arange(5000 * 3000, dtype=np.uint16).reshape(5000, 3000)]
    limits = prepare._limits(planes, [])
    body = prepare._display_bytes(planes, [], limits)
    h, w = int.from_bytes(body[8:12], "little"), int.from_bytes(body[12:16], "little")
    assert max(h, w) <= prepare.DISPLAY_EDGE
    assert (h, w) == (5000 // 3, 3000 // 3)
    small = [np.zeros((512, 700), dtype=np.uint16)]
    body = prepare._display_bytes(small, [], prepare._limits(small, []))
    assert (int.from_bytes(body[8:12], "little"), int.from_bytes(body[12:16], "little")) == (512, 700)


def test_startup_stamps_versions_on_old_records(client, tmp_path):
    from nd2utils.store import load_index, patch_files

    path = tmp_path / "e.ome.tif"
    _write_slide(path)
    rec = _upload(client, path)
    prepare.wait_idle()
    patch_files({rec["id"]: {"prepared_at": None}})
    prepare.schedule_missing()
    stamped = load_index()[rec["id"]]["prepared_at"]
    assert stamped == round((settings.cache_dir / rec["id"] / "display_0_0_0.bin.gz").stat().st_mtime, 3)
