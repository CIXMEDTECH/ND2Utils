"""Region / channel exports of whole-slide OME-TIFF files (background jobs).

- ome-tiff: native pixel values of the chosen channels, tiled, pyramidal, BigTIFF. Streamed
  tile by tile, so even a full-resolution whole slide never sits in memory.
- tiff: 8-bit RGB composite with the viewer's channel colors and ranges, tiled BigTIFF (streamed).
- png / jpeg: 8-bit RGB composite, built in memory, therefore limited in size
  (Settings → Performance → raster_max_mpx).
"""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any, Iterator, Literal

import numpy as np
import tifffile
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field

from nd2utils.config import settings
from nd2utils.models import LutSetting
from nd2utils.ometiff import TILE, Slide, iter_tiles, open_slide, read_region
from nd2utils.render import _font, apply_lut, nice_scale_um
from nd2utils.store import get_file_detail, get_owned_job, source_path, upsert_job


def max_raster_pixels() -> int:
    from nd2utils import perf

    return int(perf.value("raster_max_mpx")) * 1_000_000

MAX_JPEG_EDGE = 65_500
SlideFormat = Literal["ome-tiff", "tiff", "png", "jpeg"]


class SlideExportRequest(BaseModel):
    format: SlideFormat = "ome-tiff"
    # [x, y, width, height] in full-resolution pixels; None = the whole image.
    region: list[float] | None = Field(default=None, min_length=4, max_length=4)
    level: int = 0
    # Channels to export (all when empty). For composites these are the visible channels.
    channels: list[int] = []
    # Display settings per channel index (composites only).
    luts: list[LutSetting] = []
    t: int = 0
    z: int = 0
    scale_bar: bool = True
    jpeg_quality: int = Field(default=92, ge=40, le=100)
    pyramid: bool = True


class ExportPlan(BaseModel):
    level: int
    x: int
    y: int
    width: int
    height: int
    downsample: float
    channels: list[int]
    um_per_px: float | None


class SlideExportError(ValueError):
    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


def plan(slide: Slide, req: SlideExportRequest, voxel_um: list[float] | None) -> ExportPlan:
    if not 0 <= req.level < len(slide.levels):
        raise SlideExportError("Resolution level out of range.", "bad_level")
    channels = list(dict.fromkeys(req.channels)) or list(range(slide.n_channels))
    if any(c < 0 or c >= slide.n_channels for c in channels):
        raise SlideExportError("Channel index out of range.", "bad_channel")
    lv = slide.levels[req.level]
    sx, sy = slide.width / lv.width, slide.height / lv.height
    if req.region:
        x0, y0, w0, h0 = (float(v) for v in req.region)
        x1, y1 = min(x0 + w0, slide.width), min(y0 + h0, slide.height)
        x0, y0 = max(x0, 0.0), max(y0, 0.0)
    else:
        x0, y0, x1, y1 = 0.0, 0.0, float(slide.width), float(slide.height)
    lx, ly = int(math.floor(x0 / sx)), int(math.floor(y0 / sy))
    lw = min(int(math.ceil(x1 / sx)), lv.width) - lx
    lh = min(int(math.ceil(y1 / sy)), lv.height) - ly
    if lw <= 0 or lh <= 0:
        raise SlideExportError("The selected region is empty.", "empty_region")
    if req.format in ("png", "jpeg"):
        if lw * lh > max_raster_pixels():
            raise SlideExportError(
                f"{lw} × {lh} px is too large for {req.format.upper()}; choose a lower resolution, a smaller region, or TIFF.",
                "too_large",
            )
        if req.format == "jpeg" and max(lw, lh) > MAX_JPEG_EDGE:
            raise SlideExportError("JPEG images are limited to 65500 px per side.", "too_large")
    um = float(voxel_um[0]) if voxel_um and voxel_um[0] else None
    return ExportPlan(
        level=req.level,
        x=lx,
        y=ly,
        width=lw,
        height=lh,
        downsample=sx,
        channels=channels,
        um_per_px=um * sx if um else None,
    )


# --- compositing ----------------------------------------------------------------


