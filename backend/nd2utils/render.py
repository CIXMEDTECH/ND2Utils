from __future__ import annotations

from collections import deque
from io import BytesIO
import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from nd2utils.models import LutSetting, NucleusParams


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
    brightness: float = 1.0,
) -> np.ndarray:
    x = _as_float(plane)
    span = max(float(vmax) - float(vmin), 1e-6)
    y = np.clip((x - float(vmin)) / span, 0.0, 1.0)
    g = float(gamma) if gamma and gamma > 0 else 1.0
    if abs(g - 1.0) > 1e-6:
        y = np.power(y, 1.0 / g)
    gain = max(0.0, float(brightness if brightness is not None else 1.0))
    if abs(gain - 1.0) > 1e-6:
        y = np.clip(y * gain, 0.0, 1.0)
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
        acc += apply_lut(plane, lut.min, lut.max, lut.gamma, color, getattr(lut, "brightness", 1.0))
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
        rgb = (np.clip(apply_lut(plane, lut.min, lut.max, lut.gamma, color, getattr(lut, "brightness", 1.0)), 0, 1) * 255).astype(np.uint8)
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
    target_px = min(max(width_px / 6.0, 24.0), max(width_px * 0.4, 8.0))
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
    if width_px > 24 and px > width_px - 24:
        px = max(8, width_px - 24)
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
        try:
            img.save(buf, format="JPEG", quality=int(quality), subsampling=1, optimize=True)
        except OSError:
            # libjpeg's optimizer runs out of buffer on very noisy images ("Suspension not allowed").
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=int(quality), subsampling=1)
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
        lo, hi = autoscale_limits(plane)
        file_max = ch.get("lut_max")
        if file_max:
            hi = max(min(hi * 1.0, float(file_max)), lo + 1.0)
        key = str(i)
        if overrides and (key in overrides or ch.get("name") in (overrides or {})):
            lut = overrides.get(key) or overrides.get(str(ch.get("name")))
            if lut:
                updates: dict[str, Any] = {}
                if visible is not None and i < len(visible):
                    updates["visible"] = visible[i]
                if lut.min_pct is not None or lut.max_pct is not None:
                    span = max(hi - lo, 1.0)
                    min_p = float(lut.min_pct if lut.min_pct is not None else 0.0)
                    max_p = float(lut.max_pct if lut.max_pct is not None else 100.0)
                    eff_min = lo + (min_p / 100.0) * span
                    eff_max = max(eff_min + 1e-3, lo + (max_p / 100.0) * span)
                    updates["min"] = eff_min
                    updates["max"] = eff_max
                if updates:
                    lut = lut.model_copy(update=updates)
                luts.append(lut)
                continue
        min_pct = float(ch.get("min_pct") if ch.get("min_pct") is not None else 0.0)
        max_pct = float(ch.get("max_pct") if ch.get("max_pct") is not None else 100.0)
        span = max(hi - lo, 1.0)
        eff_min = lo + (min_pct / 100.0) * span
        eff_max = max(eff_min + 1e-3, lo + (max_pct / 100.0) * span)
        color = ch.get("color") or [255, 255, 255]
        ch_vis = bool(ch.get("visible", True))
        vis = ch_vis if visible is None or i >= len(visible) else bool(visible[i])
        luts.append(
            LutSetting(
                min=eff_min,
                max=eff_max,
                gamma=float(ch.get("lut_gamma") or 1.0),
                brightness=float(ch.get("brightness") if ch.get("brightness") is not None else 1.0),
                min_pct=min_pct,
                max_pct=max_pct,
                visible=vis,
                color=list(color),
            )
        )
    return luts


# --- Nucleus segmentation ported from Foci_Counter.groovy ------------------


