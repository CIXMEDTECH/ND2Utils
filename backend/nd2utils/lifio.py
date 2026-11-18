"""Leica LIF support.

A .lif file is a whole LAS X project: many images ("series"), often grouped in folders.
On import it becomes a workspace folder named after the file, with one workspace file per image
(the project's own folders become subfolders). Every image record gets its own hard link to the
uploaded .lif plus a small sidecar (lif.json) saying which image of the project it is, so
deleting, renaming, moving and copying images works exactly like for ND2 files, while the
project data is stored only once on disk.

Images are read through memory maps: a plane request only touches that plane's bytes.
After that they go through the same pipeline as ND2 files (preview, Advanced mode, exports).
"""

from __future__ import annotations

import json
import logging
import math
import re
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import liffile
import numpy as np

log = logging.getLogger("nd2utils.lif")

LIF_SUFFIX = ".lif"
SIDECAR = "lif.json"

# LUT names used by LAS X, mapped to display colors. Blue matches the other readers' DAPI blue,
# which stays visible on dark screens.
_LUT_COLORS = {
    "red": [255, 0, 0],
    "green": [0, 255, 0],
    "blue": [40, 110, 255],
    "cyan": [0, 255, 255],
    "magenta": [255, 0, 255],
    "yellow": [255, 255, 0],
    "orange": [255, 140, 0],
    "gray": [255, 255, 255],
    "grey": [255, 255, 255],
    "white": [255, 255, 255],
}
_PALETTE = [[40, 110, 255], [0, 255, 0], [255, 0, 0], [255, 255, 0], [255, 0, 255], [0, 255, 255]]
_SETTING_TAGS = ("ATLConfocalSettingDefinition", "ATLCameraSettingDefinition")
_UNIT_UM = {"m": 1e6, "mm": 1e3, "um": 1.0, "µm": 1.0, "nm": 1e-3}


class LifError(Exception):
    def __init__(self, message: str, code: str = "lif_error"):
        super().__init__(message)
        self.code = code


def is_lif_name(name: str) -> bool:
    return name.lower().endswith(LIF_SUFFIX)


def is_lif(path: Path) -> bool:
    """LIF files start with the int32 0x70 and the byte 0x2A after the block size."""
    try:
        with path.open("rb") as fh:
            head = fh.read(9)
    except OSError:
        return False
    return len(head) == 9 and head[:4] == b"\x70\0\0\0" and head[8] == 0x2A


def project_folder_name(filename: str) -> str:
    """'BRD9 VECTOR.lif' -> 'BRD9 VECTOR' (the workspace folder the project becomes)."""
    stem = filename[: -len(LIF_SUFFIX)] if is_lif_name(filename) else filename
    return _clean_name(stem) or "LIF"


def _clean_name(name: str) -> str:
    # Workspace names cannot contain path separators or control characters.
    name = re.sub(r"[\\/\x00-\x1f]+", "_", str(name or "")).strip()
    return "" if name in {".", ".."} else name[:120]


# --- metadata ---------------------------------------------------------------------


def _float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _hardware(image: liffile.LifImage) -> ET.Element | None:
    return image.xml_element.find('./Data/Image/Attachment[@Name="HardwareSetting"]')


def _setting(hardware: ET.Element | None) -> ET.Element | None:
    if hardware is None:
        return None
    for tag in _SETTING_TAGS:
        el = hardware.find(tag)
        if el is not None:
            return el
    return None


def _steps(hardware: ET.Element | None) -> list[ET.Element]:
    """Acquisition settings per sequential scan step (or the single setting)."""
    if hardware is None:
        return []
    steps = [
        child
        for block in hardware.findall("./LDM_Block_Sequential/LDM_Block_Sequential_List")
        for child in block
        if child.tag in _SETTING_TAGS
    ]
    if steps:
        return steps
    main = _setting(hardware)
    return [main] if main is not None else []


def _step_wavelengths(setting: ET.Element) -> list[tuple[float | None, float | None]]:
    """(excitation, emission) in nm for each active detector of one scan setting."""
    bands = {mb.get("Channel"): mb for mb in setting.iter("MultiBand")}
    lasers = sorted(
        w
        for line in setting.iter("LaserLineSetting")
        if (_float(line.get("IntensityDev")) or 0) > 0
        for w in [_float(line.get("LaserLine"))]
        if w
    )
    out = []
    for det in setting.iter("Detector"):
        if det.get("IsActive") != "1":
            continue
        band = bands.get(det.get("Channel"))
        left = _float(band.get("LeftWorld")) if band is not None else None
        right = _float(band.get("RightWorld")) if band is not None else None
        emission = round((left + right) / 2, 1) if left and right else None
        # The excitation line is the longest active laser below the detection band.
        below = [w for w in lasers if left is None or w < left]
        excitation = below[-1] if below else (lasers[0] if lasers else None)
        out.append((excitation, emission))
    return out


