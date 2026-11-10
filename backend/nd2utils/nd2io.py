from __future__ import annotations

import json
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock
from typing import Any, Iterator

import nd2
import numpy as np
import tifffile

from nd2utils import lifio
from nd2utils.config import settings
from nd2utils.jsonutil import jsonable

MAGIC = b"ND2 FILE SIGNATURE"
PLANE_MAGIC = b"ND2P"
CROP_SIDECAR = "crop.json"
EDITS_SIDECAR = "edits.json"
_TIFF_MAGICS = (b"II*\0", b"MM\0*", b"II+\0", b"MM\0+")


def read_crop(path: Path) -> tuple[int, int, int, int] | None:
    """Return (x, y, w, h) from crop.json alongside `path` if present."""
    sidecar = path.parent / CROP_SIDECAR
    if not sidecar.is_file():
        return None
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        x, y, w, h = int(data["x"]), int(data["y"]), int(data["w"]), int(data["h"])
        if w > 0 and h > 0 and x >= 0 and y >= 0:
            return (x, y, w, h)
    except Exception:
        pass
    return None


def write_crop(directory: Path, x: int, y: int, w: int, h: int, extra: dict[str, Any] | None = None) -> None:
    payload: dict[str, Any] = {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}
    if extra:
        payload.update(extra)
    (directory / CROP_SIDECAR).write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def clear_crop(directory: Path) -> None:
    (directory / CROP_SIDECAR).unlink(missing_ok=True)


def read_edits(path: Path) -> dict[str, Any] | None:
    """Return edits dict from edits.json alongside `path` (or inside directory) if present."""
    sidecar = (path if path.is_dir() else path.parent) / EDITS_SIDECAR
    if not sidecar.is_file():
        return None
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def write_edits(directory: Path, payload: dict[str, Any]) -> None:
    (directory / EDITS_SIDECAR).write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def clear_edits(directory: Path) -> None:
    (directory / EDITS_SIDECAR).unlink(missing_ok=True)