def identify_nucleus_channel(channels: list[dict[str, Any]], override_index: int | None = None) -> int:
    """Identify the nuclear channel (DAPI / Hoechst / Blue / Cyan), matching Foci_Counter.groovy."""
    n = len(channels)
    if n == 0:
        return 0
    if override_index is not None and 0 <= int(override_index) < n:
        return int(override_index)
    keywords = ("dapi", "hoechst", "blue", "405", "nuc", "hoec")
    for idx, ch in enumerate(channels):
        name = str(ch.get("name") or "").lower()
        if any(kw in name for kw in keywords):
            return idx
    # Fallback to LUT color: Blue (b > 150, r < 100, g < 100) then Cyan (b > 150, g > 150, r < 100)
    for idx, ch in enumerate(channels):
        color = ch.get("color") or [255, 255, 255]
        if len(color) >= 3:
            r, g, b = int(color[0]), int(color[1]), int(color[2])
            if b > 150 and r < 100 and g < 100:
                return idx
    for idx, ch in enumerate(channels):
        color = ch.get("color") or [255, 255, 255]
        if len(color) >= 3:
            r, g, b = int(color[0]), int(color[1]), int(color[2])
            if b > 150 and g > 150 and r < 100:
                return idx
    return 0


def _gaussian_blur_2d(plane: np.ndarray, sigma: float) -> np.ndarray:
    arr = np.asarray(plane, dtype=np.float32)
    if sigma <= 0.3 or arr.ndim != 2 or arr.size == 0:
        return arr.copy()
    radius = max(1, min(16, int(math.ceil(3.0 * sigma))))
    xs = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(xs * xs) / (2.0 * sigma * sigma))
    kernel /= float(kernel.sum() or 1.0)
    pad_x = np.pad(arr, ((0, 0), (radius, radius)), mode="edge")
    horiz = np.zeros_like(arr, dtype=np.float32)
    for k_idx, weight in enumerate(kernel):
        horiz += float(weight) * pad_x[:, k_idx : k_idx + arr.shape[1]]
    pad_y = np.pad(horiz, ((radius, radius), (0, 0)), mode="edge")
    out = np.zeros_like(arr, dtype=np.float32)
    for k_idx, weight in enumerate(kernel):
        out += float(weight) * pad_y[k_idx : k_idx + arr.shape[0], :]
    return out