class Compositor:
    """Maps native channel values to RGB with lookup tables (u8/u16) or arithmetic (others)."""

    def __init__(self, slide: Slide, channels: list[int], luts: list[LutSetting], colors: list[list[int]]):
        self.items: list[tuple[int, LutSetting, np.ndarray, np.ndarray | None]] = []
        integer = slide.dtype in (np.uint8, np.uint16)
        for c in channels:
            lut = luts[c] if c < len(luts) else None
            if lut is None:
                top = float(np.iinfo(slide.dtype).max) if np.issubdtype(slide.dtype, np.integer) else 1.0
                lut = LutSetting(min=0, max=top)
            color = np.asarray(lut.color or (colors[c] if c < len(colors) else [255, 255, 255]), dtype=np.float32)
            table = None
            if integer:
                values = np.arange(np.iinfo(slide.dtype).max + 1, dtype=np.float32)
                table = apply_lut(values, lut.min, lut.max, lut.gamma, [255, 255, 255])[..., 0].astype(np.float32)
            self.items.append((c, lut, color / 255.0, table))

    def __call__(self, blocks: dict[int, np.ndarray]) -> np.ndarray:
        first = next(iter(blocks.values()))
        acc = np.zeros(first.shape + (3,), dtype=np.float32)
        for c, lut, color, table in self.items:
            data = blocks[c]
            if table is not None:
                y = table[data]
                acc += y[..., None] * color
            else:
                acc += apply_lut(data, lut.min, lut.max, lut.gamma, (color * 255).tolist())
        np.clip(acc, 0.0, 1.0, out=acc)
        return (acc * 255.0 + 0.5).astype(np.uint8)


