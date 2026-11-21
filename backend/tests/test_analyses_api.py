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


def _upload_array(client, tmp_path, name, array, folder):
    path = tmp_path / name
    tifffile.imwrite(path, array)
    with path.open("rb") as fh:
        r = client.post("/api/files", params={"folder": folder}, files={"file": (name, fh)})
    assert r.status_code == 200, r.text
    return r.json()


def test_comet_preview_stores_nothing(client, tmp_path):
    f = _upload_tiff(client, tmp_path)
    aid = client.post("/api/analyses", json={"file_ids": [f["id"]], "run": False}).json()["id"]
    r = client.post(f"/api/analyses/{aid}/preview", json={"file_id": f["id"], "params": {"min_area": 200, "threshold_offset": 3}})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["preview"] is True and res["params"]["min_area"] == 200 and res["params"]["threshold_offset"] == 3
    assert len([c for c in res["comets"] if c["status"] != "invalid"]) == len(SPECS)
    # Nothing analysed or stored.
    assert client.get(f"/api/analyses/{aid}/results/{f['id']}").status_code == 202
    rec = client.get(f"/api/analyses/{aid}").json()
    assert rec["status"] == "idle" and rec["params"]["threshold_offset"] == 0


def test_edu_analysis_end_to_end(client, tmp_path):
    from edu_synth import edu_field

    dapi, edu_img, truth = edu_field()
    d = _upload_array(client, tmp_path, "well1_0001_DAPI.tif", dapi, "edu/ctrl")
    g = _upload_array(client, tmp_path, "well1_0001_GFP.tif", edu_img, "edu/ctrl")
    lonely = _upload_array(client, tmp_path, "well2_0001_DAPI.tif", dapi, "edu/ctrl")

    pairing = client.post("/api/analyses/pairing", json={"folders": ["edu/ctrl"]}).json()
    assert [(f["nucleus"], f["edu"]) for f in pairing["fields"]] == [("well1_0001_DAPI.tif", "well1_0001_GFP.tif")]
    assert pairing["unpaired"] == [{"file_id": lonely["id"], "name": "well2_0001_DAPI.tif", "reason": "no_edu"}]
    # Nothing to pair → a clear error.
    r = client.post("/api/analyses", json={"type": "edu", "file_ids": [lonely["id"]]})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "no_fields"

    rec = client.post("/api/analyses", json={"type": "edu", "folders": ["edu/ctrl"], "run": False}).json()
    aid = rec["id"]
    assert rec["type"] == "edu" and rec["file_count"] == 1 and rec["status"] == "idle"
    item = rec["files"][0]
    assert item["file_id"] == d["id"] and item["partner"]["file_id"] == g["id"] and item["name"] == "well1_0001"

    prev = client.post(f"/api/analyses/{aid}/preview", json={"file_id": d["id"], "params": {"split_strength": 2.5}}).json()
    assert prev["preview"] is True and abs(len(prev["nuclei"]) - truth["nuclei"]) <= 2
    assert prev["nucleus"]["file_id"] == d["id"] and prev["edu"]["file_id"] == g["id"]
    assert client.get(f"/api/analyses/{aid}/results/{d['id']}").status_code == 202

    client.post(f"/api/analyses/{aid}/run", json={})
    rec = _wait(client, aid)
    counts = rec["files"][0]["counts"]
    assert abs(counts["nuclei"] - truth["nuclei"]) <= 2 and abs(counts["positive"] - truth["positive"]) <= 1
    assert rec["pooled_thresholds"]["li"] > 0
    for role in ("nucleus", "edu"):
        assert client.get(f"/api/analyses/{aid}/image/{d['id']}", params={"role": role}).headers["content-type"] == "image/png"

    # Flip a negative nucleus to positive and exclude another.
    res = client.get(f"/api/analyses/{aid}/results/{d['id']}").json()
    threshold = rec["files"][0]["threshold"]
    neg = [n["key"] for n in res["nuclei"] if n["edu"] <= threshold]
    client.patch(f"/api/analyses/{aid}/results/{d['id']}", json={"marks": {str(neg[0]): "positive", str(neg[1]): "excluded"}})
    rec = client.get(f"/api/analyses/{aid}").json()
    assert rec["files"][0]["counts"]["positive"] == counts["positive"] + 1
    assert rec["files"][0]["counts"]["nuclei"] == counts["nuclei"] - 1
    assert client.get(f"/api/analyses/{aid}/results/{d['id']}").json()["marks"][str(neg[0])] == "positive"

    # Classification-only parameters keep the hand edits; switching the counting mode needs no run.
    client.patch(f"/api/analyses/{aid}", json={"params": {"count_mode": "independent", "edu_method": "otsu"}})
    stats = client.get(f"/api/analyses/{aid}/summary").json()
    assert stats["count_mode"] == "independent"
    group = stats["groups"][0]
    assert group["group"] == "edu/ctrl" and group["fields"] == 1 and group["nuclei"] == counts["nuclei"] - 1
    assert group["independent"] >= truth["positive"]

    job = wait_job(client, client.post(f"/api/analyses/{aid}/export").json()["id"])
    assert job["status"] == "done", job
    zf = ZipFile(BytesIO(client.get(f"/api/jobs/{job['id']}/download").content))
    names = zf.namelist()
    for n in ("fields.csv", "summary.csv", "nuclei.csv", "edu_objects.csv", "parameters.json"):
        assert n in names
    assert any(n.startswith("overlays/") and n.endswith("_edu.png") for n in names)
    fields = zf.read("fields.csv").decode("utf-8-sig").splitlines()
    assert fields[0].startswith("Group,Field,NucleusFile") and "well1_0001" in fields[1]
    nuclei = zf.read("nuclei.csv").decode("utf-8-sig").splitlines()
    assert sum(1 for row in nuclei[1:] if row.endswith(",yes")) == 2
