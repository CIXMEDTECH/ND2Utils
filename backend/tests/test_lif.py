from __future__ import annotations

import struct
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import quoteattr
from zipfile import ZipFile

import numpy as np
import pytest
import tifffile
from PIL import Image

from conftest import ROOT
from nd2utils import lifio, prepare
from nd2utils.store import get_owned_file, source_path

DEMO_LIF = ROOT / "ND2demo" / "BRD9_VECTOR.lif"
_DIM_IDS = {"X": 1, "Y": 2, "Z": 3, "T": 4}


def _block(payload: bytes) -> bytes:
    return struct.pack("<IIB", 0x70, len(payload), 0x2A) + payload


def _image_xml(name: str, data: np.ndarray, dims: str, luts: list[str], bits: int, block_id: str) -> str:
    """XML element of one image. `data` is stored in C order with axes `dims` (e.g. "ZCYX")."""
    item = data.dtype.itemsize
    sizes = dict(zip(dims, data.shape))
    strides = {axis: stride for axis, stride in zip(dims, (s for s in np.empty(data.shape, data.dtype).strides))}
    channels = "".join(
        f'<ChannelDescription DataType="0" ChannelTag="0" Resolution="{bits}" NameOfMeasuredQuantity="" '
        f'Min="0" Max="{2**bits - 1}" Unit="" LUTName="{lut}" IsLUTInverted="0" '
        f'BytesInc="{c * strides.get("C", 0)}" BitInc="0" />'
        for c, lut in enumerate(luts)
    )
    dimensions = "".join(
        f'<DimensionDescription DimID="{_DIM_IDS[axis]}" NumberOfElements="{sizes[axis]}" Origin="0" '
        f'Length="{(sizes[axis] - 1) * (0.25e-6 if axis in "XY" else 1e-6)}" Unit="{"s" if axis == "T" else "m"}" '
        f'BitInc="0" BytesInc="{strides[axis] if axis != "X" else item}" />'
        for axis in dims
        if axis != "C"
    )
    hardware = (
        '<Attachment Name="HardwareSetting" Software="LAS X 5.0" SystemTypeName="STELLARIS 5">'
        '<ATLConfocalSettingDefinition ObjectiveName="HC PL APO 40x/1.30 OIL" Magnification="40" '
        'NumericalAperture="1.3" Zoom="2" Pinhole="0.0001" /></Attachment>'
    )
    return (
        f"<Element Name={quoteattr(name)} UniqueID=\"{block_id}-uuid\"><Data><Image><ImageDescription>"
        f"<Channels>{channels}</Channels><Dimensions>{dimensions}</Dimensions></ImageDescription>"
        f"{hardware}</Image></Data><Memory Size=\"{data.nbytes}\" MemoryBlockID=\"{block_id}\" /><Children /></Element>"
    )


def make_lif(path: Path) -> dict[str, np.ndarray]:
    """A small LIF project: a 12-bit 2-channel Z stack in a folder, and an 8-bit image at the top."""
    rng = np.random.default_rng(1)
    stack = rng.integers(0, 4096, size=(3, 2, 40, 48), dtype=np.uint16)  # Z C Y X
    single = rng.integers(0, 256, size=(1, 30, 32), dtype=np.uint8)  # C Y X
    single_xml = _image_xml("Series 1.5x", single[0], "YX", ["Gray"], 8, "MemBlock_3")
    stack_xml = _image_xml("Stack", stack, "ZCYX", ["Blue", "Green"], 12, "MemBlock_2")
    xml = (
        '<LMSDataContainerHeader Version="2"><Element Name="Demo.lif"><Data><Experiment /></Data>'
        '<Memory Size="0" MemoryBlockID="MemBlock_0" /><Children>'
        '<Element Name="Day 1"><Data><Collection /></Data><Memory Size="0" MemoryBlockID="MemBlock_1" />'
        f"<Children>{stack_xml}</Children></Element>{single_xml}"
        "</Children></Element></LMSDataContainerHeader>"
    )
    out = bytearray(_block(struct.pack("<I", len(xml)) + xml.encode("utf-16-le")))
    for block_id, data in (("MemBlock_0", b""), ("MemBlock_1", b""), ("MemBlock_2", stack.tobytes()), ("MemBlock_3", single.tobytes())):
        name = block_id.encode("utf-16-le")
        out += struct.pack("<IIBQBI", 0x70, 0, 0x2A, len(data), 0x2A, len(block_id)) + name + data
    path.write_bytes(bytes(out))
    return {"stack": stack, "single": single[0]}


