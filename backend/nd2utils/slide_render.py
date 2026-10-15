"""Server-side rendering of slide tiles (render mode "server").

Instead of sending native channel values for the browser to composite, the server maps each
visible channel through its LUT (color, black / white point, gamma), adds them up and sends
one JPEG per tile. This moves the work off weak client machines (no GPU, old laptops, tablets)
at the cost of a new request whenever the display settings change.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from io import BytesIO
from threading import Lock

import numpy as np
from PIL import Image

from nd2utils.ometiff import Slide, SlideError, read_region, TILE


@dataclass(frozen=True)
class Layer:
    channel: int
    vmin: float
    vmax: float
    gamma: float
    color: tuple[int, int, int]


def parse_layers(raw: str, n_channels: int) -> list[Layer]:
    """`c,min,max,gamma,rrggbb;...` -> layers. Raises ValueError on malformed input."""
    layers = []
    for part in (p for p in raw.split(";") if p.strip()):
        c, lo, hi, gamma, color = part.split(",")
        channel = int(c)
        if not 0 <= channel < n_channels:
            raise ValueError("channel out of range")
        rgb = int(color, 16)
        layers.append(
            Layer(
                channel=channel,
                vmin=float(lo),
                vmax=float(hi),
                gamma=float(gamma) if float(gamma) > 0 else 1.0,
                color=((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255),
            )
        )
    if len(layers) > 64:
        raise ValueError("too many layers")
    return layers


# --- lookup tables ------------------------------------------------------------------

_TABLES: OrderedDict[tuple, np.ndarray] = OrderedDict()
_TABLE_LOCK = Lock()


def _table(layer: Layer, size: int) -> np.ndarray:
    """(size, 3) uint8: native value -> RGB contribution of this channel."""
    key = (layer.vmin, layer.vmax, layer.gamma, layer.color, size)
    with _TABLE_LOCK:
        hit = _TABLES.get(key)
        if hit is not None:
            _TABLES.move_to_end(key)
            return hit
    values = np.arange(size, dtype=np.float32)
    y = np.clip((values - layer.vmin) / max(layer.vmax - layer.vmin, 1e-6), 0.0, 1.0)
    if abs(layer.gamma - 1.0) > 1e-6:
        y = np.power(y, 1.0 / layer.gamma)
    table = (y[:, None] * np.asarray(layer.color, dtype=np.float32)[None, :] + 0.5).astype(np.uint8)
    with _TABLE_LOCK:
        _TABLES[key] = table
        while len(_TABLES) > 64:
            _TABLES.popitem(last=False)
    return table


def composite(planes: list[np.ndarray], layers: list[Layer]) -> np.ndarray:
    h, w = planes[0].shape if planes else (TILE, TILE)
    acc = np.zeros((h, w, 3), dtype=np.uint16)
    for plane, layer in zip(planes, layers):
        if plane.dtype in (np.uint8, np.uint16):
            acc += _table(layer, 256 if plane.dtype == np.uint8 else 65536)[plane]
        else:
            y = np.clip((plane.astype(np.float32) - layer.vmin) / max(layer.vmax - layer.vmin, 1e-6), 0.0, 1.0)
            if abs(layer.gamma - 1.0) > 1e-6:
                y = np.power(y, 1.0 / layer.gamma)
            acc += (y[..., None] * np.asarray(layer.color, dtype=np.float32) + 0.5).astype(np.uint16)
    np.minimum(acc, 255, out=acc)
    return acc.astype(np.uint8)


# --- rendered tile cache ------------------------------------------------------------

_CACHE: OrderedDict[tuple, bytes] = OrderedDict()
_CACHE_BYTES = 0
_CACHE_LIMIT = 256 * 1024 * 1024
_CACHE_LOCK = Lock()


def set_cache_limit(limit: int) -> None:
    global _CACHE_LIMIT, _CACHE_BYTES
    with _CACHE_LOCK:
        _CACHE_LIMIT = max(0, int(limit))
        while _CACHE_BYTES > _CACHE_LIMIT and _CACHE:
            _, old = _CACHE.popitem(last=False)
            _CACHE_BYTES -= len(old)


def cache_bytes() -> int:
    return _CACHE_BYTES


def forget(file_id: str) -> None:
    global _CACHE_BYTES
    with _CACHE_LOCK:
        for key in [k for k in _CACHE if k[0] == file_id]:
            _CACHE_BYTES -= len(_CACHE.pop(key))


def render_tile(
    file_id: str,
    slide: Slide,
    level: int,
    tx: int,
    ty: int,
    layers: list[Layer],
    t: int = 0,
    z: int = 0,
    quality: int = 85,
) -> bytes:
    """JPEG of one viewer tile, composited from `layers`."""
    global _CACHE_BYTES
    key = (file_id, level, tx, ty, t, z, tuple(layers), quality)
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit
    lv = slide.levels[level]
    x, y = tx * TILE, ty * TILE
    w, h = min(TILE, lv.width - x), min(TILE, lv.height - y)
    if w <= 0 or h <= 0:
        raise SlideError("Tile outside the image.", "bad_tile")
    planes = [read_region(slide, level, layer.channel, x, y, w, h, t=t, z=z) for layer in layers]
    rgb = composite(planes, layers) if layers else np.zeros((h, w, 3), dtype=np.uint8)
    buf = BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buf, format="JPEG", quality=int(quality), subsampling=0)
    body = buf.getvalue()
    with _CACHE_LOCK:
        if len(body) <= _CACHE_LIMIT:
            _CACHE[key] = body
            _CACHE_BYTES += len(body)
            while _CACHE_BYTES > _CACHE_LIMIT and _CACHE:
                _, old = _CACHE.popitem(last=False)
                _CACHE_BYTES -= len(old)
    return body