def _auto_threshold_256(hist: np.ndarray, method: str = "Otsu") -> int:
    """Port of ImageJ AutoThresholder on a 256-bin histogram."""
    h = np.asarray(hist, dtype=np.float64)
    total = float(h.sum())
    if total <= 0:
        return 128
    m = (method or "Otsu").strip().lower()
    bins = np.arange(256, dtype=np.float64)

    if m == "mean":
        return int(np.clip(math.floor(float((h * bins).sum() / total)), 1, 254))

    if m == "isodata":
        t = 128
        for _ in range(64):
            lo = h[: t + 1]
            hi = h[t + 1 :]
            s_lo = float(lo.sum())
            s_hi = float(hi.sum())
            if s_lo == 0 or s_hi == 0:
                break
            m_lo = float((lo * bins[: t + 1]).sum() / s_lo)
            m_hi = float((hi * bins[t + 1 :]).sum() / s_hi)
            nt = int(round((m_lo + m_hi) * 0.5))
            if nt == t:
                break
            t = nt
        return int(np.clip(t, 1, 254))

    if m == "triangle":
        nz = np.nonzero(h > 0)[0]
        if nz.size < 2:
            return 128
        first, last = int(nz[0]), int(nz[-1])
        peak = int(np.argmax(h))
        flip = (peak - first) < (last - peak)
        start, end = (peak, last) if flip else (first, peak)
        if end <= start:
            return int(np.clip(peak, 1, 254))
        x1, y1 = float(start), float(h[start])
        x2, y2 = float(end), float(h[end])
        dx, dy = x2 - x1, y2 - y1
        denom = math.hypot(dx, dy) or 1.0
        best_t = peak
        best_dist = -1.0
        for b in range(start, end + 1):
            dist = abs(dy * b - dx * float(h[b]) + x2 * y1 - y2 * x1) / denom
            if dist > best_dist:
                best_dist = dist
                best_t = b
        return int(np.clip(best_t, 1, 254))

    if m == "li":
        mean_all = max(float((h * bins).sum() / total), 1e-6)
        best_t = 128
        min_entropy = float("inf")
        w_b = 0.0
        sum_b = 0.0
        sum_all = float((h * bins).sum())
        for t in range(1, 254):
            w_b += float(h[t])
            sum_b += float(h[t]) * t
            w_f = total - w_b
            if w_b <= 0 or w_f <= 0:
                continue
            mu_b = max(sum_b / w_b, 1e-6)
            mu_f = max((sum_all - sum_b) / w_f, 1e-6)
            entropy = (
                -sum_b * math.log(mu_b / mean_all)
                - (sum_all - sum_b) * math.log(mu_f / mean_all)
            )
            if entropy < min_entropy:
                min_entropy = entropy
                best_t = t
        return int(np.clip(best_t, 1, 254))

    if m == "huang":
        nz = np.nonzero(h > 0)[0]
        if nz.size < 2:
            return 128
        first, last = int(nz[0]), int(nz[-1])
        c_val = float(max(last - first, 1))
        w_cum = np.cumsum(h)
        s_cum = np.cumsum(h * bins)
        best_t = 128
        min_ent = float("inf")
        for t in range(first, last):
            wb = float(w_cum[t])
            wf = total - wb
            if wb <= 0 or wf <= 0:
                continue
            mu_b = float(s_cum[t]) / wb
            mu_f = float(s_cum[-1] - s_cum[t]) / wf
            ent = 0.0
            for i in range(first, last + 1):
                if h[i] <= 0:
                    continue
                mu = 1.0 / (1.0 + abs(i - (mu_b if i <= t else mu_f)) / c_val)
                if 1e-6 < mu < 1.0 - 1e-6:
                    ent += float(h[i]) * (-mu * math.log(mu) - (1.0 - mu) * math.log(1.0 - mu))
            if ent < min_ent:
                min_ent = ent
                best_t = t
        return int(np.clip(best_t, 1, 254))

    if m == "moments":
        p = h / total
        m1 = float((p * bins).sum())
        m2 = float((p * (bins**2)).sum())
        m3 = float((p * (bins**3)).sum())
        cd = m2 - m1 * m1
        if abs(cd) > 1e-6:
            c0 = (m1 * m3 - m2 * m2) / cd
            c1 = (m1 * m2 - m3) / cd
            disc = max(0.0, c1 * c1 - 4.0 * c0)
            z0 = 0.5 * (-c1 - math.sqrt(disc))
            z1 = 0.5 * (-c1 + math.sqrt(disc))
            pd = z1 - z0
            if abs(pd) > 1e-6:
                p0 = (z1 - m1) / pd
                target = float(np.clip(p0, 0.05, 0.95))
                cum = np.cumsum(p)
                idx = int(np.searchsorted(cum, target))
                return int(np.clip(idx, 1, 254))

    # Default: Otsu between-class variance maximization
    w_b = 0.0
    sum_b = 0.0
    sum_all = float((h * bins).sum())
    best_var = -1.0
    best_t = 128
    for t in range(256):
        w_b += float(h[t])
        if w_b <= 0:
            continue
        w_f = total - w_b
        if w_f <= 0:
            break
        sum_b += float(t) * float(h[t])
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        var_between = w_b * w_f * (m_b - m_f) * (m_b - m_f)
        if var_between > best_var:
            best_var = var_between
            best_t = t
    return int(np.clip(best_t, 1, 254))


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    """Fill interior holes in a 2D boolean mask via border flood-fill."""
    h, w = mask.shape
    ext_bg = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        if not mask[0, x] and not ext_bg[0, x]:
            ext_bg[0, x] = True
            q.append((0, x))
        if not mask[h - 1, x] and not ext_bg[h - 1, x]:
            ext_bg[h - 1, x] = True
            q.append((h - 1, x))
    for y in range(h):
        if not mask[y, 0] and not ext_bg[y, 0]:
            ext_bg[y, 0] = True
            q.append((y, 0))
        if not mask[y, w - 1] and not ext_bg[y, w - 1]:
            ext_bg[y, w - 1] = True
            q.append((y, w - 1))
    while q:
        cy, cx = q.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < h and 0 <= nx < w and not ext_bg[ny, nx] and not mask[ny, nx]:
                ext_bg[ny, nx] = True
                q.append((ny, nx))
    return ~ext_bg


