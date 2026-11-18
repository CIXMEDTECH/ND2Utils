"""OME-TIFF (and plain TIFF) support: multi-channel, multi-resolution whole-slide images.

Images are read segment by segment (TIFF tiles or strips): a request never decodes more than
the region it asks for, so slides of tens of gigapixels stay cheap to browse.

Resolution levels come from the file's own pyramid (OME SubIFDs, or a series' extra levels).
A large image without enough levels gets "virtual" levels: 2x2-binned copies stored as .npy
under cache/<file id>/pyramid during background preparation, read through memory maps.
"""

from __future__ import annotations

import json
import math
import re
import shutil
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock, RLock
from typing import Any, Iterator
from xml.etree import ElementTree as ET

import numpy as np
import tifffile

from nd2utils.config import settings

TIFF_SUFFIXES = (".ome.tif", ".ome.tiff", ".tif", ".tiff")
TIFF_MAGICS = (b"II*\0", b"MM\0*", b"II+\0", b"MM\0+")
TILE = 512
# Virtual levels are added until the coarsest level fits this edge (fit-to-window = one tile or two).
TOP_EDGE = 1024
# The workspace preview uses the finest level within this edge.
OVERVIEW_EDGE = 2048
PYRAMID_DIR = "pyramid"
PYRAMID_INDEX = "levels.json"

# Fallback channel colors (blue, green, red, yellow, magenta, cyan, orange, white).
PALETTE = [
    [40, 110, 255],
    [0, 255, 0],
    [255, 0, 0],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
    [255, 140, 0],
    [255, 255, 255],
]
_UNIT_UM = {
    "m": 1e6,
    "dm": 1e5,
    "cm": 1e4,
    "mm": 1e3,
    "µm": 1.0,
    "μm": 1.0,
    "um": 1.0,
    "nm": 1e-3,
    "pm": 1e-6,
    "Å": 1e-4,
}


class SlideError(Exception):
    def __init__(self, message: str, code: str = "slide_error"):
        super().__init__(message)
        self.code = code


def is_tiff_name(name: str) -> bool:
    return name.lower().endswith(TIFF_SUFFIXES)


def validate_magic(path: Path) -> None:
    with path.open("rb") as fh:
        head = fh.read(4)
    if head not in TIFF_MAGICS:
        raise SlideError("Not a TIFF file (missing TIFF header).", "not_tiff")


# --- OME-XML ------------------------------------------------------------------


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(node: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in node if _local(child.tag) == name]


def _find_all(node: ET.Element, name: str) -> list[ET.Element]:
    return [el for el in node.iter() if _local(el.tag) == name]


def _float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _to_um(value: Any, unit: str | None) -> float | None:
    number = _float(value)
    if number is None or number <= 0:
        return None
    return number * _UNIT_UM.get((unit or "µm").strip(), 1.0)


def _ome_color(value: Any) -> list[int] | None:
    try:
        rgba = int(value) & 0xFFFFFFFF
    except (TypeError, ValueError):
        return None
    return [(rgba >> 24) & 255, (rgba >> 16) & 255, (rgba >> 8) & 255]


def _default_color(index: int, name: str, count: int) -> list[int]:
    lowered = name.lower()
    if any(key in lowered for key in ("dapi", "hoechst", "nuc")):
        return list(PALETTE[0])
    if count == 1:
        return [255, 255, 255]
    return list(PALETTE[index % len(PALETTE)])