def _wavelengths(hardware: ET.Element | None, count: int) -> list[tuple[float | None, float | None]]:
    try:
        found = [pair for step in _steps(hardware) for pair in _step_wavelengths(step)]
    except Exception:  # best effort: settings XML differs between LAS versions and systems
        found = []
    return found if len(found) == count else [(None, None)] * count


def _scaling(image: liffile.LifImage) -> list[ET.Element]:
    return image.xml_element.findall('./Data/Image/Attachment[@Name="ViewerScaling"]/ChannelScalingInfo')


def _lut_color(name: str, index: int, count: int) -> list[int]:
    color = _LUT_COLORS.get((name or "").strip().lower())
    if color:
        return list(color)
    return [255, 255, 255] if count == 1 else list(_PALETTE[index % len(_PALETTE)])


def _channels(image: liffile.LifImage, rgb: bool) -> tuple[list[dict[str, Any]], int]:
    lif_channels = image._channels  # noqa: SLF001 - liffile exposes no public channel list
    bits = max((ch.resolution for ch in lif_channels), default=int(image.dtype.itemsize * 8))
    data_max = float(2**bits - 1) if np.issubdtype(image.dtype, np.integer) else 1.0
    if rgb:
        return [
            {
                "index": i,
                "name": name,
                "color": color,
                "emission_nm": None,
                "excitation_nm": None,
                "modality": [],
                "lut_min": 0.0,
                "lut_max": None,
                "lut_gamma": 1.0,
                "suggested_min": 0,
                "suggested_max": data_max,
            }
            for i, (name, color) in enumerate((("R", [255, 0, 0]), ("G", [0, 255, 0]), ("B", [0, 0, 255])))
        ], bits

    count = image.sizes.get("C", 1)
    names = list(image.coords.get("C", [])) if "C" in image.sizes else []
    scaling = _scaling(image)
    waves = _wavelengths(_hardware(image), count)
    out = []
    for i in range(count):
        meta = lif_channels[i] if i < len(lif_channels) else None
        name = str(names[i]) if i < len(names) else (f"Channel {i + 1}" if count > 1 else "Channel 1")
        if re.fullmatch(r"Ch\d+", name):
            name = f"Channel {i + 1}"
        lo, hi, gamma = 0.0, None, 1.0
        if i < len(scaling):
            black = _float(scaling[i].get("BlackValue")) or 0.0
            white = _float(scaling[i].get("WhiteValue"))
            gamma = _float(scaling[i].get("GammaValue")) or 1.0
            lo = black * data_max
            # LAS X stores the display range as 0..1 of the data range; "1" is the default.
            if white is not None and 0 < white < 1:
                hi = white * data_max
        excitation, emission = waves[i]
        out.append(
            {
                "index": i,
                "name": name,
                "color": _lut_color(meta.lut_name if meta else "", i, count),
                "emission_nm": emission,
                "excitation_nm": excitation,
                "modality": [],
                "lut_min": lo,
                "lut_max": hi,
                "lut_gamma": gamma,
                "suggested_min": 0,
                "suggested_max": data_max,
            }
        )
    return out, bits


def _voxel_um(image: liffile.LifImage) -> list[float]:
    """Pixel spacing in µm for X, Y, Z (1.0 when unknown, like the ND2 reader)."""
    dims = {d.label: d for d in image._dimensions}  # noqa: SLF001
    out = []
    for label in ("X", "Y", "Z"):
        dim = dims.get(label)
        size = None
        if dim is not None and dim.number_elements > 1 and dim.length:
            size = abs(dim.length) / (dim.number_elements - 1) * _UNIT_UM.get(dim.unit, 1e6)
        out.append(float(size) if size else (out[0] if label == "Y" and out else 1.0))
    return out


def _calibrated(image: liffile.LifImage) -> bool:
    dims = {d.label: d for d in image._dimensions}  # noqa: SLF001
    dim = dims.get("X")
    return bool(dim is not None and dim.number_elements > 1 and dim.length)


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value)).strip()


