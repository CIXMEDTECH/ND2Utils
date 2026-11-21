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


def _tiff(client, tmp_path, name, folder):
    import numpy as np
    import tifffile

    path = tmp_path / name
    tifffile.imwrite(path, np.full((32, 32), 7, np.uint8))
    with path.open("rb") as fh:
        r = client.post("/api/files", params={"folder": folder}, files={"file": (name, fh)})
    assert r.status_code == 200, r.text
    return r.json()


def test_regroup_keeps_experiment_folders(client, tmp_path):
    a = _tiff(client, tmp_path, "a_40x.tif", "exp/day1/未知倍镜")  # sorted before its magnification was known
    b = _tiff(client, tmp_path, "b_100x.tif", "exp/day1/100x")  # already right
    c = _tiff(client, tmp_path, "c_40x.tif", "exp/day1/100x/40x")  # nested by an earlier re-sort
    d = _tiff(client, tmp_path, "d_40x.tif", "exp/day2")  # never sorted
    e = _tiff(client, tmp_path, "e_20x.tif", "other")  # outside the folder
    client.post("/api/folders", json={"path": "exp/day1/10x"})  # an empty magnification folder stays

    # The normal sort would nest: it only looks at the last folder name.
    plain = client.post("/api/organize/magnification", json={"folder": "exp"}).json()
    assert {g["target"] for g in plain["groups"]} >= {"exp/day1/未知倍镜/40x"}

    preview = client.post("/api/organize/magnification", json={"folder": "exp", "regroup": True}).json()
    assert preview["regroup"] is True and preview["unchanged"] == 1  # b
    targets = {fid: g["target"] for g in preview["groups"] for fid in g["file_ids"]}
    assert targets == {a["id"]: "exp/day1/40x", c["id"]: "exp/day1/40x", d["id"]: "exp/day2/40x"}
    # 100x still holds b; the emptied magnification folders go.
    assert preview["folders_to_prune"] == ["exp/day1/100x/40x", "exp/day1/未知倍镜"]

    done = client.post("/api/organize/magnification", json={"folder": "exp", "regroup": True, "apply": True}).json()
    assert done["moved"] == 3 and done["pruned"] == ["exp/day1/100x/40x", "exp/day1/未知倍镜"]
    listing = client.get("/api/files").json()
    folders = {f["id"]: f["folder"] for f in listing["files"]}
    assert folders[a["id"]] == "exp/day1/40x" and folders[d["id"]] == "exp/day2/40x" and folders[e["id"]] == "other"
    assert folders[b["id"]] == "exp/day1/100x" and folders[c["id"]] == "exp/day1/40x"
    assert "exp/day1/未知倍镜" not in listing["folders"] and "exp/day1/10x" in listing["folders"]

    # Undo puts the files and the removed folder back.
    assert client.post("/api/items/undo-move", json=done["undo"]).json()["restored"] == 3
    listing = client.get("/api/files").json()
    assert {f["id"]: f["folder"] for f in listing["files"]}[a["id"]] == "exp/day1/未知倍镜"
    assert "exp/day1/未知倍镜" in listing["folders"]
