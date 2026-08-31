from __future__ import annotations

import json
import shutil
import time
import uuid
import zipfile
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

from nd2utils.config import settings
from nd2utils.jsonutil import jsonable
from nd2utils.models import ExportRequest
from nd2utils.nd2io import axis_size, extract_channels, iter_coords, open_nd2
from nd2utils.render import build_luts, composite_rgb, draw_scale_bar, encode_image
from nd2utils.store import get_owned_file, source_path, upsert_job

_FORMAT_LABELS = {
    "ome-tiff": "OME-TIFF",
    "tiff": "TIFF",
    "png": "PNG",
    "jpeg": "JPEG",
}

_META_KEYS = (
    "id",
    "name",
    "version",
    "dtype",
    "shape",
    "axes",
    "channels",
    "voxel_um",
    "objective",
    "acquired",
    "instrument",
    "software",
    "text_info",
    "events",
)


def _safe_stem(name: str) -> str:
    stem = Path(name).stem
    out = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in stem)
    return out or "nd2"


def _coord_tag(t: int, z: int, p: int, sizes: dict[str, int]) -> str:
    parts: list[str] = []
    if axis_size(sizes, "T") > 1:
        parts.append(f"T{t + 1:03d}")
    if axis_size(sizes, "Z") > 1:
        parts.append(f"Z{z + 1:03d}")
    if axis_size(sizes, "P") > 1:
        parts.append(f"XY{p + 1:02d}")
    return "_".join(parts)


def _export_filename(stem: str, *, tag: str = "", role: str = "", ext: str) -> str:
    parts = [stem]
    if tag:
        parts.append(tag)
    if role:
        parts.append(role)
    return "_".join(parts) + "." + ext.lstrip(".")


def _archive_name(stems: list[str], fmt: str, created_at: float, job_id: str) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(created_at))
    label = _FORMAT_LABELS.get(fmt, fmt.upper())
    unique = [s for s in dict.fromkeys(stems) if s]
    if not unique:
        base = "ND2Utils"
    elif len(unique) == 1:
        base = unique[0]
    elif len(unique) == 2:
        base = f"{unique[0]}_{unique[1]}"
    else:
        base = f"{unique[0]}_and_{len(unique) - 1}_more"
    name = f"{base}_{label}_{stamp}.zip"
    if len(name) > 120:
        name = f"{unique[0]}_and_{len(unique) - 1}_more_{label}_{stamp}.zip"
    # keep names unique if two jobs finish in the same second
    candidate = name
    dest_dir = settings.exports_dir
    if (dest_dir / candidate).exists():
        candidate = f"{Path(name).stem}_{job_id[:6]}.zip"
    return candidate


def _as_yx(plane: np.ndarray) -> np.ndarray:
    arr = np.squeeze(np.asarray(plane))
    if arr.ndim != 2:
        arr = np.reshape(arr, arr.shape[-2:])
    return arr


def _resolution(voxel: list[float] | None) -> tuple[float, float] | None:
    if not voxel or not voxel[0]:
        return None
    y = float(voxel[1]) if len(voxel) > 1 and voxel[1] else float(voxel[0])
    if y <= 0:
        return None
    return (1.0 / float(voxel[0]), 1.0 / y)


def _as_rgb8(rgb: np.ndarray) -> np.ndarray:
    arr = np.asarray(rgb)
    if arr.dtype == np.uint8:
        return np.ascontiguousarray(arr)
    if np.issubdtype(arr.dtype, np.floating):
        finite = arr[np.isfinite(arr)]
        if finite.size and float(finite.min()) >= 0.0 and float(finite.max()) <= 1.0:
            arr = arr * 255.0
    return np.ascontiguousarray(np.clip(arr, 0, 255).astype(np.uint8))


def _write_display_tiff(path: Path, rgb: np.ndarray, voxel: list[float] | None = None) -> None:
    rgb8 = _as_rgb8(rgb)
    kwargs: dict = {
        "photometric": "rgb",
        "compression": "adobe_deflate",
        "metadata": False,
    }
    res = _resolution(voxel)
    if res:
        kwargs["resolution"] = res
    tifffile.imwrite(path, rgb8, **kwargs)


def _write_raw_tiff(path: Path, plane: np.ndarray) -> None:
    arr = np.ascontiguousarray(_as_yx(plane))
    tifffile.imwrite(path, arr, photometric="minisblack", metadata=False)


def _ome_channel_color(rgb: list[int]) -> int:
    r, g, b = (int(rgb[0]) & 255, int(rgb[1]) & 255, int(rgb[2]) & 255) if len(rgb) >= 3 else (255, 255, 255)
    value = (r << 24) | (g << 16) | (b << 8) | 255
    if value >= 2**31:
        value -= 2**32
    return value


def _write_ome_tiff(
    path: Path,
    planes: list[np.ndarray],
    names: list[str],
    colors: list[list[int]],
    voxel: list[float],
    bits_significant: int | None = None,
) -> None:
    arr = np.stack([_as_yx(p) for p in planes], axis=0)
    metadata: dict = {
        "axes": "CYX",
        "Channel": {
            "Name": names,
            "Color": [_ome_channel_color(c) for c in colors],
        },
    }
    if voxel and voxel[0]:
        metadata["PhysicalSizeX"] = float(voxel[0])
        metadata["PhysicalSizeXUnit"] = "µm"
        metadata["PhysicalSizeY"] = float(voxel[1] if len(voxel) > 1 and voxel[1] else voxel[0])
        metadata["PhysicalSizeYUnit"] = "µm"
    if bits_significant:
        metadata["SignificantBits"] = int(bits_significant)
    kwargs: dict = {
        "photometric": "minisblack",
        "metadata": metadata,
        "ome": True,
    }
    res = _resolution(voxel)
    if res:
        kwargs["resolution"] = res
    tifffile.imwrite(path, arr, **kwargs)