def _settings_info(image: liffile.LifImage, setting: ET.Element | None, hardware: ET.Element | None) -> dict[str, str]:
    info: dict[str, str] = {}

    def put(key: str, value: Any) -> None:
        if value not in (None, ""):
            info[key] = _text(value)

    put("Project path", image.path)
    put("Description", image.xml_element.find("./Data/Image").get("TextDescription"))
    if hardware is not None:
        put("System", hardware.get("SystemTypeName"))
        put("Software", hardware.get("Software"))
        put("Acquisition", hardware.get("DataSourceTypeName"))
    if setting is not None:
        attr = setting.attrib
        put("Objective", attr.get("ObjectiveName"))
        put("Immersion", attr.get("Immersion"))
        put("Magnification", attr.get("Magnification"))
        put("Numerical aperture", attr.get("NumericalAperture"))
        put("Refraction index", attr.get("RefractionIndex"))
        put("Zoom", attr.get("Zoom"))
        put("Scan mode", attr.get("ScanMode"))
        put("Scan speed (Hz)", attr.get("ScanSpeed"))
        put("Line average", attr.get("LineAverage"))
        put("Frame average", attr.get("FrameAverage"))
        put("Line accumulation", attr.get("Line_Accumulation"))
        put("Frame accumulation", attr.get("FrameAccumulation"))
        put("Bit depth", attr.get("BitSize"))
        put("Exposure time", attr.get("ExposureTime"))
        pinhole = _float(attr.get("Pinhole"))
        if pinhole:
            put("Pinhole (µm)", f"{pinhole * 1e6:.2f}")
        put("Pinhole (Airy)", attr.get("PinholeAiry"))
        dwell = _float(attr.get("PixelDwellTime"))
        if dwell:
            put("Pixel dwell time (µs)", f"{dwell * 1e6:.3g}")
        for key, label in (("StagePosX", "Stage X (mm)"), ("StagePosY", "Stage Y (mm)")):
            pos = _float(attr.get(key))
            if pos is not None:
                put(label, f"{pos * 1e3:.4f}")
        z = _float(attr.get("ZPosition"))
        if z is not None:
            put("Z position (µm)", f"{z * 1e6:.3f}")
        put("User setting", attr.get("UserSettingName"))
        put("System serial number", attr.get("SystemSerialNumber"))
    try:
        steps = _steps(hardware)
        lasers = sorted(
            {
                f"{line.get('LaserLine')} nm ({float(line.get('IntensityDev')):.1f}%)"
                for step in steps
                for line in step.iter("LaserLineSetting")
                if (_float(line.get("IntensityDev")) or 0) > 0
            }
        )
        put("Laser lines", ", ".join(lasers))
        detectors = [
            f"{det.get('Name')} (gain {_float(det.get('Gain')) or 0:.0f})"
            for step in steps
            for det in step.iter("Detector")
            if det.get("IsActive") == "1"
        ]
        put("Detectors", ", ".join(dict.fromkeys(detectors)))
        if len(steps) > 1:
            put("Sequential steps", len(steps))
    except Exception:
        pass
    tiles = image.tilescan
    if tiles is not None:
        put("Tile scan fields", len(tiles))
    return info


def _acquired(image: liffile.LifImage) -> str | None:
    try:
        stamps = image.timestamps
    except Exception:
        return None
    if stamps is None or not len(stamps):
        return None
    return str(stamps[0]).replace("T", " ")