def _convex_hull_area(points_xy: list[tuple[int, int]]) -> float:
    """Monotone chain convex hull + shoelace area."""
    pts = sorted(set(points_xy))
    if len(pts) < 3:
        return float(len(pts))

    def cross(o: tuple[int, int], a: tuple[int, int], b: tuple[int, int]) -> int:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[int, int]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[int, int]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    area2 = 0.0
    perim = 0.0
    n = len(hull)
    for i in range(n):
        x0, y0 = hull[i]
        x1, y1 = hull[(i + 1) % n]
        area2 += x0 * y1 - x1 * y0
        perim += math.hypot(x1 - x0, y1 - y0)
    # Include boundary pixel thickness so discrete lattice convex hull >= pixel count for convex blobs
    return abs(area2) * 0.5 + perim * 0.5 + 1.0


def _chamfer_distance(submask: np.ndarray) -> np.ndarray:
    """Two-pass 3-4 Chamfer distance transform inside a boolean submask."""
    h, w = submask.shape
    dist = np.where(submask, 1e6, 0.0).astype(np.float32)
    for y in range(h):
        for x in range(w):
            if not submask[y, x]:
                continue
            best = dist[y, x]
            if y > 0:
                best = min(best, dist[y - 1, x] + 1.0)
                if x > 0:
                    best = min(best, dist[y - 1, x - 1] + 1.4142)
                if x + 1 < w:
                    best = min(best, dist[y - 1, x + 1] + 1.4142)
            if x > 0:
                best = min(best, dist[y, x - 1] + 1.0)
            dist[y, x] = best
    for y in range(h - 1, -1, -1):
        for x in range(w - 1, -1, -1):
            if not submask[y, x]:
                continue
            best = dist[y, x]
            if y + 1 < h:
                best = min(best, dist[y + 1, x] + 1.0)
                if x + 1 < w:
                    best = min(best, dist[y + 1, x + 1] + 1.4142)
                if x > 0:
                    best = min(best, dist[y + 1, x - 1] + 1.4142)
            if x + 1 < w:
                best = min(best, dist[y, x + 1] + 1.0)
            dist[y, x] = best
    return dist


def _split_touching_component(
    coords_yx: list[tuple[int, int]],
    y0: int,
    x0: int,
    y1: int,
    x1: int,
    min_radius_px: float,
) -> list[list[tuple[int, int]]]:
    """Distance-transform watershed splitting for concave touching nuclei (Solidity < wsSolidity)."""
    sh = y1 - y0 + 3
    sw = x1 - x0 + 3
    sub = np.zeros((sh, sw), dtype=bool)
    for py, px in coords_yx:
        sub[py - y0 + 1, px - x0 + 1] = True
    dist = _chamfer_distance(sub)
    smooth = _gaussian_blur_2d(dist, 1.2)
    min_sep = max(5.0, min_radius_px * 1.15)
    candidates: list[tuple[float, int, int]] = []
    for sy in range(1, sh - 1):
        for sx in range(1, sw - 1):
            if not sub[sy, sx]:
                continue
            val = float(smooth[sy, sx])
            if val < max(2.5, min_radius_px * 0.45):
                continue
            patch = smooth[max(0, sy - 2) : min(sh, sy + 3), max(0, sx - 2) : min(sw, sx + 3)]
            if val >= float(patch.max()) - 1e-5:
                candidates.append((val, sy, sx))
    candidates.sort(reverse=True)
    peaks: list[tuple[int, int, float]] = []
    for val, sy, sx in candidates:
        if all(math.hypot(sy - py, sx - px) >= min_sep for py, px, _ in peaks):
            peaks.append((sy, sx, val))
            if len(peaks) >= 8:
                break
    if len(peaks) < 2:
        return [coords_yx]
    groups: list[list[tuple[int, int]]] = [[] for _ in peaks]
    for py, px in coords_yx:
        sy = py - y0 + 1
        sx = px - x0 + 1
        best_idx = 0
        best_score = float("inf")
        for idx, (pky, pkx, pk_val) in enumerate(peaks):
            # Weight by peak radius so unequally sized touching nuclei split at their neck
            d = math.hypot(sy - pky, sx - pkx) / max(pk_val, 1.0)
            if d < best_score:
                best_score = d
                best_idx = idx
        groups[best_idx].append((py, px))
    valid = [g for g in groups if len(g) >= 8]
    return valid if len(valid) >= 2 else [coords_yx]