def _scale_bar_patch(width: int, height: int, um_per_px: float | None) -> tuple[int, int, np.ndarray] | None:
    """The scale bar box for the bottom-right corner, as (x, y, RGBA patch). Same look as render.draw_scale_bar."""
    if not um_per_px or width < 64 or height < 48:
        return None
    um, px = nice_scale_um(um_per_px, width)
    pad = 16
    patch_w = min(px + pad + 12, width)
    patch_h = 44
    img = Image.new("RGBA", (patch_w, patch_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    x1 = patch_w - pad
    x0 = x1 - px
    y = patch_h - pad
    y0 = y - 4
    draw.rectangle([x0 - 6, y0 - 18, x1 + 6, y + 4], fill=(8, 8, 10, 255))
    draw.rectangle([x0, y0, x1, y0 + 3], fill=(240, 244, 248, 255))
    draw.text((x0, y0 - 16), f"{um:g} um", fill=(240, 244, 248, 255), font=_font(12))
    return width - patch_w, height - patch_h, np.asarray(img)


def _paste(tile: np.ndarray, tx: int, ty: int, patch: tuple[int, int, np.ndarray] | None) -> None:
    if patch is None:
        return
    px, py, rgba = patch
    th, tw = tile.shape[:2]
    x0, y0 = max(px, tx), max(py, ty)
    x1, y1 = min(px + rgba.shape[1], tx + tw), min(py + rgba.shape[0], ty + th)
    if x1 <= x0 or y1 <= y0:
        return
    src = rgba[y0 - py : y1 - py, x0 - px : x1 - px]
    dst = tile[y0 - ty : y1 - ty, x0 - tx : x1 - tx]
    opaque = src[..., 3] > 0
    dst[opaque] = src[..., :3][opaque]


# --- writers ----------------------------------------------------------------------


def _ome_color(rgb: list[int]) -> int:
    r, g, b = (int(v) & 255 for v in (list(rgb) + [255, 255, 255])[:3])
    value = (r << 24) | (g << 16) | (b << 8) | 255
    return value - 2**32 if value >= 2**31 else value


def _sub_levels(slide: Slide, p: ExportPlan) -> list[tuple[int, int, int, int, int]]:
    """Coarser source levels covering the same region: (level, x, y, w, h)."""
    out = []
    x0, y0 = p.x * p.downsample, p.y * p.downsample
    x1, y1 = (p.x + p.width) * p.downsample, (p.y + p.height) * p.downsample
    for li in range(p.level + 1, len(slide.levels)):
        lv = slide.levels[li]
        sx, sy = slide.width / lv.width, slide.height / lv.height
        lx, ly = int(x0 // sx), int(y0 // sy)
        lw = min(int(math.ceil(x1 / sx)), lv.width) - lx
        lh = min(int(math.ceil(y1 / sy)), lv.height) - ly
        if lw < 1 or lh < 1:
            break
        out.append((li, lx, ly, lw, lh))
        if max(lw, lh) <= TILE:
            break
    return out


def write_ome_tiff(
    slide: Slide,
    p: ExportPlan,
    req: SlideExportRequest,
    meta: dict[str, Any],
    dest: Path,
    progress,
) -> None:
    channels = meta.get("channels") or []
    names = [str(channels[c].get("name") if c < len(channels) else f"C{c}") for c in p.channels]
    colors = [(req.luts[c].color if c < len(req.luts) and req.luts[c].color else None) or (channels[c].get("color") if c < len(channels) else None) or [255, 255, 255] for c in p.channels]
    subs = _sub_levels(slide, p) if req.pyramid else []
    metadata: dict[str, Any] = {
        "axes": "CYX",
        "Channel": {"Name": names, "Color": [_ome_color(c) for c in colors]},
    }
    if meta.get("bits_significant"):
        metadata["SignificantBits"] = int(meta["bits_significant"])
    resolution = None
    if p.um_per_px:
        metadata.update(
            PhysicalSizeX=p.um_per_px, PhysicalSizeXUnit="µm", PhysicalSizeY=p.um_per_px, PhysicalSizeYUnit="µm"
        )
        resolution = (1e4 / p.um_per_px, 1e4 / p.um_per_px)
    total = sum(math.ceil(w / TILE) * math.ceil(h / TILE) for _, _, _, w, h in [(p.level, p.x, p.y, p.width, p.height), *subs])
    total *= len(p.channels)
    done = 0

    def tiles(level: int, x: int, y: int, w: int, h: int) -> Iterator[np.ndarray]:
        nonlocal done
        for c in p.channels:
            for block in iter_tiles(slide, level, c, x, y, w, h, t=req.t, z=req.z):
                done += 1
                if done % 64 == 0:
                    progress(done / max(total, 1))
                yield block

    options: dict[str, Any] = {
        "dtype": slide.dtype,
        "tile": (TILE, TILE),
        "photometric": "minisblack",
        "compression": "zlib",
        "compressionargs": {"level": 4},
    }
    with tifffile.TiffWriter(dest, bigtiff=True, ome=True) as tif:
        tif.write(
            tiles(p.level, p.x, p.y, p.width, p.height),
            shape=(len(p.channels), p.height, p.width),
            subifds=len(subs),
            metadata=metadata,
            resolution=resolution,
            resolutionunit="CENTIMETER" if resolution else None,
            **options,
        )
        for level, x, y, w, h in subs:
            factor = (slide.width / slide.levels[level].width) / p.downsample
            sub_res = (resolution[0] / factor, resolution[1] / factor) if resolution else None
            tif.write(
                tiles(level, x, y, w, h),
                shape=(len(p.channels), h, w),
                subfiletype=1,
                metadata=None,
                resolution=sub_res,
                resolutionunit="CENTIMETER" if sub_res else None,
                **options,
            )


def _composite_tiles(slide: Slide, p: ExportPlan, req: SlideExportRequest, compose: Compositor, patch, progress) -> Iterator[tuple[int, int, np.ndarray]]:
    nx, ny = math.ceil(p.width / TILE), math.ceil(p.height / TILE)
    total = max(nx * ny, 1)
    for ty in range(ny):
        for tx in range(nx):
            ox, oy = tx * TILE, ty * TILE
            blocks = {
                c: read_region(slide, p.level, c, p.x + ox, p.y + oy, TILE, TILE, t=req.t, z=req.z) for c in p.channels
            }
            rgb = compose(blocks)
            if ox + TILE > p.width:
                rgb[:, p.width - ox :] = 0
            if oy + TILE > p.height:
                rgb[p.height - oy :, :] = 0
            _paste(rgb, ox, oy, patch)
            yield ox, oy, rgb
            done = ty * nx + tx + 1
            if done % 16 == 0:
                progress(done / total)


def write_composite(slide: Slide, p: ExportPlan, req: SlideExportRequest, meta: dict[str, Any], dest: Path, progress) -> None:
    colors = [c.get("color") or [255, 255, 255] for c in meta.get("channels") or []]
    shown = [c for c in p.channels if not (c < len(req.luts) and not req.luts[c].visible)]
    if not shown:
        raise SlideExportError("Nothing to export: all channels are hidden.", "empty")
    p = p.model_copy(update={"channels": shown})
    compose = Compositor(slide, shown, req.luts, colors)
    patch = _scale_bar_patch(p.width, p.height, p.um_per_px) if req.scale_bar else None
    if req.format == "tiff":
        resolution = (1e4 / p.um_per_px, 1e4 / p.um_per_px) if p.um_per_px else None
        with tifffile.TiffWriter(dest, bigtiff=p.width * p.height * 3 > 2**31) as tif:
            tif.write(
                (rgb for _, _, rgb in _composite_tiles(slide, p, req, compose, patch, progress)),
                shape=(p.height, p.width, 3),
                dtype=np.uint8,
                tile=(TILE, TILE),
                photometric="rgb",
                compression="zlib",
                compressionargs={"level": 6},
                resolution=resolution,
                resolutionunit="CENTIMETER" if resolution else None,
                metadata=None,
            )
        return
    canvas = np.zeros((p.height, p.width, 3), dtype=np.uint8)
    for ox, oy, rgb in _composite_tiles(slide, p, req, compose, patch, progress):
        h, w = min(TILE, p.height - oy), min(TILE, p.width - ox)
        canvas[oy : oy + h, ox : ox + w] = rgb[:h, :w]
    img = Image.fromarray(canvas, mode="RGB")
    dpi = (25400 / p.um_per_px,) * 2 if p.um_per_px else None
    if req.format == "png":
        img.save(dest, format="PNG", compress_level=6, **({"dpi": dpi} if dpi else {}))
    else:
        img.save(dest, format="JPEG", quality=int(req.jpeg_quality), subsampling=0, **({"dpi": dpi} if dpi else {}))


# --- job --------------------------------------------------------------------------

_EXT = {"ome-tiff": "ome.tif", "tiff": "tif", "png": "png", "jpeg": "jpg"}
_ILLEGAL = set('<>:"/\\|?*')


def _stem(name: str) -> str:
    base = name
    for suffix in (".ome.tiff", ".ome.tif", ".tiff", ".tif"):
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)]
            break
    cleaned = "".join("_" if ch in _ILLEGAL or ord(ch) < 32 else ch for ch in base).strip(" .")
    return cleaned or "slide"


def output_name(meta: dict[str, Any], p: ExportPlan, req: SlideExportRequest, full: bool) -> str:
    parts = [_stem(meta.get("name") or "slide")]
    # Position in full-resolution pixels (what the viewer shows), size in output pixels.
    x0, y0 = round(p.x * p.downsample), round(p.y * p.downsample)
    parts.append("full" if full else f"x{x0}-y{y0}-{p.width}x{p.height}")
    if p.downsample > 1.0001:
        parts.append(f"1-{p.downsample:.3g}")
    channels = meta.get("channels") or []
    if len(p.channels) < len(channels):
        parts.append("C" + "+".join(str(c + 1) for c in p.channels))
    return "_".join(parts) + "." + _EXT[req.format]


def run_slide_export(job_id: str, file_id: str, req: SlideExportRequest, owner_id: str) -> None:
    rec = get_owned_job(job_id, owner_id) or {}
    rec.update({"status": "running", "progress": 0.01, "message": "Preparing export"})
    upsert_job(rec)
    dest: Path | None = None
    try:
        meta = get_file_detail(file_id, owner_id)
        if not meta:
            raise FileNotFoundError("File not found.")
        slide = open_slide(source_path(file_id), file_id)
        p = plan(slide, req, meta.get("voxel_um"))
        name = output_name(meta, p, req, full=req.region is None)
        folder = settings.exports_dir / job_id
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / name
        last = [0.0]

        def progress(ratio: float) -> None:
            now = time.monotonic()
            if now - last[0] < 0.5:
                return
            last[0] = now
            rec["progress"] = 0.02 + 0.96 * min(max(ratio, 0.0), 1.0)
            rec["message"] = f"Writing {name}"
            upsert_job(rec)

        if req.format == "ome-tiff":
            write_ome_tiff(slide, p, req, meta, dest, progress)
        else:
            write_composite(slide, p, req, meta, dest, progress)
        rec.update(
            {
                "status": "done",
                "progress": 1.0,
                "message": "Export complete",
                "download_name": name,
                "zip_path": str(dest),
            }
        )
        upsert_job(rec)
    except Exception as exc:
        if dest is not None:
            dest.unlink(missing_ok=True)
        rec.update({"status": "error", "error": str(exc), "message": str(exc)})
        upsert_job(rec)
