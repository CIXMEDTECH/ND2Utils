from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from nd2utils.models import LutSetting


def _as_float(plane: np.ndarray) -> np.ndarray:
    return np.asarray(plane, dtype=np.float32)


def autoscale_limits(plane: np.ndarray, p_lo: float = 5.0, p_hi: float = 99.85) -> tuple[float, float]:
    data = _as_float(plane)
    if data.size == 0:
        return 0.0, 1.0
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return 0.0, 1.0
    lo = float(np.percentile(finite, p_lo))
    hi = float(np.percentile(finite, p_hi))
    if hi <= lo:
        hi = lo + 1.0
    return lo, hi


def apply_lut(
    plane: np.ndarray,
    vmin: float,
    vmax: float,
    gamma: float,
    color: list[int],
) -> np.ndarray:
    x = _as_float(plane)
    span = max(float(vmax) - float(vmin), 1e-6)
    y = np.clip((x - float(vmin)) / span, 0.0, 1.0)
    g = float(gamma) if gamma and gamma > 0 else 1.0
    if abs(g - 1.0) > 1e-6:
        y = np.power(y, 1.0 / g)
    r, gcol, b = (c / 255.0 for c in color)
    rgb = np.empty(y.shape + (3,), dtype=np.float32)
    rgb[..., 0] = y * r
    rgb[..., 1] = y * gcol
    rgb[..., 2] = y * b
    return rgb


def composite_rgb(
    planes: list[np.ndarray],
    luts: list[LutSetting],
    colors: list[list[int]],
    visible: list[bool] | None = None,
) -> np.ndarray:
    if not planes:
        raise ValueError("no planes")
    h, w = planes[0].shape[-2], planes[0].shape[-1]
    acc = np.zeros((h, w, 3), dtype=np.float32)
    vis = visible if visible is not None else [True] * len(planes)
    for i, plane in enumerate(planes):
        if i < len(vis) and not vis[i]:
            continue
        lut = luts[i] if i < len(luts) else LutSetting(min=0, max=float(plane.max() or 1))
        if not lut.visible:
            continue
        color = lut.color or (colors[i] if i < len(colors) else [255, 255, 255])
        acc += apply_lut(plane, lut.min, lut.max, lut.gamma, color)
    acc = np.clip(acc, 0.0, 1.0)
    return (acc * 255.0 + 0.5).astype(np.uint8)


def parse_visible_mask(raw: str | None, n: int) -> list[bool] | None:
    if raw is None or not str(raw).strip():
        return None
    bits: list[bool] = []
    for part in str(raw).split(","):
        token = part.strip().lower()
        bits.append(token in {"1", "true", "yes", "on"})
    if not bits:
        return None
    if len(bits) < n:
        bits.extend([True] * (n - len(bits)))
    return bits[:n]


def split_mosaic(
    planes: list[np.ndarray],
    luts: list[LutSetting],
    colors: list[list[int]],
    names: list[str],
    visible: list[bool] | None = None,
) -> np.ndarray:
    vis = visible if visible is not None else [True] * len(planes)
    tiles: list[tuple[np.ndarray, str]] = []
    for i, plane in enumerate(planes):
        if i < len(vis) and not vis[i]:
            continue
        lut = luts[i] if i < len(luts) else LutSetting(min=0, max=1)
        if not lut.visible:
            continue
        color = lut.color or (colors[i] if i < len(colors) else [255, 255, 255])
        rgb = (np.clip(apply_lut(plane, lut.min, lut.max, lut.gamma, color), 0, 1) * 255).astype(np.uint8)
        tiles.append((rgb, names[i] if i < len(names) else f"C{i}"))
    if not tiles:
        h, w = planes[0].shape[-2], planes[0].shape[-1]
        return np.zeros((h, w, 3), dtype=np.uint8)
    n = len(tiles)
    cols = int(np.ceil(np.sqrt(n)))
    rows = int(np.ceil(n / cols))
    h, w = tiles[0][0].shape[:2]
    gap = 2 if n > 1 else 0
    canvas = np.zeros((rows * h + (rows - 1) * gap, cols * w + (cols - 1) * gap, 3), dtype=np.uint8)
    origins: list[tuple[int, int]] = []
    for i, (tile, _) in enumerate(tiles):
        r, c = divmod(i, cols)
        y0 = r * (h + gap)
        x0 = c * (w + gap)
        canvas[y0 : y0 + h, x0 : x0 + w] = tile
        origins.append((x0, y0))
    img = Image.fromarray(canvas, mode="RGB")
    draw = ImageDraw.Draw(img)
    font = _font(13)
    for (x0, y0), (_, name) in zip(origins, tiles):
        x, y = x0 + 8, y0 + 6
        bbox = draw.textbbox((x, y), name, font=font)
        draw.rectangle([bbox[0] - 5, bbox[1] - 3, bbox[2] + 5, bbox[3] + 3], fill=(8, 8, 10))
        draw.text((x, y), name, fill=(240, 244, 248), font=font)
    return np.asarray(img)