def _save_display(path: Path, rgb: np.ndarray, fmt: str, jpeg_quality: int, voxel: list[float] | None) -> None:
    rgb8 = _as_rgb8(rgb)
    if fmt == "png":
        Image.fromarray(rgb8, mode="RGB").save(path)
    elif fmt == "jpeg":
        path.write_bytes(encode_image(rgb8, "jpeg", jpeg_quality))
    else:
        _write_display_tiff(path, rgb8, voxel)


def _display_ext(fmt: str) -> str:
    if fmt == "png":
        return "png"
    if fmt == "jpeg":
        return "jpg"
    return "tif"


def run_export(job_id: str, req: ExportRequest, owner_id: str) -> None:
    rec = {
        "id": job_id,
        "status": "running",
        "progress": 0.02,
        "message": "Preparing export",
        "created_at": time.time(),
        "download_name": None,
        "error": None,
        "format": req.format,
        "file_ids": req.file_ids,
        "_owner": owner_id,
    }
    upsert_job(rec)
    out_dir = settings.exports_dir / job_id
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    stems_used: list[str] = []
    total = max(len(req.file_ids), 1)
    # OME-TIFF keeps native values. TIFF/PNG/JPEG are 8-bit display images.
    write_raw = req.format == "ome-tiff" and not req.burn_lut
    try:
        for fi, file_id in enumerate(req.file_ids):
            rec["message"] = f"Exporting {file_id}"
            rec["progress"] = 0.05 + 0.85 * (fi / total)
            upsert_job(rec)
            meta = get_owned_file(file_id, owner_id)
            if not meta:
                raise FileNotFoundError(f"Unknown file {file_id}")
            src = source_path(file_id)
            handle = open_nd2(src)
            sizes = handle.sizes
            stem = _safe_stem(meta.get("name") or file_id)
            stems_used.append(stem)
            folder = out_dir / stem
            folder.mkdir(exist_ok=True)
            channels = meta.get("channels") or []
            names = [c.get("name") or f"C{i}" for i, c in enumerate(channels)]
            colors = [c.get("color") or [255, 255, 255] for c in channels]
            voxel = meta.get("voxel_um") or [1, 1, 1]
            bits_sig = meta.get("bits_significant")
            coords_list = (
                list(iter_coords(sizes))
                if req.scope == "all"
                else [(req.coords.t, req.coords.z, req.coords.p)]
            )
            n_coords = max(len(coords_list), 1)
            composite_role = "composite" if req.channels_mode == "both" else ""
            for ci, (t, z, p) in enumerate(coords_list):
                planes, _ = extract_channels(handle, t=t, z=z, p=p)
                tag = _coord_tag(t, z, p, sizes)
                luts = build_luts(planes, channels, req.luts, req.visible)
                if write_raw:
                    if req.channels_mode in ("split", "both"):
                        for i, plane in enumerate(planes):
                            ch_name = _safe_stem(names[i] if i < len(names) else f"C{i}")
                            dest = folder / _export_filename(stem, tag=tag, role=ch_name, ext="tif")
                            _write_raw_tiff(dest, plane)
                            written.append(dest)
                    if req.channels_mode in ("composite", "both"):
                        dest = folder / _export_filename(stem, tag=tag, role=composite_role, ext="ome.tif")
                        _write_ome_tiff(dest, planes, names, colors, voxel, bits_sig)
                        written.append(dest)
                else:
                    vis = req.visible
                    rgb = composite_rgb(planes, luts, colors, vis)
                    if req.scale_bar and voxel and voxel[0]:
                        rgb = draw_scale_bar(rgb, float(voxel[0]))
                    ext = _display_ext(req.format)
                    if req.channels_mode in ("composite", "both"):
                        dest = folder / _export_filename(stem, tag=tag, role=composite_role, ext=ext)
                        _save_display(dest, rgb, req.format, req.jpeg_quality, voxel)
                        written.append(dest)
                    if req.channels_mode in ("split", "both"):
                        for i, plane in enumerate(planes):
                            lut = luts[i]
                            ch_rgb = composite_rgb([plane], [lut], [lut.color or colors[i]], [True])
                            if req.scale_bar and voxel and voxel[0]:
                                ch_rgb = draw_scale_bar(ch_rgb, float(voxel[0]))
                            ch_name = _safe_stem(names[i] if i < len(names) else f"C{i}")
                            dest = folder / _export_filename(stem, tag=tag, role=ch_name, ext=ext)
                            _save_display(dest, ch_rgb, req.format, req.jpeg_quality, voxel)
                            written.append(dest)
                rec["progress"] = 0.05 + 0.85 * ((fi + (ci + 1) / n_coords) / total)
                upsert_job(rec)
            if req.include_metadata:
                sidecar = folder / _export_filename(stem, role="metadata", ext="json")
                sidecar.write_text(
                    json.dumps(
                        {k: jsonable(meta.get(k)) for k in _META_KEYS},
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                written.append(sidecar)
        zip_name = _archive_name(stems_used, req.format, rec["created_at"], job_id)
        zip_path = settings.exports_dir / zip_name
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in written:
                zf.write(path, arcname=str(path.relative_to(out_dir)))
        rec["status"] = "done"
        rec["progress"] = 1.0
        rec["message"] = "Export complete"
        rec["download_name"] = zip_name
        rec["zip_path"] = str(zip_path)
        upsert_job(rec)
    except Exception as exc:
        rec["status"] = "error"
        rec["error"] = str(exc)
        rec["message"] = str(exc)
        upsert_job(rec)


def new_job_id() -> str:
    return uuid.uuid4().hex