def _upload(client, path: Path, folder: str = "") -> dict:
    r = client.post("/api/files", params={"folder": folder}, files={"file": (path.name, path.read_bytes(), "application/octet-stream")})
    assert r.status_code == 200, r.text
    return r.json()


def _export(client, body: dict) -> ZipFile:
    r = client.post("/api/export", json=body)
    assert r.status_code == 200, r.text
    job = client.get(f"/api/jobs/{r.json()['id']}").json()
    assert job["status"] == "done", job
    return ZipFile(BytesIO(client.get(f"/api/jobs/{job['id']}/download").content))


@pytest.fixture
def lif_file(tmp_path: Path) -> tuple[Path, dict[str, np.ndarray]]:
    path = tmp_path / "Demo.lif"
    return path, make_lif(path)


def test_lif_becomes_a_folder_with_one_file_per_image(client, lif_file):
    path, data = lif_file
    rec = _upload(client, path, "exp")
    assert rec["imported"] == {"folder": "exp/Demo", "count": 2}
    listing = client.get("/api/files").json()
    by_name = {f["name"]: f for f in listing["files"]}
    assert set(by_name) == {"Stack", "Series 1.5x"}
    assert by_name["Stack"]["folder"] == "exp/Demo/Day 1"
    assert by_name["Series 1.5x"]["folder"] == "exp/Demo"
    assert {"exp", "exp/Demo", "exp/Demo/Day 1"} <= set(listing["folders"])

    stack = by_name["Stack"]
    assert stack["format"] == "lif"
    assert stack["width"] == 48 and stack["height"] == 40
    assert {a["name"]: a["size"] for a in stack["axes"]} == {"Z": 3, "C": 2, "Y": 40, "X": 48}
    assert stack["bits_significant"] == 12
    assert [c["color"] for c in stack["channels"]] == [[40, 110, 255], [0, 255, 0]]
    assert stack["objective"] == "HC PL APO 40x/1.30 OIL" and stack["na"] == 1.3
    assert stack["instrument"] == "Leica STELLARIS 5"
    assert stack["voxel_um"] == pytest.approx([0.25, 0.25, 1.0])
    assert stack["size_bytes"] == data["stack"].nbytes

    # The project data is stored once: every image is a hard link to the same upload.
    assert source_path(stack["id"]).stat().st_ino == source_path(by_name["Series 1.5x"]["id"]).stat().st_ino

    detail = client.get(f"/api/files/{stack['id']}").json()
    assert detail["text_info"]["Project path"] == "Day 1/Stack"
    assert detail["text_info"]["Zoom"] == "2"


def test_lif_planes_preview_projection_and_histogram(client, lif_file):
    path, data = lif_file
    _upload(client, path)
    prepare.wait_idle()
    files = {f["name"]: f for f in client.get("/api/files").json()["files"]}
    fid = files["Stack"]["id"]
    assert files["Stack"]["prepare"] == "ready"

    # Raw planes keep native values: channel 1 at Z=2.
    plane = client.get(f"/api/files/{fid}/plane", params={"z": 2})
    assert plane.status_code == 200 and plane.content[:4] == b"ND2P"
    header = 4 + 2 + 2 + 4 + 4 + 4
    per = 32 + 4 + 8 + 40 * 48 * 2
    start = header + per + 32 + 4 + 8
    raw = np.frombuffer(plane.content[start : start + 40 * 48 * 2], dtype=np.uint16).reshape(40, 48)
    np.testing.assert_array_equal(raw, data["stack"][2, 1])

    preview = client.get(f"/api/files/{fid}/preview", params={"scale_bar": "false"})
    assert Image.open(BytesIO(preview.content)).size == (48, 40)
    assert client.get(f"/api/files/{fid}/display").status_code == 200
    assert client.get(f"/api/files/{fid}/projection", params={"axis": "Z"}).status_code == 200
    hist = client.get(f"/api/files/{fid}/histogram", params={"c": 1}).json()
    assert hist["max"] > 0

    single = files["Series 1.5x"]["id"]
    assert client.get(f"/api/files/{single}/preview").status_code == 200
    assert client.get(f"/api/files/{single}/projection", params={"axis": "Z"}).status_code == 400