def preview_rgb(
    planes: list[np.ndarray],
    channels: list[dict],
    *,
    composite: bool = True,
    scale_bar: bool = True,
    visible: list[bool] | None = None,
    voxel_um: list[float] | None = None,
    overrides: dict[str, LutSetting] | None = None,
) -> np.ndarray:
    luts = build_luts(planes, channels, overrides, visible)
    colors = [c.get("color") or [255, 255, 255] for c in channels]
    if composite:
        rgb = composite_rgb(planes, luts, colors, visible)
    else:
        names = [c.get("name") or f"C{i}" for i, c in enumerate(channels)]
        rgb = split_mosaic(planes, luts, colors, names, visible)
    um = float((voxel_um or [0])[0] or 0)
    if scale_bar and um:
        rgb = draw_scale_bar(rgb, um)
    return rgb


def nice_scale_um(um_per_px: float, width_px: int) -> tuple[float, int]:
    target_px = max(width_px / 6.0, 32)
    target_um = target_px * um_per_px
    if target_um <= 0:
        return 10.0, int(10 / um_per_px) if um_per_px else 50
    exp = np.floor(np.log10(target_um))
    frac = target_um / (10 ** exp)
    if frac < 1.5:
        nice = 1.0
    elif frac < 3.5:
        nice = 2.0
    elif frac < 7.5:
        nice = 5.0
    else:
        nice = 10.0
    um = nice * (10 ** exp)
    px = max(int(round(um / um_per_px)), 8)
    return float(um), px


def _font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_scale_bar(rgb: np.ndarray, um_per_px: float) -> np.ndarray:
    if um_per_px <= 0:
        return rgb
    img = Image.fromarray(rgb, mode="RGB")
    draw = ImageDraw.Draw(img)
    um, px = nice_scale_um(um_per_px, img.width)
    pad = 16
    y = img.height - pad
    x1 = img.width - pad
    x0 = x1 - px
    y0 = y - 4
    draw.rectangle([x0 - 6, y0 - 18, x1 + 6, y + 4], fill=(8, 8, 10))
    draw.rectangle([x0, y0, x1, y0 + 3], fill=(240, 244, 248))
    label = f"{um:g} um"
    font = _font(12)
    draw.text((x0, y0 - 16), label, fill=(240, 244, 248), font=font)
    return np.asarray(img)


def encode_image(rgb: np.ndarray, fmt: str = "jpeg", quality: int = 88) -> bytes:
    img = Image.fromarray(rgb, mode="RGB")
    buf = BytesIO()
    if fmt == "png":
        img.save(buf, format="PNG", optimize=True)
    else:
        img.save(buf, format="JPEG", quality=int(quality), subsampling=1, optimize=True)
    return buf.getvalue()


def histogram(plane: np.ndarray, bins: int = 256, vmax: float | None = None) -> dict:
    data = _as_float(plane).ravel()
    if data.size == 0:
        return {"bins": [], "counts": [], "min": 0, "max": 0, "mean": 0}
    hi = float(vmax) if vmax is not None else float(np.max(data))
    lo = 0.0
    if hi <= lo:
        hi = lo + 1
    counts, edges = np.histogram(data, bins=bins, range=(lo, hi))
    return {
        "bins": edges.astype(float).tolist(),
        "counts": counts.astype(int).tolist(),
        "min": float(np.min(data)),
        "max": float(np.max(data)),
        "mean": float(np.mean(data)),
        "p01": float(np.percentile(data, 1)),
        "p99": float(np.percentile(data, 99.6)),
    }


