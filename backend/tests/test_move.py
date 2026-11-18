from __future__ import annotations

from nd2utils import prepare


def _upload(client, path, folder=""):
    with path.open("rb") as fh:
        r = client.post("/api/files", params={"folder": folder}, files={"file": (path.name, fh)})
    assert r.status_code == 200, r.text
    return r.json()


def _files(client):
    return {f["id"]: f for f in client.get("/api/files").json()["files"]}


def _move(client, **body):
    return client.post("/api/items/move", json=body)


def test_move_files_and_folders_like_a_file_manager(client, sample_files):
    a = _upload(client, sample_files[0], "exp/day1")
    b = _upload(client, sample_files[1], "exp/day1/sub")
    c = _upload(client, sample_files[2], "inbox")
    prepare.wait_idle()
    before = _files(client)

    r = _move(client, file_ids=[c["id"]], target_folder="exp")
    assert r.status_code == 200 and r.json()["moved"] == 1
    # The whole folder (with its subfolder) goes below the target and keeps its name.
    r = _move(client, folders=["exp/day1"], target_folder="archive")
    assert r.json()["moved"] == 2
    files = _files(client)
    assert files[a["id"]]["folder"] == "archive/day1"
    assert files[b["id"]]["folder"] == "archive/day1/sub"
    assert files[c["id"]]["folder"] == "exp"
    folders = client.get("/api/files").json()["folders"]
    assert "archive/day1/sub" in folders and "exp/day1" not in folders
    # Metadata only: the preview cache version does not change.
    assert files[a["id"]]["prepared_at"] == before[a["id"]]["prepared_at"]


def test_cannot_move_folder_into_itself(client, sample_files):
    _upload(client, sample_files[0], "x/y")
    assert _move(client, folders=["x"], target_folder="x/y").status_code == 400
    assert _move(client, folders=["x"], target_folder="x").status_code == 400


def test_name_clash_skip_rename_replace(client, sample_files):
    first = _upload(client, sample_files[0], "a")
    second = _upload(client, sample_files[0], "b")  # same name, other folder
    r = _move(client, file_ids=[second["id"]], target_folder="a")
    assert r.json()["skipped"] == 1 and _files(client)[second["id"]]["folder"] == "b"
    r = _move(client, file_ids=[second["id"]], target_folder="a", conflict="rename")
    moved = _files(client)[second["id"]]
    assert moved["folder"] == "a" and moved["name"] == sample_files[0].stem + " (2)" + sample_files[0].suffix
    third = _upload(client, sample_files[0], "c")
    r = _move(client, file_ids=[third["id"]], target_folder="a", conflict="replace")
    assert r.json()["replaced"] == 1
    files = _files(client)
    assert first["id"] not in files and files[third["id"]]["folder"] == "a"


def test_undo_restores_places(client, sample_files):
    a = _upload(client, sample_files[0], "p/q")
    b = _upload(client, sample_files[1], "r")
    r = _move(client, file_ids=[b["id"]], folders=["p/q"], target_folder="z")
    undo = r.json()["undo"]
    assert client.post("/api/items/undo-move", json=undo).json()["restored"] == 2
    files = _files(client)
    assert files[a["id"]]["folder"] == "p/q" and files[b["id"]]["folder"] == "r"
    folders = client.get("/api/files").json()["folders"]
    assert "z/q" not in folders and "p/q" in folders


def test_cannot_move_other_workspaces_files(client, admin, sample_files):
    theirs = _upload(admin, sample_files[0], "theirs")
    assert _move(client, file_ids=[theirs["id"]], target_folder="mine").status_code == 404
    assert _move(client, folders=["theirs"], target_folder="mine").status_code == 404


def test_thumbnail(client, sample_files):
    rec = _upload(client, sample_files[0])
    prepare.wait_idle()
    r = client.get(f"/api/files/{rec['id']}/thumb", params={"v": "1"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert "immutable" in r.headers["cache-control"]
    from io import BytesIO

    from PIL import Image

    img = Image.open(BytesIO(r.content))
    assert max(img.size) <= 256