def test_lif_export_keeps_values_and_names(client, lif_file):
    path, data = lif_file
    _upload(client, path)
    zf = _export(client, {"folders": ["Demo"], "format": "ome-tiff", "channels_mode": "split", "scope": "all"})
    names = set(zf.namelist())
    # Image names without an extension are kept whole ("Series 1.5x" does not lose ".5x").
    assert "Demo/Series_1.5x_Channel_1.ome.tif" in names
    assert {f"Demo/Day 1/Stack_Z{z:03d}_Channel_{c}.ome.tif" for z in (1, 2, 3) for c in (1, 2)} <= names
    values = tifffile.imread(BytesIO(zf.read("Demo/Day 1/Stack_Z002_Channel_2.ome.tif")))
    assert values.dtype == np.uint16
    np.testing.assert_array_equal(np.squeeze(values), data["stack"][1, 1])


def test_lif_rename_reupload_and_delete(client, lif_file):
    path, _ = lif_file
    _upload(client, path)
    files = {f["name"]: f for f in client.get("/api/files").json()["files"]}
    stack = files["Stack"]
    # Names of LIF images carry no extension; any valid name works.
    r = client.patch(f"/api/files/{stack['id']}", json={"name": "Stack renamed"})
    assert r.status_code == 200 and r.json()["name"] == "Stack renamed"
    assert client.patch(f"/api/files/{stack['id']}", json={"name": "a/"}).status_code == 400

    # Uploading the project again replaces images with the same name, like re-uploading an ND2 file.
    _upload(client, path)
    names = sorted(f["name"] for f in client.get("/api/files").json()["files"])
    assert names == ["Series 1.5x", "Stack", "Stack renamed"]

    # Deleting one image keeps the others readable (each holds its own link to the data).
    single = next(f for f in client.get("/api/files").json()["files"] if f["name"] == "Series 1.5x")
    client.delete(f"/api/files/{stack['id']}")
    assert get_owned_file(stack["id"], client.code_id) is None
    assert client.get(f"/api/files/{single['id']}/preview").status_code == 200


def test_lif_admin_copy_between_workspaces(admin, client, lif_file):
    path, _ = lif_file
    _upload(client, path)
    r = admin.post(
        "/api/admin/transfer",
        json={"source": client.code_id, "target": client.code_id, "folders": ["Demo"], "target_folder": "copy", "mode": "copy"},
    )
    assert r.status_code == 200 and r.json()["copied"] == 2
    copied = next(f for f in client.get("/api/files").json()["files"] if f["folder"] == "copy/Demo/Day 1")
    assert client.get(f"/api/files/{copied['id']}/plane").status_code == 200


def test_reject_broken_lif(client, tmp_path):
    bad = tmp_path / "broken.lif"
    bad.write_bytes(b"not a leica file at all")
    r = client.post("/api/files", files={"file": (bad.name, bad.read_bytes(), "application/octet-stream")})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "not_lif"
    assert not client.get("/api/files").json()["files"]


def test_project_folder_name():
    assert lifio.project_folder_name("BRD9 VECTOR.lif") == "BRD9 VECTOR"
    assert lifio.project_folder_name("a/b.LIF") == "a_b"


@pytest.mark.skipif(not DEMO_LIF.is_file(), reason="ND2demo fixtures are local-only and not shipped in git")
def test_demo_lif_project(client):
    rec = _upload(client, DEMO_LIF)
    assert rec["imported"]["count"] == 15
    files = [f for f in client.get("/api/files").json()["files"] if f["folder"] == "BRD9_VECTOR"]
    assert len(files) == 15
    first = next(f for f in files if f["name"] == "Series001")
    assert [c["name"] for c in first["channels"]] == ["DAPI", "ALEXA 488", "ALEXA 594"]
    assert first["magnification"] == 63 and first["na"] == 1.4
    assert client.get(f"/api/files/{first['id']}/preview").status_code == 200