def _describe(image: liffile.LifImage) -> dict[str, Any]:
    """Identify fields of one image (the same keys nd2io.identify_path returns)."""
    sizes = dict(image.sizes)
    if "X" not in sizes or "Y" not in sizes:
        raise LifError("Image has no X/Y plane.", "unsupported")
    samples = sizes.get("S", 1)
    rgb = samples in (3, 4) and sizes.get("C", 1) == 1
    if samples > 1 and not rgb:
        raise LifError("Images with several samples per channel are not supported.", "unsupported")
    dtype = image.dtype  # raises for mixed channel bit depths
    channels, bits = _channels(image, rgb)
    hardware = _hardware(image)
    setting = _setting(hardware)
    attr = setting.attrib if setting is not None else {}
    objective = _text(attr.get("ObjectiveName") or "") or None
    mag = _float(attr.get("Magnification"))
    na = _float(attr.get("NumericalAperture"))
    zoom = _float(attr.get("Zoom"))
    software = _text(hardware.get("Software")) if hardware is not None and hardware.get("Software") else None
    system = hardware.get("SystemTypeName") if hardware is not None else None
    instrument = f"Leica {_text(system)}" if system else "Leica"
    voxel = _voxel_um(image)
    acquired = _acquired(image)
    axes = [{"name": k, "size": int(v)} for k, v in sizes.items()]
    text_info = _settings_info(image, setting, hardware)
    shape = [int(v) for v in sizes.values()]
    groups = {
        "file": {
            "name": image.name,
            "project_path": image.path,
            "uuid": image.uuid,
            "dtype": str(dtype),
            "shape": shape,
            "axes": axes,
            "is_rgb": rgb,
            "bits_significant": bits,
        },
        "optics": {"objective": objective, "magnification": mag, "numerical_aperture": na, "voxel_um": voxel},
        "channels": channels,
        "instrument": {"name": instrument, "software": software, "acquired": acquired},
    }
    return {
        "format": "lif",
        "status": "ready",
        "error": None,
        "version": None,
        "dtype": str(dtype),
        "shape": shape,
        "axes": axes,
        "width": int(sizes["X"]),
        "height": int(sizes["Y"]),
        "channels": channels,
        "voxel_um": voxel,
        "objective": objective,
        "magnification": mag,
        "zoom": zoom,
        "calibrated": _calibrated(image),
        "na": na,
        "acquired": acquired,
        "instrument": instrument,
        "software": software,
        "bits_significant": int(bits),
        "is_rgb": rgb,
        "size_bytes": int(image.nbytes),
        "text_info": text_info,
        "experiment": [],
        "events": [],
        "metadata": {
            "dimensions": [
                {"label": d.label, "elements": d.number_elements, "origin": d.origin, "length": d.length, "unit": d.unit}
                for d in image._dimensions  # noqa: SLF001
            ],
        },
        "app_info": {},
        "groups": groups,
        "sizes": sizes,
    }


def read_project(path: Path) -> list[dict[str, Any]]:
    """Every readable image of a LIF project.

    Each item has `index`/`uuid` (which image, for the sidecar), `folder` (the image's folder
    inside the project, "a/b"), `name`, and `record` (identify fields). Images that cannot be
    shown (e.g. raw FLIM histograms) are skipped."""
    if not is_lif(path):
        raise LifError("Not a Leica LIF file (missing LIF header).", "not_lif")
    try:
        lif = liffile.LifFile(path)
    except Exception as exc:
        raise LifError(f"Failed to parse LIF: {exc}", "parse_failed") from exc
    out = []
    with lif:
        for index, image in enumerate(lif.images):
            if not isinstance(image, liffile.LifImage):
                log.info("Skipping %s in %s: not a regular image", image.path, path.name)
                continue
            try:
                record = _describe(image)
            except Exception as exc:
                log.warning("Skipping %s in %s: %s", image.path, path.name, exc)
                continue
            parts = [_clean_name(p) or "_" for p in image.path.split("/")]
            out.append(
                {
                    "index": index,
                    "uuid": image.uuid,
                    "path": image.path,
                    "folder": "/".join(parts[:-1]),
                    "name": parts[-1],
                    "record": record,
                }
            )
    return out


def write_sidecar(directory: Path, entry: dict[str, Any]) -> None:
    payload = {"index": entry["index"], "uuid": entry.get("uuid"), "path": entry.get("path")}
    (directory / SIDECAR).write_text(json.dumps(payload), encoding="utf-8")


def _find_image(lif: liffile.LifFile, ref: dict[str, Any]) -> liffile.LifImage:
    images = lif.images
    index = int(ref.get("index", 0))
    uuid = ref.get("uuid")
    if 0 <= index < len(images) and (not uuid or images[index].uuid == uuid):
        return images[index]
    for image in images:
        if uuid and image.uuid == uuid:
            return image
    raise LifError("Image not found in the LIF project.", "parse_failed")


def open_image(path: Path) -> tuple[liffile.LifFile, dict[str, int], np.ndarray, bool]:
    """(open file, sizes in array order, memory-mapped data, is_rgb) of the image this upload is."""
    try:
        ref = json.loads((path.parent / SIDECAR).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LifError("The LIF image reference is missing.", "parse_failed") from exc
    lif = liffile.LifFile(path)
    try:
        image = _find_image(lif, ref)
        # Memory-maps the stored data; compressed data is decoded once into a temporary memmap.
        array = image.asarray(out="memmap")
        sizes = dict(zip(image.dims, array.shape))
        rgb = sizes.get("S", 1) in (3, 4) and sizes.get("C", 1) == 1
    except Exception:
        lif.close()
        raise
    return lif, sizes, array, rgb
