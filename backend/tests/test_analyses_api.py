from __future__ import annotations

import time
from io import BytesIO
from zipfile import ZipFile

import tifffile
from comet_synth import SPECS, comet_image
from conftest import wait_job


def _upload_tiff(client, tmp_path, name="comets.tif", tail="right"):
    img, _ = comet_image(SPECS, tail=tail)
    path = tmp_path / name
    tifffile.imwrite(path, img)
    with path.open("rb") as fh:
        r = client.post("/api/files", params={"folder": "assay/ctrl"}, files={"file": (name, fh)})
    assert r.status_code == 200, r.text
    return r.json()


def _wait(client, analysis_id, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        rec = client.get(f"/api/analyses/{analysis_id}").json()
        if rec["status"] == "done":
            return rec
        time.sleep(0.1)
    raise AssertionError(rec)


def test_comet_analysis_end_to_end(client, tmp_path):
    f = _upload_tiff(client, tmp_path)
    r = client.post("/api/analyses", json={"name": "ctrl vs dox", "file_ids": [f["id"]]})
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    rec = _wait(client, aid)
    item = rec["files"][0]
    assert item["group"] == "assay/ctrl" and item["counts"]["valid"] + item["counts"]["outlier"] == len(SPECS)

    res = client.get(f"/api/analyses/{aid}/results/{f['id']}").json()
    counted = [c for c in res["comets"] if c["status"] != "invalid"]
    assert len(counted) == len(SPECS)
    assert client.get(f"/api/analyses/{aid}/image/{f['id']}").headers["content-type"] == "image/png"

    # Delete one comet by hand: it leaves the statistics, not the result.
    victim = counted[0]["key"]
    client.patch(f"/api/analyses/{aid}/results/{f['id']}", json={"deleted": [victim]})
    stats = client.get(f"/api/analyses/{aid}/summary", params={"include_outliers": True}).json()
    assert stats["total"] == len(SPECS) - 1
    group = stats["groups"][0]
    assert group["group"] == "assay/ctrl" and group["metrics"]["TailDNAPercent"]["n"] == len(SPECS) - 1

    # Regroup and rename.
    rec = client.patch(f"/api/analyses/{aid}", json={"groups": {f["id"]: "Control"}, "name": "Exp 1"}).json()
    assert rec["files"][0]["group"] == "Control" and rec["name"] == "Exp 1"

    job = wait_job(client, client.post(f"/api/analyses/{aid}/export").json()["id"])
    assert job["status"] == "done", job
    zf = ZipFile(BytesIO(client.get(f"/api/jobs/{job['id']}/download").content))
    names = zf.namelist()
    assert "comets.csv" in names and "summary.csv" in names and any(n.startswith("overlays/") for n in names)
    rows = zf.read("comets.csv").decode("utf-8-sig").splitlines()
    assert rows[0].startswith("Group,FileName,Num,Flag,CometArea")
    assert sum(1 for row in rows[1:] if ",deleted," in row) == 1

    assert client.delete(f"/api/analyses/{aid}").status_code == 200
    assert client.get(f"/api/analyses/{aid}").status_code == 404


def test_per_image_direction_override(client, tmp_path):
    f = _upload_tiff(client, tmp_path, "up.tif", tail="up")
    aid = client.post("/api/analyses", json={"file_ids": [f["id"]], "params": {"tail": "right"}}).json()["id"]
    _wait(client, aid)
    client.patch(f"/api/analyses/{aid}/results/{f['id']}", json={"params": {"tail": "up"}})
    rec = _wait(client, aid)
    assert rec["files"][0]["override"] == {"tail": "up"}
    assert rec["files"][0]["counts"]["valid"] + rec["files"][0]["counts"]["outlier"] == len(SPECS)


def test_analyses_are_private(client, admin, tmp_path):
    f = _upload_tiff(client, tmp_path)
    aid = client.post("/api/analyses", json={"file_ids": [f["id"]], "run": False}).json()["id"]
    assert admin.get(f"/api/analyses/{aid}").status_code == 404
    assert admin.post("/api/analyses", json={"file_ids": [f["id"]]}).status_code == 404