def segment_nuclei(
    planes: list[np.ndarray],
    channels: list[dict[str, Any]],
    um_per_px: float = 0.0,
    params: NucleusParams | None = None,
) -> dict[str, Any]:
    """Port of Foci_Counter.groovy's segmentNuclei pipeline."""
    cfg = params or NucleusParams()
    if not planes:
        return {"channel_index": 0, "nuclei": [], "recommended_center": None}

    ch_idx = identify_nucleus_channel(channels, cfg.channel_index)
    plane = np.asarray(planes[min(max(ch_idx, 0), len(planes) - 1)], dtype=np.float32)
    h, w = plane.shape[-2], plane.shape[-1]

    # Downsample for fast segmentation if image is very large (> 1024px)
    max_seg_edge = 768
    ds = max(1, int(math.ceil(max(h, w) / max_seg_edge)))
    work = plane[::ds, ::ds] if ds > 1 else plane
    wh, ww = work.shape

    ps_raw = float(um_per_px) if um_per_px and um_per_px > 0 else 0.25
    ps = ps_raw * ds

    sigma = float(cfg.smooth_um) / max(ps, 1e-4)
    blurred = _gaussian_blur_2d(work, sigma) if sigma > 0.3 else work.copy()

    mn = float(blurred.min()) if blurred.size else 0.0
    mx = float(blurred.max()) if blurred.size else 1.0
    if mx <= mn:
        return {"channel_index": ch_idx, "nuclei": [], "recommended_center": {"x": w // 2, "y": h // 2}}

    scale = 255.0 / (mx - mn)
    bins = np.clip(((blurred - mn) * scale).astype(np.int32), 0, 255)
    hist = np.bincount(bins.ravel(), minlength=256)
    t_bin = _auto_threshold_256(hist, cfg.threshold_method)
    thr = mn + (t_bin + 0.5) / scale

    mask = _fill_holes(blurred > thr)

    # Connected components (8-connectivity)
    visited = np.zeros((wh, ww), dtype=bool)
    raw_components: list[list[tuple[int, int]]] = []
    for y in range(wh):
        for x in range(ww):
            if not mask[y, x] or visited[y, x]:
                continue
            comp: list[tuple[int, int]] = []
            q: deque[tuple[int, int]] = deque([(y, x)])
            visited[y, x] = True
            while q:
                cy, cx = q.popleft()
                comp.append((cy, cx))
                for ny in (cy - 1, cy, cy + 1):
                    if ny < 0 or ny >= wh:
                        continue
                    for nx in (cx - 1, cx, cx + 1):
                        if 0 <= nx < ww and not visited[ny, nx] and mask[ny, nx]:
                            visited[ny, nx] = True
                            q.append((ny, nx))
            if len(comp) >= 6:
                raw_components.append(comp)

    if um_per_px and um_per_px > 0:
        min_area_px = max(6.0, float(cfg.min_area_um2) / (ps * ps))
        max_area_px = max(min_area_px * 2.0, float(cfg.max_area_um2) / (ps * ps))
    else:
        img_area = float(wh * ww)
        min_area_px = max(12.0, img_area * 0.0004)
        max_area_px = max(min_area_px * 4.0, img_area * 0.55)

    min_radius_px = math.sqrt(max(min_area_px, 9.0) / math.pi)

    # Solidity-guarded Watershed (only split concave touching nuclei with solidity < ws_solidity)
    final_components: list[list[tuple[int, int]]] = []
    for comp in raw_components:
        if len(comp) < min_area_px * 0.4:
            continue
        ys = [p[0] for p in comp]
        xs = [p[1] for p in comp]
        y0, y1 = min(ys), max(ys)
        x0, x1 = min(xs), max(xs)
        # Boundary pixels for convex hull
        comp_set = set(comp)
        boundary_xy = [
            (px, py)
            for py, px in comp
            if (py - 1, px) not in comp_set
            or (py + 1, px) not in comp_set
            or (py, px - 1) not in comp_set
            or (py, px + 1) not in comp_set
        ]
        hull_area = _convex_hull_area(boundary_xy or [(px, py) for py, px in comp])
        solidity = min(1.0, len(comp) / max(hull_area, 1.0))
        if cfg.watershed and solidity < float(cfg.ws_solidity) and len(comp) >= min_area_px * 1.3:
            split_comps = _split_touching_component(comp, y0, x0, y1, x1, min_radius_px)
            final_components.extend(split_comps)
        else:
            final_components.append(comp)

    candidates: list[dict[str, Any]] = []
    img_cx, img_cy = w * 0.5, h * 0.5
    max_dist = math.hypot(img_cx, img_cy) or 1.0

    for comp in final_components:
        area_px = len(comp)
        if area_px < min_area_px or area_px > max_area_px:
            continue
        comp_set = set(comp)
        ys = [p[0] for p in comp]
        xs = [p[1] for p in comp]
        y0, y1 = min(ys), max(ys)
        x0, x1 = min(xs), max(xs)
        touches_edge = x0 <= 0 or y0 <= 0 or x1 >= ww - 1 or y1 >= wh - 1

        boundary_pts: list[tuple[int, int]] = []
        exposed_edges = 0
        for py, px in comp:
            n_out = 0
            if (py - 1, px) not in comp_set:
                n_out += 1
            if (py + 1, px) not in comp_set:
                n_out += 1
            if (py, px - 1) not in comp_set:
                n_out += 1
            if (py, px + 1) not in comp_set:
                n_out += 1
            if n_out > 0:
                boundary_pts.append((px, py))
                exposed_edges += n_out

        # Convert staircase boundary count to smooth Euclidean perimeter approximation
        perim = max(float(exposed_edges) * 0.785, 1.0)
        circularity = min(1.0, (4.0 * math.pi * float(area_px)) / (perim * perim))
        if circularity < float(cfg.min_circularity):
            continue

        hull_area = _convex_hull_area(boundary_pts)
        solidity = min(1.0, float(area_px) / max(hull_area, 1.0))

        mean_x = (sum(xs) / area_px + 0.5) * ds
        mean_y = (sum(ys) / area_px + 0.5) * ds
        intensities = [float(work[py, px]) for py, px in comp]
        mean_int = float(sum(intensities) / max(len(intensities), 1))
        sum_int = float(sum(intensities) * (ds * ds))
        area_um2 = float(area_px * (ps * ps))

        # Order boundary contour by angle around centroid and subsample to <= 36 points
        cx_w = sum(xs) / area_px
        cy_w = sum(ys) / area_px
        sorted_b = sorted(boundary_pts, key=lambda pt: math.atan2(pt[1] - cy_w, pt[0] - cx_w))
        step = max(1, len(sorted_b) // 36)
        contour = [[round((bx + 0.5) * ds, 1), round((by + 0.5) * ds, 1)] for bx, by in sorted_b[::step]]

        dist_center = math.hypot(mean_x - img_cx, mean_y - img_cy) / max_dist
        score = (1.0 - 0.45 * dist_center) * (0.5 + 0.5 * circularity) * math.sqrt(max(mean_int - mn, 1.0))

        candidates.append(
            {
                "cx": round(mean_x, 1),
                "cy": round(mean_y, 1),
                "area_px": int(area_px * ds * ds),
                "area_um2": round(area_um2, 2),
                "circularity": round(circularity, 3),
                "solidity": round(solidity, 3),
                "mean_intensity": round(mean_int, 2),
                "sum_intensity": round(sum_int, 1),
                "touches_edge": bool(touches_edge),
                "bounds": {
                    "x": int(x0 * ds),
                    "y": int(y0 * ds),
                    "w": int(max(2, (x1 - x0 + 1) * ds)),
                    "h": int(max(2, (y1 - y0 + 1) * ds)),
                },
                "contour": contour,
                "_score": score,
            }
        )

    if cfg.exclude_edges:
        interior = [c for c in candidates if not c["touches_edge"]]
        if interior:
            candidates = interior

    candidates.sort(key=lambda item: float(item.get("_score", 0.0)), reverse=True)
    nuclei: list[dict[str, Any]] = []
    for idx, item in enumerate(candidates, start=1):
        clean = {k: v for k, v in item.items() if not k.startswith("_")}
        clean["id"] = idx
        nuclei.append(clean)

    best = nuclei[0] if nuclei else None
    return {
        "channel_index": ch_idx,
        "threshold": round(float(thr), 2),
        "nuclei": nuclei,
        "recommended_center": {"x": round(best["cx"]), "y": round(best["cy"])}
        if best
        else {"x": w // 2, "y": h // 2},
    }
