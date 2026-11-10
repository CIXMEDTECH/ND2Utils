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
from nd2utils.render import build_luts, composite_rgb, draw_scale_bar, encode_image, render_standalone_scale_bars
from nd2utils.store import get_file_detail, get_owned_job, source_path, upsert_job

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


_ILLEGAL = set('<>:"/\\|?*')


_SOURCE_SUFFIXES = {".nd2", ".tif", ".tiff", ".lif"}


def _safe_stem(name: str) -> str:
    # Images of a LIF project have no extension: "Position 1.5" must not lose ".5".
    stem = Path(name).stem if Path(name).suffix.lower() in _SOURCE_SUFFIXES else name
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


def _ome_channel_color(rgb: list[int]) -> int:
    r, g, b = (int(rgb[0]) & 255, int(rgb[1]) & 255, int(rgb[2]) & 255) if len(rgb) >= 3 else (255, 255, 255)
    value = (r << 24) | (g << 16) | (b << 8) | 255
    if value >= 2**31:
        value -= 2**32
    return value


def _apply_raw_brightness(plane: np.ndarray, brightness: float) -> np.ndarray:
    arr = _as_yx(plane)
    gain = max(0.0, float(brightness if brightness is not None else 1.0))
    if abs(gain - 1.0) <= 1e-6:
        return arr
    scaled = np.asarray(arr, dtype=np.float32) * gain
    if np.issubdtype(arr.dtype, np.integer):
        info = np.iinfo(arr.dtype)
        return np.clip(scaled + 0.5, info.min, info.max).astype(arr.dtype)
    return scaled.astype(arr.dtype)


def _write_ome_tiff(
    path: Path,
    planes: list[np.ndarray],
    names: list[str],
    colors: list[list[int]],
    voxel: list[float],
    bits_significant: int | None = None,
    brightnesses: list[float] | None = None,
) -> None:
    arr = np.stack(
        [
            _apply_raw_brightness(p, brightnesses[i] if brightnesses and i < len(brightnesses) else 1.0)
            for i, p in enumerate(planes)
        ],
        axis=0,
    )
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


def _significant_bits(meta: dict, handle: object) -> int | None:
    value = meta.get("bits_significant")
    if not value:
        nd = getattr(handle, "nd", None)
        attributes = getattr(nd, "attributes", None)
        value = getattr(attributes, "bitsPerComponentSignificant", None)
    try:
        bits = int(value)
    except (TypeError, ValueError):
        return None
    return bits if bits > 0 else None


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


def _clean_segment(part: str) -> str:
    out = "".join("_" if ch in _ILLEGAL or ord(ch) < 32 else ch for ch in part).strip().rstrip(".")
    return out or "_"


def _archive_folder(folder: str) -> str:
    """Workspace folder -> folder inside the zip (same structure, portable names)."""
    return "/".join(_clean_segment(p) for p in folder.split("/") if p)


def _unique(path: Path, taken: set[Path]) -> Path:
    candidate = path
    n = 2
    while candidate in taken:
        name = path.name
        stem, dot, ext = name.partition(".")
        candidate = path.with_name(f"{stem}_{n}{dot}{ext}")
        n += 1
    taken.add(candidate)
    return candidate


def _visible_channels(n: int, luts: list, visible: list[bool] | None) -> list[int]:
    out = []
    for i in range(n):
        if visible is not None and i < len(visible) and not visible[i]:
            continue
        if i < len(luts) and not luts[i].visible:
            continue
        out.append(i)
    return out


def _channel_rgb(plane: np.ndarray, lut, color: list[int]) -> np.ndarray:
    # A channel whose LUT colour is black/near-black would render as an all-black file.
    rgb_color = lut.color or color
    if not rgb_color or max(int(c) for c in rgb_color[:3]) < 32:
        rgb_color = [255, 255, 255]
    return composite_rgb([plane], [lut.model_copy(update={"visible": True})], [rgb_color], [True])


_README = (
    "*.ome.tif  - original pixel values (native bit depth, e.g. 12-bit data in 16-bit files) with OME metadata.\n"
    "             Use these in Fiji/ImageJ, QuPath or napari for quantification. Ordinary photo viewers\n"
    "             show them very dark because 12-bit values only fill a small part of the 16-bit range.\n"
    "*.tif      - files with the same name but without .ome are 8-bit images with the display LUT applied,\n"
    "             for presentations and ordinary viewers. Do not use them for quantification.\n\n"
    "*.ome.tif  - 原始像素值（原始位深，例如 12 位数据存放在 16 位文件中）并带 OME 元数据，\n"
    "             请在 Fiji/ImageJ、QuPath 或 napari 中用于定量分析；普通看图软件会显示得很暗。\n"
    "*.tif      - 同名但不带 .ome 的文件是已应用显示 LUT 的 8 位图，可直接用系统看图或放入 PPT，\n"
    "             请勿用于定量分析。\n"
)