def _parse_ome(xml: str | None, image_index: int) -> dict[str, Any]:
    """The bits of OME-XML the viewer uses. Missing or malformed XML gives an empty dict."""
    if not xml:
        return {}
    try:
        root = ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
    except ET.ParseError:
        return {}
    images = _children(root, "Image")
    if not images:
        return {"creator": root.get("Creator")}
    image = images[image_index] if image_index < len(images) else images[0]
    pixels = next(iter(_children(image, "Pixels")), None)
    out: dict[str, Any] = {
        "creator": root.get("Creator"),
        "image_name": image.get("Name"),
        "acquired": next((el.text for el in _children(image, "AcquisitionDate")), None),
        "channels": [],
    }
    if pixels is not None:
        out["pixels"] = dict(pixels.attrib)
        out["um_x"] = _to_um(pixels.get("PhysicalSizeX"), pixels.get("PhysicalSizeXUnit"))
        out["um_y"] = _to_um(pixels.get("PhysicalSizeY"), pixels.get("PhysicalSizeYUnit"))
        out["um_z"] = _to_um(pixels.get("PhysicalSizeZ"), pixels.get("PhysicalSizeZUnit"))
        bits = pixels.get("SignificantBits")
        out["bits"] = int(bits) if bits and bits.isdigit() else None
        for channel in _children(pixels, "Channel"):
            samples = channel.get("SamplesPerPixel")
            out["channels"].append(
                {
                    "name": channel.get("Name") or channel.get("Fluor"),
                    "color": _ome_color(channel.get("Color")) if channel.get("Color") is not None else None,
                    "emission_nm": _to_um(channel.get("EmissionWavelength"), channel.get("EmissionWavelengthUnit") or "nm"),
                    "excitation_nm": _to_um(
                        channel.get("ExcitationWavelength"), channel.get("ExcitationWavelengthUnit") or "nm"
                    ),
                    "samples": int(samples) if samples and samples.isdigit() else 1,
                }
            )
    for ch in out["channels"]:
        # _to_um converted nm -> µm; wavelengths are shown in nm.
        for key in ("emission_nm", "excitation_nm"):
            if ch[key]:
                ch[key] = round(ch[key] * 1000.0, 3)
    objective = next(iter(_find_all(root, "Objective")), None)
    if objective is not None:
        out["objective"] = objective.get("Model") or objective.get("Manufacturer")
        out["magnification"] = _float(objective.get("NominalMagnification"))
        out["na"] = _float(objective.get("LensNA"))
    microscope = next(iter(_find_all(root, "Microscope")), None)
    if microscope is not None:
        out["instrument"] = " ".join(v for v in (microscope.get("Manufacturer"), microscope.get("Model")) if v) or None
    return out


# --- open slides --------------------------------------------------------------


@dataclass
class Level:
    width: int
    height: int
    # One TIFF page per plane, or (virtual levels) one memory-mapped array per plane.
    pages: list[Any] | None = None
    arrays: list[np.ndarray] | None = None


@dataclass
class Slide:
    path: Path
    tif: tifffile.TiffFile
    series_index: int
    lead_axes: str
    lead_shape: tuple[int, ...]
    samples: int
    dtype: np.dtype
    levels: list[Level]
    real_levels: int
    ome: dict[str, Any]
    lock: RLock = field(default_factory=RLock, repr=False)

    @property
    def width(self) -> int:
        return self.levels[0].width

    @property
    def height(self) -> int:
        return self.levels[0].height

    def axis_len(self, axis: str) -> int:
        return self.lead_shape[self.lead_axes.index(axis)] if axis in self.lead_axes else 1

    @property
    def n_channels(self) -> int:
        return self.axis_len("C") * self.samples

    @property
    def n_planes(self) -> int:
        return int(np.prod(self.lead_shape)) if self.lead_shape else 1

    def plane_index(self, t: int, z: int, c_page: int) -> int:
        if not self.lead_axes:
            return 0
        want = {"T": t, "Z": z, "C": c_page}
        coords = [int(np.clip(want.get(ax, 0), 0, n - 1)) for ax, n in zip(self.lead_axes, self.lead_shape)]
        return int(np.ravel_multi_index(coords, self.lead_shape))

    def close(self) -> None:
        with self.lock:
            try:
                self.tif.close()
            except Exception:
                pass