def line_profile(plane: np.ndarray, x0: float, y0: float, x1: float, y1: float, n: int = 256) -> dict:
    h, w = plane.shape[-2], plane.shape[-1]
    xs = np.linspace(x0, x1, n)
    ys = np.linspace(y0, y1, n)
    xs = np.clip(xs, 0, w - 1)
    ys = np.clip(ys, 0, h - 1)
    values = []
    arr = np.asarray(plane)
    for x, y in zip(xs, ys):
        values.append(float(arr[int(round(y)), int(round(x))]))
    dist = float(np.hypot(x1 - x0, y1 - y0))
    return {"n": n, "distance_px": dist, "values": values, "xs": xs.tolist(), "ys": ys.tolist()}


def _poly_mask(h: int, w: int, points: list[list[float]], tool: str) -> np.ndarray:
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    pts = [(float(p[0]), float(p[1])) for p in points]
    if tool == "rect" and len(pts) >= 2:
        x0, y0 = pts[0]
        x1, y1 = pts[1]
        draw.rectangle([x0, y0, x1, y1], fill=255)
    elif tool == "ellipse" and len(pts) >= 2:
        x0, y0 = pts[0]
        x1, y1 = pts[1]
        draw.ellipse([x0, y0, x1, y1], fill=255)
    elif tool in ("polygon", "line") and len(pts) >= 2:
        if tool == "line":
            draw.line(pts, fill=255, width=3)
        else:
            draw.polygon(pts, fill=255)
    elif tool == "point" and pts:
        x, y = pts[0]
        draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=255)
    return np.asarray(mask) > 0


def measure_planes(
    planes: list[np.ndarray],
    channel_names: list[str],
    tool: str,
    points: list[list[float]],
    um_per_px: float,
) -> dict:
    if not planes:
        return {"error": "no data"}
    h, w = planes[0].shape[-2], planes[0].shape[-1]
    mask = _poly_mask(h, w, points, tool)
    area_px = int(mask.sum())
    stats = []
    for i, plane in enumerate(planes):
        vals = np.asarray(plane)[mask] if area_px else np.asarray([])
        if vals.size == 0:
            rec = {"name": channel_names[i] if i < len(channel_names) else f"C{i}", "count": 0}
        else:
            rec = {
                "name": channel_names[i] if i < len(channel_names) else f"C{i}",
                "count": int(vals.size),
                "min": float(vals.min()),
                "max": float(vals.max()),
                "mean": float(vals.mean()),
                "std": float(vals.std()),
                "sum": float(vals.sum()),
            }
        stats.append(rec)
    length_px = 0.0
    if tool in ("line",) and len(points) >= 2:
        for a, b in zip(points, points[1:]):
            length_px += float(np.hypot(b[0] - a[0], b[1] - a[1]))
    return {
        "tool": tool,
        "area_px": area_px,
        "area_um2": area_px * (um_per_px ** 2) if um_per_px else None,
        "length_px": length_px,
        "length_um": length_px * um_per_px if um_per_px else None,
        "channels": stats,
    }


def build_luts(
    planes: list[np.ndarray],
    channels: list[dict],
    overrides: dict[str, LutSetting] | None = None,
    visible: list[bool] | None = None,
) -> list[LutSetting]:
    luts: list[LutSetting] = []
    for i, plane in enumerate(planes):
        ch = channels[i] if i < len(channels) else {}
        key = str(i)
        if overrides and (key in overrides or ch.get("name") in (overrides or {})):
            lut = overrides.get(key) or overrides.get(str(ch.get("name")))
            if lut:
                if visible is not None and i < len(visible):
                    lut = lut.model_copy(update={"visible": visible[i]})
                luts.append(lut)
                continue
        lo, hi = autoscale_limits(plane)
        file_max = ch.get("lut_max")
        # File LUT is often 16-bit while data is 12-bit; prefer autoscale for display.
        color = ch.get("color") or [255, 255, 255]
        vis = True if visible is None or i >= len(visible) else bool(visible[i])
        luts.append(
            LutSetting(
                min=lo,
                max=hi if file_max is None else min(hi * 1.0, float(file_max) if file_max else hi),
                gamma=float(ch.get("lut_gamma") or 1.0),
                visible=vis,
                color=list(color),
            )
        )
    return luts
