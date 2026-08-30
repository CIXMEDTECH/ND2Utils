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
from nd2utils.store import get_file, source_path, upsert_job


def _safe_stem(name: str) -> str:
    stem = Path(name).stem
    out = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in stem)
    return out or "nd2"


def _coord_tag(t: int, z: int, p: int, sizes: dict[str, int]) -> str:
    parts = []
    if axis_size(sizes, "T") > 1:
        parts.append(f"t{t:04d}")
    if axis_size(sizes, "Z") > 1:
        parts.append(f"z{z:03d}")
    if axis_size(sizes, "P") > 1:
        parts.append(f"p{p:03d}")
    return "_".join(parts)


def _write_tiff(path: Path, planes: list[np.ndarray], names: list[str], voxel: list[float]) -> None:
    arr = np.stack([np.asarray(p) for p in planes], axis=0)
    metadata = {"axes": "CYX", "Channel": {"Name": names}}
    tifffile.imwrite(
        path,
        arr,
        photometric="minisblack",
        metadata=metadata,
        imagej=True,
        resolution=(1 / voxel[0] if voxel and voxel[0] else 1, 1 / voxel[1] if voxel and len(voxel) > 1 and voxel[1] else 1),
    )


def _write_ome_tiff(path: Path, planes: list[np.ndarray], names: list[str], colors: list[list[int]], voxel: list[float]) -> None:
    arr = np.stack([np.asarray(p) for p in planes], axis=0)
    # CYX
    tifffile.imwrite(
        path,
        arr,
        photometric="minisblack",
        metadata={"axes": "CYX"},
        ome=True,
        resolution=(
            1 / voxel[0] if voxel and voxel[0] else 1,
            1 / voxel[1] if voxel and len(voxel) > 1 and voxel[1] else 1,
        ),
    )


def run_export(job_id: str, req: ExportRequest) -> None:
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
    }
    upsert_job(rec)
    out_dir = settings.exports_dir / job_id
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    total = max(len(req.file_ids), 1)
    try:
        for fi, file_id in enumerate(req.file_ids):
            rec["message"] = f"Exporting {file_id}"
            rec["progress"] = 0.05 + 0.85 * (fi / total)
            upsert_job(rec)
            meta = get_file(file_id)
            if not meta:
                raise FileNotFoundError(f"Unknown file {file_id}")
            src = source_path(file_id)
            handle = open_nd2(src)
            sizes = handle.sizes
            stem = _safe_stem(meta.get("name") or file_id)
            folder = out_dir / stem
            folder.mkdir(exist_ok=True)
            channels = meta.get("channels") or []
            names = [c.get("name") or f"C{i}" for i, c in enumerate(channels)]
            colors = [c.get("color") or [255, 255, 255] for c in channels]
            voxel = meta.get("voxel_um") or [1, 1, 1]
            coords_list = (
                list(iter_coords(sizes))
                if req.scope == "all"
                else [(req.coords.t, req.coords.z, req.coords.p)]
            )
            n_coords = max(len(coords_list), 1)
            for ci, (t, z, p) in enumerate(coords_list):
                planes, _ = extract_channels(handle, t=t, z=z, p=p)
                tag = _coord_tag(t, z, p, sizes)
                suffix = f"_{tag}" if tag else ""
                luts = build_luts(planes, channels, req.luts, req.visible)
                if req.format in ("ome-tiff", "tiff") and not req.burn_lut:
                    if req.channels_mode in ("split", "both"):
                        for i, plane in enumerate(planes):
                            ch_name = _safe_stem(names[i] if i < len(names) else f"C{i}")
                            dest = folder / f"{stem}{suffix}_{ch_name}.tif"
                            tifffile.imwrite(dest, np.asarray(plane))
                            written.append(dest)
                    if req.channels_mode in ("composite", "both"):
                        dest = folder / f"{stem}{suffix}.{'ome.tif' if req.format == 'ome-tiff' else 'tif'}"
                        if req.format == "ome-tiff":
                            _write_ome_tiff(dest, planes, names, colors, voxel)
                        else:
                            _write_tiff(dest, planes, names, voxel)
                        written.append(dest)
                else:
                    vis = req.visible
                    rgb = composite_rgb(planes, luts, colors, vis)
                    if req.scale_bar and voxel and voxel[0]:
                        rgb = draw_scale_bar(rgb, float(voxel[0]))
                    if req.channels_mode in ("composite", "both"):
                        if req.format == "png":
                            dest = folder / f"{stem}{suffix}.png"
                            Image.fromarray(rgb).save(dest)
                        elif req.format == "jpeg":
                            dest = folder / f"{stem}{suffix}.jpg"
                            dest.write_bytes(encode_image(rgb, "jpeg", req.jpeg_quality))
                        else:
                            dest = folder / f"{stem}{suffix}_lut.tif"
                            Image.fromarray(rgb).save(dest)
                        written.append(dest)
                    if req.channels_mode in ("split", "both"):
                        for i, plane in enumerate(planes):
                            lut = luts[i]
                            ch_rgb = composite_rgb([plane], [lut], [lut.color or colors[i]], [True])
                            if req.scale_bar and voxel and voxel[0]:
                                ch_rgb = draw_scale_bar(ch_rgb, float(voxel[0]))
                            ch_name = _safe_stem(names[i] if i < len(names) else f"C{i}")
                            ext = "png" if req.format == "png" else ("jpg" if req.format == "jpeg" else "tif")
                            dest = folder / f"{stem}{suffix}_{ch_name}.{ext}"
                            if ext == "jpg":
                                dest.write_bytes(encode_image(ch_rgb, "jpeg", req.jpeg_quality))
                            else:
                                Image.fromarray(ch_rgb).save(dest)
                            written.append(dest)
                rec["progress"] = 0.05 + 0.85 * ((fi + (ci + 1) / n_coords) / total)
                upsert_job(rec)
            if req.include_metadata:
                sidecar = folder / f"{stem}_metadata.json"
                sidecar.write_text(
                    json.dumps(
                        {
                            k: jsonable(meta.get(k))
                            for k in (
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
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                written.append(sidecar)
        zip_name = f"nd2utils-export-{job_id[:8]}.zip"
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
