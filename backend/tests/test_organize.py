from __future__ import annotations

from nd2utils.main import magnification_label


def _upload(client, path, folder=""):
    with path.open("rb") as fh:
        r = client.post("/api/files", params={"folder": folder}, files={"file": (path.name, fh)})
    assert r.status_code == 200, r.text
    return r.json()


def test_labels():
    assert magnification_label({"magnification": 100.0, "zoom": 1.0}, "?") == "100x"
    assert magnification_label({"magnification": 100.0, "zoom": 3.0}, "?") == "100x zoom3"
    assert magnification_label({"magnification": 60.0, "zoom": 1.2105}, "?") == "60x zoom1.21"
    assert magnification_label({"magnification": None}, "未知倍镜") == "未知倍镜"


def test_identify_reads_zoom_and_calibration(client, sample_files):
    rec = _upload(client, sample_files[0])
    detail = client.get(f"/api/files/{rec['id']}").json()
    assert detail["calibrated"] is True
    assert detail["zoom"] is not None and detail["magnification"] == 100


def test_organize_preview_then_apply(client, sample_files):
    recs = [_upload(client, path, "exp/day1") for path in sample_files]
    preview = client.post("/api/organize/magnification", json={"folder": "exp"}).json()
    assert preview["files"] == len(recs)
    files = {f["id"]: f for f in client.get("/api/files").json()["files"]}
    for group in preview["groups"]:
        assert group["source"] == "exp/day1"
        assert group["target"] == f"exp/day1/{group['label']}"
        for fid in group["file_ids"]:
            assert magnification_label(files[fid], "未知倍镜") == group["label"]
    # Nothing moved by a preview.
    assert all(f["folder"] == "exp/day1" for f in files.values())

    done = client.post("/api/organize/magnification", json={"folder": "exp", "apply": True}).json()
    assert done["moved"] == len(recs)
    files = {f["id"]: f for f in client.get("/api/files").json()["files"]}
    assert all(f["folder"].startswith("exp/day1/") for f in files.values())
    # Already sorted: a second run has nothing to do.
    assert client.post("/api/organize/magnification", json={"folder": "exp"}).json()["groups"] == []
    # And it can be undone.
    assert client.post("/api/items/undo-move", json=done["undo"]).json()["restored"] == len(recs)
    folders = client.get("/api/files").json()["folders"]
    assert not any(f.startswith("exp/day1/") for f in folders)