def _pick_series(tif: tifffile.TiffFile) -> int:
    """The main image: the largest series (WSI files often carry label/macro thumbnails too)."""
    best, best_area = 0, -1
    for i, series in enumerate(tif.series):
        axes = series.axes
        try:
            area = series.shape[axes.index("Y")] * series.shape[axes.index("X")]
        except ValueError:
            continue
        if area > best_area:
            best, best_area = i, area
    return best


def _pyramid_dir(cache_key: str) -> Path:
    return settings.cache_dir / cache_key / PYRAMID_DIR


def _virtual_levels(cache_key: str | None, n_planes: int) -> list[Level]:
    if not cache_key:
        return []
    folder = _pyramid_dir(cache_key)
    try:
        index = json.loads((folder / PYRAMID_INDEX).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    levels = []
    for li, (w, h) in enumerate(index.get("levels") or []):
        try:
            arrays = [np.load(folder / f"L{li}_{p}.npy", mmap_mode="r") for p in range(n_planes)]
        except (OSError, ValueError):
            return []
        levels.append(Level(width=int(w), height=int(h), arrays=arrays))
    return levels


def _open(path: Path, cache_key: str | None) -> Slide:
    try:
        tif = tifffile.TiffFile(path)
    except Exception as exc:
        raise SlideError(f"Failed to parse TIFF: {exc}", "parse_failed") from exc
    try:
        if not tif.series:
            raise SlideError("The TIFF contains no images.", "empty")
        index = _pick_series(tif)
        series = tif.series[index]
        axes = series.axes
        if "Y" not in axes or "X" not in axes:
            raise SlideError(f"Unsupported image axes {axes!r}.", "parse_failed")
        y_at = axes.index("Y")
        lead_axes = axes[:y_at]
        lead_shape = tuple(int(n) for n in series.shape[:y_at])
        tail = axes[y_at:]
        if tail not in ("YX", "YXS"):
            raise SlideError(f"Unsupported image axes {axes!r}.", "parse_failed")
        samples = int(series.shape[-1]) if tail == "YXS" else 1
        if lead_axes.endswith("S"):  # planar-separate samples: still one page per plane
            samples = lead_shape[-1]
            lead_axes, lead_shape = lead_axes[:-1], lead_shape[:-1]
        n_planes = int(np.prod(lead_shape)) if lead_shape else 1
        levels: list[Level] = []
        for level in series.levels:
            pages = list(level.pages)
            if len(pages) < n_planes:
                pages += [None] * (n_planes - len(pages))
            first = next((p for p in pages if p is not None), None)
            if first is None:
                continue
            kf = first.keyframe
            for page in pages:  # load offsets now: reads below hold only our lock
                if page is not None:
                    _ = page.dataoffsets, page.databytecounts, page.keyframe
            levels.append(Level(width=int(kf.imagewidth), height=int(kf.imagelength), pages=pages[:n_planes]))
        if not levels:
            raise SlideError("The TIFF contains no readable pages.", "empty")
        levels.sort(key=lambda lv: -lv.width)
        real = len(levels)
        levels += _virtual_levels(cache_key, n_planes)
        ome = _parse_ome(tif.ome_metadata, index) if tif.is_ome else {}
        return Slide(
            path=path,
            tif=tif,
            series_index=index,
            lead_axes=lead_axes,
            lead_shape=lead_shape,
            samples=samples,
            dtype=np.dtype(series.dtype),
            levels=levels,
            real_levels=real,
            ome=ome,
        )
    except Exception:
        tif.close()
        raise


_OPEN: OrderedDict[str, Slide] = OrderedDict()
_MAX_OPEN = 6
_OPEN_LOCK = RLock()


def open_slide(path: Path, cache_key: str | None = None) -> Slide:
    key = f"{path.resolve()}|{cache_key or ''}"
    with _OPEN_LOCK:
        if key in _OPEN:
            _OPEN.move_to_end(key)
            return _OPEN[key]
        slide = _open(path, cache_key)
        _OPEN[key] = slide
        while len(_OPEN) > _MAX_OPEN:
            _, old = _OPEN.popitem(last=False)
            old.close()
        return slide


def open_count() -> int:
    return len(_OPEN)


def set_limits(*, segment_bytes: int | None = None, max_open: int | None = None) -> None:
    """Resize the decoded-segment cache and the open-file cache (performance settings)."""
    global _SEG_LIMIT, _MAX_OPEN, _SEG_BYTES
    if max_open is not None:
        _MAX_OPEN = max(1, int(max_open))
        with _OPEN_LOCK:
            while len(_OPEN) > _MAX_OPEN:
                _, old = _OPEN.popitem(last=False)
                old.close()
    if segment_bytes is not None:
        _SEG_LIMIT = max(0, int(segment_bytes))
        with _SEG_LOCK:
            while _SEG_BYTES > _SEG_LIMIT and _SEGMENTS:
                _, seg = _SEGMENTS.popitem(last=False)
                _SEG_BYTES -= seg.nbytes


def segment_cache_bytes() -> int:
    return _SEG_BYTES


def close_slide(path: Path) -> None:
    prefix = f"{path.resolve()}|"
    with _OPEN_LOCK:
        keys = [key for key in _OPEN if key.startswith(prefix)]
        handles = [_OPEN.pop(key) for key in keys]
    for handle in handles:
        handle.close()
    _drop_segments(str(path.resolve()))


def close_all() -> None:
    with _OPEN_LOCK:
        handles = list(_OPEN.values())
        _OPEN.clear()
    for handle in handles:
        handle.close()
    with _SEG_LOCK:
        _SEGMENTS.clear()


# --- decoded segment cache ----------------------------------------------------

_SEGMENTS: OrderedDict[tuple, np.ndarray] = OrderedDict()
_SEG_BYTES = 0
_SEG_LIMIT = 192 * 1024 * 1024
_SEG_LOCK = Lock()


def _drop_segments(path_key: str) -> None:
    global _SEG_BYTES
    with _SEG_LOCK:
        for key in [k for k in _SEGMENTS if k[0] == path_key]:
            _SEG_BYTES -= _SEGMENTS.pop(key).nbytes


def _segment(slide: Slide, page: Any, index: int) -> np.ndarray | None:
    """Decoded TIFF tile/strip as (rows, cols, samples); None for an empty (sparse) segment."""
    global _SEG_BYTES
    key = (str(slide.path.resolve()), id(page), index)
    with _SEG_LOCK:
        hit = _SEGMENTS.get(key)
        if hit is not None:
            _SEGMENTS.move_to_end(key)
            return hit
    offset = int(page.dataoffsets[index])
    count = int(page.databytecounts[index])
    if count <= 0 or offset <= 0:
        return None
    with slide.lock:
        fh = slide.tif.filehandle
        fh.seek(offset)
        data = fh.read(count)
    decoded, _, _ = page.keyframe.decode(data, index)
    if decoded is None:
        return None
    arr = np.asarray(decoded)
    arr = arr.reshape(arr.shape[-3:]) if arr.ndim >= 3 else arr[..., None]
    with _SEG_LOCK:
        _SEGMENTS[key] = arr
        _SEG_BYTES += arr.nbytes
        while _SEG_BYTES > _SEG_LIMIT and len(_SEGMENTS) > 1:
            _, old = _SEGMENTS.popitem(last=False)
            _SEG_BYTES -= old.nbytes
    return arr


def _page_region(slide: Slide, page: Any, sample: int, x: int, y: int, w: int, h: int, out: np.ndarray) -> None:
    kf = page.keyframe
    width, height = int(kf.imagewidth), int(kf.imagelength)
    x1, y1 = min(x + w, width), min(y + h, height)
    if x1 <= x or y1 <= y:
        return
    if kf.is_tiled:
        seg_w, seg_h = int(kf.tilewidth), int(kf.tilelength)
    else:
        seg_w, seg_h = width, max(1, min(int(kf.rowsperstrip or height), height))
    nx, ny = math.ceil(width / seg_w), math.ceil(height / seg_h)
    separate = kf.samplesperpixel > 1 and kf.planarconfig == 2
    base = sample * nx * ny if separate else 0
    pick = 0 if separate else sample
    for gy in range(y // seg_h, (y1 - 1) // seg_h + 1):
        for gx in range(x // seg_w, (x1 - 1) // seg_w + 1):
            seg = _segment(slide, page, base + gy * nx + gx)
            if seg is None:
                continue
            sx, sy = gx * seg_w, gy * seg_h
            ax0, ay0 = max(x, sx), max(y, sy)
            ax1 = min(x1, sx + seg_w, sx + seg.shape[1])
            ay1 = min(y1, sy + seg_h, sy + seg.shape[0])
            if ax1 <= ax0 or ay1 <= ay0:
                continue
            out[ay0 - y : ay1 - y, ax0 - x : ax1 - x] = seg[ay0 - sy : ay1 - sy, ax0 - sx : ax1 - sx, min(pick, seg.shape[2] - 1)]


def read_region(
    slide: Slide,
    level: int,
    channel: int,
    x: int,
    y: int,
    w: int,
    h: int,
    t: int = 0,
    z: int = 0,
) -> np.ndarray:
    """One channel of a rectangle at `level` (level pixel coordinates). Outside the image is 0."""
    lv = slide.levels[level]
    c_page, sample = divmod(int(channel), slide.samples)
    plane = slide.plane_index(t, z, c_page)
    out = np.zeros((h, w), dtype=slide.dtype)
    if lv.arrays is not None:
        arr = lv.arrays[plane]
        x0, y0 = max(x, 0), max(y, 0)
        x1, y1 = min(x + w, lv.width), min(y + h, lv.height)
        if x1 > x0 and y1 > y0:
            block = arr[y0:y1, x0:x1]
            out[y0 - y : y1 - y, x0 - x : x1 - x] = block[..., sample] if block.ndim == 3 else block
        return out
    page = lv.pages[plane] if lv.pages else None
    if page is not None:
        _page_region(slide, page, sample, max(x, 0), max(y, 0), w - max(-x, 0), h - max(-y, 0), out[max(-y, 0) :, max(-x, 0) :])
    return out


# --- pyramid --------------------------------------------------------------------


def needs_pyramid(slide: Slide) -> bool:
    coarsest = slide.levels[-1]
    return max(coarsest.width, coarsest.height) > TOP_EDGE


def _bin2(block: np.ndarray, dtype: np.dtype) -> np.ndarray:
    h, w = block.shape
    if h % 2 or w % 2:
        block = np.pad(block, ((0, h % 2), (0, w % 2)), mode="edge")
    acc = block[0::2, 0::2].astype(np.float64)
    acc += block[1::2, 0::2]
    acc += block[0::2, 1::2]
    acc += block[1::2, 1::2]
    acc *= 0.25
    if np.issubdtype(dtype, np.integer):
        np.rint(acc, out=acc)
    return acc.astype(dtype)


def build_pyramid(path: Path, cache_key: str) -> bool:
    """Add 2x2-binned virtual levels below the file's coarsest level. Returns True if built."""
    slide = _open(path, None)
    try:
        if not needs_pyramid(slide):
            return False
        folder = _pyramid_dir(cache_key)
        tmp = folder.with_name(PYRAMID_DIR + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True, exist_ok=True)
        dims: list[list[int]] = []
        block = 2048
        src_level = len(slide.levels) - 1
        while max(slide.levels[src_level].width, slide.levels[src_level].height) > TOP_EDGE:
            src = slide.levels[src_level]
            nw, nh = math.ceil(src.width / 2), math.ceil(src.height / 2)
            li = len(dims)
            arrays = []
            for plane in range(slide.n_planes):
                shape = (nh, nw, slide.samples) if slide.samples > 1 else (nh, nw)
                target = np.lib.format.open_memmap(tmp / f"L{li}_{plane}.npy", mode="w+", dtype=slide.dtype, shape=shape)
                for by in range(0, src.height, block):
                    for bx in range(0, src.width, block):
                        bw, bh = min(block, src.width - bx), min(block, src.height - by)
                        for s in range(slide.samples):
                            data = _plane_block(slide, src_level, plane, s, bx, by, bw, bh)
                            binned = _bin2(data, slide.dtype)
                            oy, ox = by // 2, bx // 2
                            if slide.samples > 1:
                                target[oy : oy + binned.shape[0], ox : ox + binned.shape[1], s] = binned
                            else:
                                target[oy : oy + binned.shape[0], ox : ox + binned.shape[1]] = binned
                target.flush()
                arrays.append(np.load(tmp / f"L{li}_{plane}.npy", mmap_mode="r"))
                del target
            dims.append([nw, nh])
            slide.levels.append(Level(width=nw, height=nh, arrays=arrays))
            src_level = len(slide.levels) - 1
        (tmp / PYRAMID_INDEX).write_text(json.dumps({"levels": dims}), encoding="utf-8")
        for lv in slide.levels[slide.real_levels :]:
            lv.arrays = None  # release the memory maps before moving the folder
        shutil.rmtree(folder, ignore_errors=True)
        tmp.replace(folder)
        return True
    finally:
        slide.close()
        close_slide(path)


def _plane_block(slide: Slide, level: int, plane: int, sample: int, x: int, y: int, w: int, h: int) -> np.ndarray:
    lv = slide.levels[level]
    if lv.arrays is not None:
        block = np.asarray(lv.arrays[plane][y : y + h, x : x + w])
        return block[..., sample] if block.ndim == 3 else block
    out = np.zeros((h, w), dtype=slide.dtype)
    page = lv.pages[plane] if lv.pages else None
    if page is not None:
        _page_region(slide, page, sample, x, y, w, h, out)
    return out


def pyramid_ready(cache_key: str) -> bool:
    return (_pyramid_dir(cache_key) / PYRAMID_INDEX).is_file()


# --- describing -----------------------------------------------------------------


def _channels(slide: Slide) -> list[dict[str, Any]]:
    ome_channels = slide.ome.get("channels") or []
    n = slide.n_channels
    rgb_like = slide.samples in (3, 4) and slide.axis_len("C") == 1
    data_max = float(np.iinfo(slide.dtype).max) if np.issubdtype(slide.dtype, np.integer) else 1.0
    bits = slide.ome.get("bits")
    if bits and np.issubdtype(slide.dtype, np.integer) and 0 < bits < np.iinfo(slide.dtype).bits:
        data_max = float(2**bits - 1)
    out = []
    for i in range(n):
        meta = ome_channels[i] if len(ome_channels) == n and i < len(ome_channels) else {}
        if rgb_like:
            name = ["Red", "Green", "Blue", "Alpha"][i]
            color = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]][i]
        else:
            name = str(meta.get("name") or f"Channel {i + 1}")
            color = meta.get("color")
        out.append(
            {
                "index": i,
                "name": name,
                "color": color,
                "emission_nm": meta.get("emission_nm"),
                "excitation_nm": meta.get("excitation_nm"),
                "modality": [],
                "lut_min": None,
                "lut_max": None,
                "lut_gamma": 1.0,
                "suggested_min": 0,
                "suggested_max": data_max,
            }
        )
    # OME writers often leave every channel white (-1): fall back to a distinguishable palette.
    colors = [tuple(ch["color"]) for ch in out if ch["color"]]
    unusable = len(colors) < n or (n > 1 and len(set(colors)) == 1)
    for i, ch in enumerate(out):
        if unusable and not rgb_like:
            ch["color"] = _default_color(i, ch["name"], n)
    return out


def describe_levels(slide: Slide) -> list[dict[str, Any]]:
    return [
        {
            "width": lv.width,
            "height": lv.height,
            "downsample": slide.width / lv.width,
            "virtual": lv.arrays is not None,
        }
        for lv in slide.levels
    ]


def _pretty_xml(xml: str, limit: int = 256 * 1024) -> str:
    try:
        root = ET.fromstring(xml.encode("utf-8"))
        ET.indent(root)
        text = ET.tostring(root, encoding="unicode")
        text = re.sub(r"ns\d+:|xmlns:ns\d+=\"[^\"]*\"\s?", "", text)
    except ET.ParseError:
        text = xml
    return text if len(text) <= limit else text[:limit] + "\n… (truncated)"


def identify_path(path: Path, file_id: str, name: str, size_bytes: int, created_at: float) -> dict[str, Any]:
    validate_magic(path)
    slide = _open(path, None)
    try:
        ome = slide.ome
        channels = _channels(slide)
        um_x = ome.get("um_x")
        um_y = ome.get("um_y") or um_x
        if not um_x:
            um_x = um_y = _tiff_resolution_um(slide)
        calibrated = bool(um_x)
        voxel = [float(um_x or 1.0), float(um_y or um_x or 1.0), float(ome.get("um_z") or 1.0)]
        sizes = {"T": slide.axis_len("T"), "Z": slide.axis_len("Z"), "C": slide.n_channels, "Y": slide.height, "X": slide.width}
        axes = [{"name": key, "size": int(value)} for key, value in sizes.items()]
        levels = describe_levels(slide)
        series = slide.tif.series[slide.series_index]
        fmt = "ome-tiff" if slide.tif.is_ome else "tiff"
        compression = getattr(slide.levels[0].pages[0].keyframe.compression, "name", None) if slide.levels[0].pages and slide.levels[0].pages[0] is not None else None
        kf = slide.levels[0].pages[0].keyframe if slide.levels[0].pages and slide.levels[0].pages[0] is not None else None
        file_group = {
            "name": name,
            "size_bytes": size_bytes,
            "format": fmt,
            "dtype": str(slide.dtype),
            "series": f"{slide.series_index + 1} / {len(slide.tif.series)}",
            "axes": series.axes,
            "shape": list(series.shape),
            "tiled": bool(kf.is_tiled) if kf is not None else None,
            "tile": [int(kf.tilewidth), int(kf.tilelength)] if kf is not None and kf.is_tiled else None,
            "compression": compression,
            "bigtiff": bool(slide.tif.is_bigtiff),
        }
        text_info: dict[str, str] = {}
        if slide.tif.is_ome and slide.tif.ome_metadata:
            text_info["OME-XML"] = _pretty_xml(slide.tif.ome_metadata)
        else:
            desc = slide.tif.pages.first.description if slide.tif.pages else ""
            if desc:
                text_info["ImageDescription"] = desc[:65536]
        text_info["pyramid"] = "\n".join(
            f"L{i}: {lv['width']} × {lv['height']}  (1/{lv['downsample']:.4g})" for i, lv in enumerate(levels)
        )
        return {
            "id": file_id,
            "name": name,
            "format": fmt,
            "size_bytes": size_bytes,
            "status": "ready",
            "error": None,
            "version": None,
            "dtype": str(slide.dtype),
            "shape": list(series.shape),
            "axes": axes,
            "width": slide.width,
            "height": slide.height,
            "channels": channels,
            "voxel_um": voxel,
            "objective": ome.get("objective"),
            "magnification": ome.get("magnification"),
            "zoom": None,
            "calibrated": calibrated,
            "na": ome.get("na"),
            "acquired": ome.get("acquired"),
            "instrument": ome.get("instrument"),
            "software": ome.get("creator") or _tiff_software(slide),
            "bits_significant": ome.get("bits") or (int(np.iinfo(slide.dtype).bits) if np.issubdtype(slide.dtype, np.integer) else None),
            "is_rgb": False,
            "created_at": created_at,
            "levels": [[lv["width"], lv["height"]] for lv in levels],
            "text_info": text_info,
            "experiment": [],
            "events": [],
            "metadata": {"pixels": ome.get("pixels") or {}, "image_name": ome.get("image_name")},
            "app_info": {},
            "groups": {"file": file_group, "pyramid": levels},
            "sizes": sizes,
        }
    finally:
        slide.close()


def _tiff_software(slide: Slide) -> str | None:
    try:
        tag = slide.tif.pages.first.tags.get("Software")
        return str(tag.value) if tag else None
    except Exception:
        return None


def _tiff_resolution_um(slide: Slide) -> float | None:
    """Pixel size from the baseline resolution tags (ignored when they only encode a dpi)."""
    try:
        page = slide.tif.pages.first
        unit = int(page.tags["ResolutionUnit"].value) if "ResolutionUnit" in page.tags else 2
        num, den = page.tags["XResolution"].value
        per_unit = num / den if den else 0
        if per_unit <= 0:
            return None
        # ImageJ keeps its calibration as pixels per `unit=` from the description.
        desc = page.description or ""
        if desc.startswith("ImageJ="):
            match = re.search(r"^unit=(\S+)", desc, re.MULTILINE)
            scale = {"micron": 1.0, "um": 1.0, "\u00b5m": 1.0, "µm": 1.0, "nm": 1e-3, "mm": 1e3, "cm": 1e4}.get(
                (match.group(1) if match else "").strip().lower()
            )
            return scale / per_unit if scale else None
        if unit == 3:  # centimeter
            return 1e4 / per_unit
        if unit == 2 and per_unit not in (72, 96, 150, 300, 600):  # inch, not a plain dpi
            return 25400 / per_unit
    except Exception:
        return None
    return None


# --- reading for the API --------------------------------------------------------


def overview_level(slide: Slide) -> int:
    fitting = [i for i, lv in enumerate(slide.levels) if max(lv.width, lv.height) <= OVERVIEW_EDGE]
    return fitting[0] if fitting else len(slide.levels) - 1


def overview_planes(slide: Slide, t: int = 0, z: int = 0) -> list[np.ndarray]:
    level = overview_level(slide)
    lv = slide.levels[level]
    planes = []
    for c in range(slide.n_channels):
        plane = read_region(slide, level, c, 0, 0, lv.width, lv.height, t=t, z=z)
        if max(lv.width, lv.height) > OVERVIEW_EDGE:
            step = math.ceil(max(lv.width, lv.height) / OVERVIEW_EDGE)
            plane = plane[::step, ::step]
        planes.append(plane)
    return planes


def wire_dtype(plane: np.ndarray) -> np.ndarray:
    """uint8 / uint16 are sent as is; anything else as float32."""
    if plane.dtype in (np.uint8, np.uint16, np.float32):
        return plane
    return plane.astype(np.float32)


def tile_planes(
    slide: Slide,
    level: int,
    tx: int,
    ty: int,
    channels: list[int],
    t: int = 0,
    z: int = 0,
) -> list[np.ndarray]:
    lv = slide.levels[level]
    x, y = tx * TILE, ty * TILE
    w, h = min(TILE, lv.width - x), min(TILE, lv.height - y)
    if w <= 0 or h <= 0:
        raise SlideError("Tile outside the image.", "bad_tile")
    return [wire_dtype(read_region(slide, level, c, x, y, w, h, t=t, z=z)) for c in channels]


def iter_tiles(
    slide: Slide,
    level: int,
    channel: int,
    x: int,
    y: int,
    w: int,
    h: int,
    t: int = 0,
    z: int = 0,
) -> Iterator[np.ndarray]:
    """TILE x TILE blocks of a level region in row-major order, zero-padded past its edge."""
    for oy in range(0, h, TILE):
        for ox in range(0, w, TILE):
            block = read_region(slide, level, channel, x + ox, y + oy, TILE, TILE, t=t, z=z)
            if ox + TILE > w:
                block[:, w - ox :] = 0
            if oy + TILE > h:
                block[h - oy :, :] = 0
            yield block