def run_export(job_id: str, req: ExportRequest, owner_id: str) -> None:
    created = time.time()
    rec = {
        "id": job_id,
        "status": "running",
        "progress": 0.02,
        "message": "Preparing export",
        "created_at": created,
        "download_name": None,
        "error": None,
        "format": req.format,
        "file_ids": req.file_ids,
        "label": req.label,
        "_owner": owner_id,
    }
    existing = get_owned_job(job_id, owner_id)
    if existing:
        rec["created_at"] = existing.get("created_at") or created
    upsert_job(rec)
    out_dir = settings.exports_dir / job_id
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    taken: set[Path] = set()
    readme_dirs: set[Path] = set()
    seen_scale_specs: set[tuple[Path, int, int, float, int]] = set()
    stems_used: list[str] = []
    total = max(len(req.file_ids), 1)
    # OME-TIFF keeps native values. TIFF/PNG/JPEG are 8-bit display images.
    write_raw = req.format == "ome-tiff" and not req.burn_lut
    try:
        for fi, file_id in enumerate(req.file_ids):
            meta = get_file_detail(file_id, owner_id)
            if not meta:
                raise FileNotFoundError(f"Unknown file {file_id}")
            rec["message"] = f"Exporting {meta.get('name') or file_id}"
            rec["progress"] = 0.05 + 0.85 * (fi / total)
            upsert_job(rec)
            src = source_path(file_id)
            handle = open_nd2(src)
            sizes = handle.sizes
            stem = _safe_stem(meta.get("name") or file_id)
            stems_used.append(stem)
            # Exported files sit in the same folder as the ND2 file unless flat_structure is requested.
            folder = (
                out_dir
                if req.flat_structure or not meta.get("folder")
                else out_dir / _archive_folder(meta.get("folder") or "")
            )
            folder.mkdir(parents=True, exist_ok=True)

            def target(name: str) -> Path:
                path = _unique(folder / name, taken)
                written.append(path)
                return path

            channels = [dict(c) for c in (meta.get("channels") or [])]
            # Apply optional per-file channel edits passed from Studio live session
            file_ch_edits = (req.channel_edits_by_file or {}).get(file_id)
            if file_ch_edits:
                for idx, ed in enumerate(file_ch_edits):
                    target_idx = ed.index if ed.index is not None else idx
                    if 0 <= target_idx < len(channels):
                        ch = channels[target_idx]
                        if ed.brightness is not None:
                            ch["brightness"] = float(ed.brightness)
                        if ed.min_pct is not None:
                            ch["min_pct"] = float(ed.min_pct)
                        if ed.max_pct is not None:
                            ch["max_pct"] = float(ed.max_pct)
                        if ed.gamma is not None:
                            ch["lut_gamma"] = float(ed.gamma)
                        if ed.visible is not None:
                            ch["visible"] = bool(ed.visible)
                        if ed.color and len(ed.color) >= 3:
                            ch["color"] = [int(ed.color[0]) & 255, int(ed.color[1]) & 255, int(ed.color[2]) & 255]

            file_crop = (req.crops_by_file or {}).get(file_id)

            names = [c.get("name") or f"C{i}" for i, c in enumerate(channels)]
            colors = [c.get("color") or [255, 255, 255] for c in channels]
            voxel = meta.get("voxel_um") or [1, 1, 1]
            bits_sig = _significant_bits(meta, handle)
            if bits_sig and not meta.get("bits_significant"):
                meta = {**meta, "bits_significant": bits_sig}
            coords_list = (
                list(iter_coords(sizes))
                if req.scope == "all"
                else [(req.coords.t, req.coords.z, req.coords.p)]
            )
            n_coords = max(len(coords_list), 1)
            composite_role = "composite" if req.channels_mode == "both" else ""
            ext = "tif" if write_raw else _display_ext(req.format)
            display_fmt = "tiff" if write_raw else req.format
            for ci, (t, z, p) in enumerate(coords_list):
                planes, _ = extract_channels(handle, t=t, z=z, p=p)
                if file_crop and planes:
                    ph, pw = int(planes[0].shape[-2]), int(planes[0].shape[-1])
                    cx0 = max(0, min(pw - 2, int(file_crop.x)))
                    cy0 = max(0, min(ph - 2, int(file_crop.y)))
                    cx1 = max(cx0 + 2, min(pw, cx0 + int(file_crop.w)))
                    cy1 = max(cy0 + 2, min(ph, cy0 + int(file_crop.h)))
                    planes = [np.ascontiguousarray(pl[..., cy0:cy1, cx0:cx1]) for pl in planes]
                    meta = {**meta, "width": cx1 - cx0, "height": cy1 - cy0}
                tag = _coord_tag(t, z, p, sizes)
                luts = build_luts(planes, channels, req.luts, req.visible)
                shown = _visible_channels(len(planes), luts, req.visible)
                ch_names = [_safe_stem(names[i] if i < len(names) else f"C{i}") for i in range(len(planes))]
                want_composite = req.channels_mode in ("composite", "both")
                want_split = req.channels_mode in ("split", "both")

                if write_raw:
                    ch_gains = [float(getattr(luts[i], "brightness", 1.0)) if i < len(luts) else 1.0 for i in range(len(planes))]
                    if want_composite:
                        dest = target(_export_filename(stem, tag=tag, role=composite_role, ext="ome.tif"))
                        _write_ome_tiff(dest, planes, names, colors, voxel, bits_sig, ch_gains)
                    if want_split:
                        for i in shown:
                            dest = target(_export_filename(stem, tag=tag, role=ch_names[i], ext="ome.tif"))
                            _write_ome_tiff(
                                dest,
                                [planes[i]],
                                [names[i] if i < len(names) else f"C{i}"],
                                [colors[i] if i < len(colors) else [255, 255, 255]],
                                voxel,
                                bits_sig,
                                [ch_gains[i]],
                            )
                    readme_dirs.add(folder)

                # Viewable 8-bit images. For OME-TIFF they are companions with the same base name,
                # so ordinary viewers never only get the (dark looking) raw 12/16-bit files.
                if want_composite and shown:
                    rgb = composite_rgb(planes, luts, colors, req.visible)
                    if req.scale_bar and voxel and voxel[0]:
                        rgb = draw_scale_bar(rgb, float(voxel[0]))
                    dest = target(_export_filename(stem, tag=tag, role=composite_role, ext=ext))
                    _save_display(dest, rgb, display_fmt, req.jpeg_quality, voxel)
                if want_split:
                    for i in shown:
                        fallback = colors[i] if i < len(colors) else [255, 255, 255]
                        ch_rgb = _channel_rgb(planes[i], luts[i], fallback)
                        if req.scale_bar and voxel and voxel[0]:
                            ch_rgb = draw_scale_bar(ch_rgb, float(voxel[0]))
                        dest = target(_export_filename(stem, tag=tag, role=ch_names[i], ext=ext))
                        _save_display(dest, ch_rgb, display_fmt, req.jpeg_quality, voxel)

                # Standalone scale bar images (one set per unique scale bar specification)
                if req.separate_scale_bar and planes and voxel and float(voxel[0] or 0) > 0:
                    img_h, img_w = int(planes[0].shape[-2]), int(planes[0].shape[-1])
                    um_val, px_val, bar_pngs = render_standalone_scale_bars(img_w, img_h, float(voxel[0]))
                    scale_dir = folder if req.flat_structure else (folder / "scale_bars")
                    spec_key = (scale_dir, img_w, img_h, round(um_val, 4), px_val)
                    if spec_key not in seen_scale_specs:
                        seen_scale_specs.add(spec_key)
                        scale_dir.mkdir(parents=True, exist_ok=True)
                        um_str = f"{um_val:g}".replace(".", "p")
                        for style_name, png_bytes in bar_pngs.items():
                            bar_name = f"scalebar_{um_str}um_{px_val}px_{img_w}x{img_h}_{style_name}.png"
                            bar_path = _unique(scale_dir / bar_name, taken)
                            bar_path.write_bytes(png_bytes)
                            written.append(bar_path)
                rec["progress"] = 0.05 + 0.85 * ((fi + (ci + 1) / n_coords) / total)
                upsert_job(rec)
            if req.include_metadata:
                sidecar = target(_export_filename(stem, role="metadata", ext="json"))
                payload = {k: jsonable(meta.get(k)) for k in _META_KEYS}
                payload["folder"] = meta.get("folder") or ""
                sidecar.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        for directory in sorted(readme_dirs):
            note = _unique(directory / "README_EXPORT.txt", taken)
            note.write_text(_README, encoding="utf-8")
            written.append(note)
        if not written:
            raise ValueError("Nothing to export: all channels are hidden.")
        label = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in (req.label or "")).strip("_")
        zip_name = _archive_name([label] if label else stems_used, req.format, rec["created_at"], job_id)
        zip_path = settings.exports_dir / zip_name
        rec["message"] = "Packing archive"
        rec["progress"] = 0.95
        upsert_job(rec)
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in written:
                zf.write(path, arcname=path.relative_to(out_dir).as_posix())
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
    finally:
        # The zip is the deliverable; the loose files would only double disk usage.
        shutil.rmtree(out_dir, ignore_errors=True)


def new_job_id() -> str:
    return uuid.uuid4().hex