def _is_tiff(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            head = fh.read(4)
        return head in _TIFF_MAGICS
    except OSError:
        return False


class Nd2Error(Exception):
    def __init__(self, message: str, code: str = "nd2_error"):
        super().__init__(message)
        self.code = code


def validate_magic(path: Path) -> None:
    with path.open("rb") as fh:
        head = fh.read(96)
    if MAGIC not in head:
        raise Nd2Error("Not a Nikon ND2 file (missing ND2 signature).", "not_nd2")


def _color_rgb(color: Any) -> list[int]:
    if color is None:
        return [255, 255, 255]
    if hasattr(color, "r"):
        return [int(color.r), int(color.g), int(color.b)]
    if isinstance(color, (list, tuple)) and len(color) >= 3:
        return [int(color[0]), int(color[1]), int(color[2])]
    return [255, 255, 255]


def _axis_map(sizes: dict[str, int]) -> dict[str, str]:
    """Map canonical T/Z/C/P/Y/X onto the file's actual axis names."""
    keys = list(sizes.keys())
    mapping: dict[str, str] = {}
    aliases = {
        "T": ("T", "Time"),
        "Z": ("Z",),
        "C": ("C",),
        "P": ("P", "XY", "M", "Position"),
        "Y": ("Y",),
        "X": ("X",),
        "S": ("S",),
    }
    used: set[str] = set()
    for canon, opts in aliases.items():
        for opt in opts:
            if opt in sizes and opt not in used:
                mapping[canon] = opt
                used.add(opt)
                break
    for key in keys:
        if key not in used and key not in mapping.values():
            mapping[key] = key
    return mapping


def axis_size(sizes: dict[str, int], canon: str) -> int:
    mapping = _axis_map(sizes)
    key = mapping.get(canon)
    return int(sizes[key]) if key else 1


def _lut_from_custom(custom: dict[str, Any], n_channels: int) -> list[tuple[float | None, float | None, float]]:
    out: list[tuple[float | None, float | None, float]] = [(None, None, 1.0)] * n_channels
    lut = custom.get("LUTDataV1_0") if isinstance(custom, dict) else None
    if not isinstance(lut, dict):
        return out
    params = lut.get("LutParam") or lut.get("m_sLutParam") or {}
    comps = params.get("CompLutParam") or params.get("sCompLutParam") or {}
    if not isinstance(comps, dict):
        return out
    items = []
    for key in sorted(comps.keys()):
        items.append(comps[key])
    for i in range(min(n_channels, len(items))):
        c = items[i] if i < len(items) else {}
        if not isinstance(c, dict):
            continue
        vmax = None
        vmin = 0.0
        gamma = float(c.get("GammaSrc") or c.get("dGammaSrc") or 1.0)
        for k, v in c.items():
            if isinstance(v, (int, float)) and "Max" in k and "Dst" not in k and "Src" in k:
                vmax = float(v)
            if isinstance(v, (int, float)) and k.endswith("0001"):
                vmax = float(v)
        out[i] = (vmin, vmax, gamma)
    return out


@dataclass
class OpenNd2:
    """An open image: an ND2 file, a cropped TIFF, or one image of a Leica LIF project."""

    path: Path
    nd: Any
    sizes: dict[str, int]
    array: Any
    is_rgb: bool = False
    crop: tuple[int, int, int, int] | None = None
    lock: RLock = field(default_factory=RLock, repr=False)

    def close(self) -> None:
        with self.lock:
            try:
                self.nd.close()
            except Exception:
                pass


_OPEN: OrderedDict[str, OpenNd2] = OrderedDict()
_MAX_OPEN = 6
_OPEN_LOCK = RLock()


def set_max_open(limit: int) -> None:
    global _MAX_OPEN
    _MAX_OPEN = max(1, int(limit))
    with _OPEN_LOCK:
        while len(_OPEN) > _MAX_OPEN:
            _, old = _OPEN.popitem(last=False)
            old.close()


def _open_lif(path: Path) -> OpenNd2:
    lif, sizes, array, rgb = lifio.open_image(path)
    return OpenNd2(path=path, nd=lif, sizes=sizes, array=array, is_rgb=rgb)


def _open_tiff(path: Path) -> OpenNd2:
    tif = tifffile.TiffFile(path)
    try:
        series = tif.series[0]
        arr = series.asarray()
        axes = series.axes
        sizes = {ax: int(n) for ax, n in zip(axes, arr.shape)}
        rgb = sizes.get("S", 1) in (3, 4) and sizes.get("C", 1) == 1
        return OpenNd2(path=path, nd=tif, sizes=sizes, array=arr, is_rgb=rgb)
    except Exception:
        tif.close()
        raise


def _with_crop(handle: OpenNd2) -> OpenNd2:
    crop = read_crop(handle.path)
    if not crop:
        return handle
    x, y, w, h = crop
    sizes = dict(handle.sizes)
    mapping = _axis_map(sizes)
    x_key = mapping.get("X")
    y_key = mapping.get("Y")
    raw_w = int(sizes[x_key]) if x_key else w
    raw_h = int(sizes[y_key]) if y_key else h
    x0 = min(max(x, 0), max(raw_w - 1, 0))
    y0 = min(max(y, 0), max(raw_h - 1, 0))
    cw = max(1, min(w, raw_w - x0))
    ch = max(1, min(h, raw_h - y0))
    if x_key:
        sizes[x_key] = cw
    if y_key:
        sizes[y_key] = ch
    handle.sizes = sizes
    handle.crop = (x0, y0, cw, ch)
    return handle


def open_nd2(path: Path) -> OpenNd2:
    key = str(path.resolve())
    with _OPEN_LOCK:
        if key in _OPEN:
            cached = _OPEN[key]
            if cached.crop == read_crop(path):
                _OPEN.move_to_end(key)
                return cached
            _OPEN.pop(key, None)
            cached.close()
        if lifio.is_lif(path):
            handle = _open_lif(path)
        elif _is_tiff(path):
            handle = _open_tiff(path)
        else:
            nd = nd2.ND2File(path)
            try:
                sizes = dict(nd.sizes)
                nbytes = int(np.prod(list(sizes.values()) or [1]) * np.dtype(nd.dtype).itemsize)
                array = nd.asarray() if nbytes <= settings.in_memory_limit_bytes else nd.to_dask()
                handle = OpenNd2(path=path, nd=nd, sizes=sizes, array=array, is_rgb=bool(nd.is_rgb))
            except Exception:
                nd.close()
                raise
        handle = _with_crop(handle)
        _OPEN[key] = handle
        while len(_OPEN) > _MAX_OPEN:
            _, old = _OPEN.popitem(last=False)
            old.close()
        return handle


@contextmanager
def open_uncached(path: Path) -> Iterator[OpenNd2]:
    """A private, lazily-read handle (background preparation): it neither evicts the
    viewer's cached handles nor loads the whole file into memory."""
    if lifio.is_lif(path):
        handle = _with_crop(_open_lif(path))
        try:
            yield handle
        finally:
            handle.close()
        return
    if _is_tiff(path):
        handle = _with_crop(_open_tiff(path))
        try:
            yield handle
        finally:
            handle.close()
        return
    nd = nd2.ND2File(path)
    try:
        yield _with_crop(OpenNd2(path=path, nd=nd, sizes=dict(nd.sizes), array=nd.to_dask(), is_rgb=bool(nd.is_rgb)))
    finally:
        nd.close()


def close_nd2(path: Path) -> None:
    key = str(path.resolve())
    with _OPEN_LOCK:
        handle = _OPEN.pop(key, None)
    if handle:
        handle.close()


def close_all() -> None:
    with _OPEN_LOCK:
        handles = list(_OPEN.values())
        _OPEN.clear()
    for handle in handles:
        handle.close()


def identify_path(path: Path, file_id: str, name: str, size_bytes: int, created_at: float) -> dict[str, Any]:
    validate_magic(path)
    try:
        handle = open_nd2(path)
    except Nd2Error:
        raise
    except Exception as exc:
        raise Nd2Error(f"Failed to parse ND2: {exc}", "parse_failed") from exc

    nd = handle.nd
    sizes = handle.sizes
    mapping = _axis_map(sizes)
    channels: list[dict[str, Any]] = []
    objective = None
    mag = None
    na = None
    software = None
    instrument = None
    custom: dict[str, Any] = {}
    try:
        custom = dict(nd.custom_data or {})
    except Exception:
        custom = {}
    app = custom.get("AppInfo_V1_0") or {}
    if isinstance(app, dict):
        software = app.get("SWNameString")
        if app.get("VersionString"):
            software = f"{software} {app.get('VersionString')}".strip()
        instrument = app.get("GrabberString")

    md = nd.metadata
    lut_guess = _lut_from_custom(custom, axis_size(sizes, "C") or 1)
    md_channels = getattr(md, "channels", None) or []
    n_c = axis_size(sizes, "C")
    if nd.is_rgb:
        n_c = 1
        channels.append(
            {
                "index": 0,
                "name": "RGB",
                "color": [255, 255, 255],
                "emission_nm": None,
                "excitation_nm": None,
                "modality": [],
                "lut_min": 0,
                "lut_max": 255,
                "lut_gamma": 1.0,
                "suggested_min": 0,
                "suggested_max": 255,
            }
        )
    else:
        for i in range(max(n_c, len(md_channels) or 0) or 1):
            ch = md_channels[i] if i < len(md_channels) else None
            meta = getattr(ch, "channel", None) if ch is not None else None
            micro = getattr(ch, "microscope", None) if ch is not None else None
            name_c = getattr(meta, "name", None) or f"Channel {i + 1}"
            color = _color_rgb(getattr(meta, "color", None))
            emission = getattr(meta, "emissionLambdaNm", None)
            excitation = getattr(meta, "excitationLambdaNm", None)
            flags = list(getattr(micro, "modalityFlags", None) or [])
            if micro is not None:
                objective = objective or getattr(micro, "objectiveName", None)
                mag = mag if mag is not None else getattr(micro, "objectiveMagnification", None)
                na = na if na is not None else getattr(micro, "objectiveNumericalAperture", None)
            vmin, vmax, gamma = lut_guess[i] if i < len(lut_guess) else (None, None, 1.0)
            channels.append(
                {
                    "index": i,
                    "name": str(name_c),
                    "color": color,
                    "emission_nm": float(emission) if emission else None,
                    "excitation_nm": float(excitation) if excitation else None,
                    "modality": flags,
                    "lut_min": vmin,
                    "lut_max": vmax,
                    "lut_gamma": gamma,
                    "suggested_min": 0,
                    "suggested_max": None,
                }
            )

    text_info = {}
    try:
        raw_text = nd.text_info or {}
        text_info = {str(k): str(v) for k, v in dict(raw_text).items()}
    except Exception:
        text_info = {}
    if not objective:
        objective = text_info.get("optics")
    acquired = text_info.get("date")
    if not instrument:
        capturing = text_info.get("capturing") or text_info.get("description") or ""
        if capturing:
            instrument = capturing.splitlines()[0].strip() or None

    voxel = [1.0, 1.0, 1.0]
    try:
        vs = nd.voxel_size()
        voxel = [float(vs.x), float(vs.y), float(vs.z)]
    except Exception:
        pass

    bits_sig = getattr(nd.attributes, "bitsPerComponentSignificant", None)
    dtype = str(nd.dtype)
    data_max = float(np.iinfo(nd.dtype).max) if np.issubdtype(nd.dtype, np.integer) else 1.0
    if bits_sig:
        data_max = float(2 ** int(bits_sig) - 1)
    for ch in channels:
        if ch.get("suggested_max") is None:
            ch["suggested_max"] = data_max

    events: list[dict[str, Any]] = []
    try:
        ev = nd.events()
        if ev is not None:
            if hasattr(ev, "to_dict"):
                events = jsonable(ev.to_dict(orient="records"))
            elif isinstance(ev, list):
                events = jsonable(ev)
            else:
                events = jsonable(list(ev))
    except Exception:
        events = []

    experiment = []
    try:
        experiment = jsonable(nd.experiment)
    except Exception:
        experiment = []

    axes = [{"name": k, "size": int(v)} for k, v in sizes.items()]
    width = axis_size(sizes, "X")
    height = axis_size(sizes, "Y")

    groups = {
        "file": {
            "name": name,
            "size_bytes": size_bytes,
            "version": list(nd.version) if nd.version else None,
            "dtype": dtype,
            "shape": list(nd.shape),
            "axes": axes,
            "is_rgb": bool(nd.is_rgb),
            "bits_significant": bits_sig,
        },
        "optics": {
            "objective": objective,
            "magnification": mag,
            "numerical_aperture": na,
            "voxel_um": voxel,
        },
        "channels": channels,
        "instrument": {
            "name": instrument,
            "software": software,
            "acquired": acquired,
        },
        "experiment": experiment,
        "events": events,
    }

    return {
        "id": file_id,
        "name": name,
        "size_bytes": size_bytes,
        "status": "ready",
        "error": None,
        "version": list(nd.version) if nd.version else None,
        "dtype": dtype,
        "shape": list(nd.shape),
        "axes": axes,
        "width": width,
        "height": height,
        "channels": channels,
        "voxel_um": voxel,
        "objective": objective,
        "magnification": float(mag) if mag is not None else None,
        "na": float(na) if na is not None else None,
        "acquired": acquired,
        "instrument": instrument,
        "software": software,
        "bits_significant": int(bits_sig) if bits_sig else None,
        "is_rgb": bool(nd.is_rgb),
        "created_at": created_at,
        "text_info": text_info,
        "experiment": experiment,
        "events": events,
        "metadata": jsonable(md),
        "app_info": jsonable(app) if app else {},
        "groups": groups,
        "axis_map": mapping,
        "sizes": sizes,
    }


def _compute(arr: Any) -> np.ndarray:
    if hasattr(arr, "compute"):
        return np.asarray(arr.compute())
    return np.asarray(arr)


def _crop_planes(planes: list[np.ndarray], crop: tuple[int, int, int, int] | None) -> list[np.ndarray]:
    if not crop:
        return planes
    x, y, w, h = crop
    out: list[np.ndarray] = []
    for plane in planes:
        arr = np.asarray(plane)
        if arr.ndim >= 2:
            ph, pw = arr.shape[-2], arr.shape[-1]
            x0 = min(max(x, 0), max(pw - 1, 0))
            y0 = min(max(y, 0), max(ph - 1, 0))
            x1 = min(pw, max(x0 + 1, x0 + w))
            y1 = min(ph, max(y0 + 1, y0 + h))
            out.append(np.ascontiguousarray(arr[..., y0:y1, x0:x1]))
        else:
            out.append(arr)
    return out


def extract_channels(
    handle: OpenNd2,
    t: int = 0,
    z: int = 0,
    p: int = 0,
) -> tuple[list[np.ndarray], dict[str, int]]:
    sizes = handle.sizes
    mapping = _axis_map(sizes)
    index: list[Any] = []
    for ax in sizes:
        n = sizes[ax]
        if ax in (mapping.get("Y"), mapping.get("X"), mapping.get("S")):
            index.append(slice(None))
        elif ax == mapping.get("C"):
            index.append(slice(None))
        elif ax == mapping.get("T"):
            index.append(int(np.clip(t, 0, n - 1)))
        elif ax == mapping.get("Z"):
            index.append(int(np.clip(z, 0, n - 1)))
        elif ax == mapping.get("P"):
            index.append(int(np.clip(p, 0, n - 1)))
        else:
            index.append(0)
    with handle.lock:
        slab = _compute(handle.array[tuple(index)])
        is_rgb = handle.is_rgb
    # Remaining axes among C, Y, X, S
    remain = []
    for ax, spec in zip(sizes, index):
        if isinstance(spec, slice):
            remain.append(ax)
    # Normalize to list of 2D planes
    if is_rgb:
        if slab.ndim == 3 and slab.shape[-1] in (3, 4):
            planes = [slab[..., 0], slab[..., 1], slab[..., 2]]
            return _crop_planes(planes, handle.crop), sizes
        if slab.ndim == 3 and slab.shape[0] in (3, 4):
            return _crop_planes([slab[0], slab[1], slab[2]], handle.crop), sizes
    if slab.ndim == 2:
        return _crop_planes([slab], handle.crop), sizes
    # Identify C vs YX
    c_name = mapping.get("C")
    if c_name and c_name in remain:
        c_axis = remain.index(c_name)
        planes = [np.take(slab, i, axis=c_axis) for i in range(slab.shape[c_axis])]
        planes = [np.squeeze(p) for p in planes]
        return _crop_planes(planes, handle.crop), sizes
    if slab.ndim == 3:
        # guess smallest non-spatial as C
        return _crop_planes([np.squeeze(slab[i]) for i in range(slab.shape[0])], handle.crop), sizes
    return _crop_planes([np.squeeze(slab)], handle.crop), sizes


def iter_coords(sizes: dict[str, int]) -> Iterator[tuple[int, int, int]]:
    n_t = axis_size(sizes, "T")
    n_z = axis_size(sizes, "Z")
    n_p = axis_size(sizes, "P")
    for p in range(max(n_p, 1)):
        for t in range(max(n_t, 1)):
            for z in range(max(n_z, 1)):
                yield t, z, p


def projection(
    handle: OpenNd2,
    axis: str,
    mode: str,
    t: int = 0,
    z: int = 0,
    p: int = 0,
) -> list[np.ndarray]:
    sizes = handle.sizes
    mapping = _axis_map(sizes)
    ax_name = mapping.get(axis.upper())
    if not ax_name:
        return extract_channels(handle, t=t, z=z, p=p)[0]
    # Build index keeping Y,X,C and reducing the chosen axis
    index: list[Any] = []
    for ax in sizes:
        n = sizes[ax]
        if ax in (mapping.get("Y"), mapping.get("X"), mapping.get("S"), mapping.get("C")):
            index.append(slice(None))
        elif ax == ax_name:
            index.append(slice(None))
        elif ax == mapping.get("T"):
            index.append(int(np.clip(t, 0, n - 1)))
        elif ax == mapping.get("Z"):
            index.append(int(np.clip(z, 0, n - 1)))
        elif ax == mapping.get("P"):
            index.append(int(np.clip(p, 0, n - 1)))
        else:
            index.append(0)
    with handle.lock:
        slab = _compute(handle.array[tuple(index)])
    remain = [ax for ax, spec in zip(sizes, index) if isinstance(spec, slice)]
    reduce_at = remain.index(ax_name) if ax_name in remain else 0
    if mode == "min":
        reduced = slab.min(axis=reduce_at)
    elif mode == "mean":
        reduced = slab.mean(axis=reduce_at)
    else:
        reduced = slab.max(axis=reduce_at)
    reduced = np.squeeze(reduced)
    if reduced.ndim == 2:
        return _crop_planes([reduced], handle.crop)
    c_name = mapping.get("C")
    if c_name and c_name in remain and remain.index(c_name) != reduce_at:
        # C still present
        if reduced.ndim == 3:
            return _crop_planes([reduced[i] for i in range(reduced.shape[0])], handle.crop)
    if reduced.ndim == 3:
        return _crop_planes([reduced[i] for i in range(reduced.shape[0])], handle.crop)
    return _crop_planes([reduced], handle.crop)


def pack_planes(planes: list[np.ndarray], channels: list[dict[str, Any]]) -> bytes:
    if not planes:
        raise Nd2Error("No image planes.", "empty")
    first = np.asarray(planes[0])
    h, w = first.shape[-2], first.shape[-1]
    n = len(planes)
    if first.dtype == np.uint8:
        dtype_code = 0
        arrs = [np.asarray(p, dtype=np.uint8) for p in planes]
        item = 1
    elif first.dtype == np.float32:
        dtype_code = 2
        arrs = [np.asarray(p, dtype=np.float32) for p in planes]
        item = 4
    else:
        dtype_code = 1
        arrs = [np.asarray(p, dtype=np.uint16) for p in planes]
        item = 2
    header = bytearray()
    header += PLANE_MAGIC
    header += (1).to_bytes(2, "little")
    header += int(n).to_bytes(2, "little")
    header += int(h).to_bytes(4, "little")
    header += int(w).to_bytes(4, "little")
    header += bytes([dtype_code, 0, 0, 0])
    body = bytearray()
    for i, arr in enumerate(arrs):
        meta = channels[i] if i < len(channels) else {}
        name = str(meta.get("name") or f"C{i}")[:31]
        name_b = name.encode("utf-8")[:31].ljust(32, b"\0")
        color = meta.get("color") or [255, 255, 255]
        body += name_b
        body += bytes([int(color[0]) & 255, int(color[1]) & 255, int(color[2]) & 255, 0])
        lo = float(meta.get("suggested_min") or 0)
        hi = float(meta.get("suggested_max") or (float(arr.max()) if arr.size else 1))
        body += np.float32(lo).tobytes()
        body += np.float32(hi).tobytes()
        flat = np.ascontiguousarray(arr.reshape(h, w))
        body += flat.tobytes()
        _ = item
    return bytes(header) + bytes(body)
