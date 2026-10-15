"""Background preparation of imported ND2 and OME-TIFF files.

Right after import every file is queued here. A worker reads its first plane once and stores,
under cache/<file id>/:

- display_0_0_0.bin.gz  8-bit, auto-contrasted channels (what the workspace preview shows)
- autoscale_0_0_0.json  per-channel auto-contrast limits

Opening a file afterwards only streams a small pre-compressed blob instead of reading the ND2,
sending megabytes of raw 16-bit data and auto-contrasting it in the browser.
For (OME-)TIFF slides the preview comes from a coarse pyramid level, and large images without a
pyramid get one first (see ometiff.build_pyramid), so the slide viewer can open them right away.

Raw planes (detailed view) and other T/Z/P positions are read on demand and sent gzip-compressed;
they are not stored, which would roughly duplicate the ND2 data on disk.
"""

from __future__ import annotations

import gzip
import json
import logging
import shutil
from concurrent.futures import Future, ThreadPoolExecutor, wait
from pathlib import Path
from threading import Lock, RLock
from typing import Any

import numpy as np

from nd2utils import ometiff
from nd2utils.config import settings
from nd2utils.nd2io import OpenNd2, extract_channels, open_nd2, open_uncached, pack_planes
from nd2utils.render import autoscale_limits

log = logging.getLogger("nd2utils.prepare")

DEFAULT = (0, 0, 0)
_KINDS = ("display", "autoscale")

_GUARD = Lock()
_FILE_LOCKS: dict[str, RLock] = {}
_QUEUED: dict[str, Future] = {}
_EXECUTOR: ThreadPoolExecutor | None = None
_WORKERS = 2


def _executor() -> ThreadPoolExecutor:
    global _EXECUTOR
    with _GUARD:
        if _EXECUTOR is None:
            _EXECUTOR = ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix="nd2-prepare")
        return _EXECUTOR


def set_workers(count: int) -> None:
    """New pool size (performance settings). Work already queued finishes on the old pool."""
    global _EXECUTOR, _WORKERS
    with _GUARD:
        count = max(1, int(count))
        if count == _WORKERS:
            return
        _WORKERS = count
        old, _EXECUTOR = _EXECUTOR, None
    if old:
        old.shutdown(wait=False)


def shutdown() -> None:
    global _EXECUTOR
    with _GUARD:
        executor, _EXECUTOR = _EXECUTOR, None
        _QUEUED.clear()
    if executor:
        executor.shutdown(wait=False, cancel_futures=True)


def _file_lock(file_id: str) -> RLock:
    with _GUARD:
        return _FILE_LOCKS.setdefault(file_id, RLock())


def _path(file_id: str, kind: str, coords: tuple[int, int, int] = DEFAULT) -> Path:
    t, z, p = coords
    ext = "json" if kind == "autoscale" else "bin.gz"
    return settings.cache_dir / file_id / f"{kind}_{t}_{z}_{p}.{ext}"


def is_prepared(file_id: str) -> bool:
    return all(_path(file_id, kind).is_file() for kind in _KINDS)


# --- building ---------------------------------------------------------------


def _limits(planes: list[np.ndarray], channels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for i, plane in enumerate(planes):
        meta = channels[i] if i < len(channels) else {}
        lo, hi = autoscale_limits(plane)
        file_max = meta.get("lut_max")
        if file_max:
            # Same rule as the viewer: the stored LUT is often on a 16-bit scale for 12-bit data.
            hi = max(min(hi, float(file_max)), lo + 1.0)
        out.append(
            {
                "index": i,
                "name": meta.get("name"),
                "min": lo,
                "max": hi,
                "gamma": float(meta.get("lut_gamma") or 1.0),
                "color": meta.get("color"),
            }
        )
    return out


def _display_bytes(planes: list[np.ndarray], channels: list[dict[str, Any]], limits: list[dict[str, Any]]) -> bytes:
    mapped = []
    for plane, lim in zip(planes, limits):
        span = max(lim["max"] - lim["min"], 1e-6)
        y = np.clip((np.asarray(plane, dtype=np.float32) - lim["min"]) / span, 0.0, 1.0)
        gamma = lim["gamma"] if lim["gamma"] > 0 else 1.0
        if abs(gamma - 1.0) > 1e-6:
            y = np.power(y, 1.0 / gamma)
        mapped.append((y * 255.0 + 0.5).astype(np.uint8))
    # Already contrast-mapped: the viewer displays 0..255 linearly.
    meta = [{**(channels[i] if i < len(channels) else {}), "suggested_min": 0, "suggested_max": 255} for i in range(len(mapped))]
    return pack_planes(mapped, meta)


def _build(rec: dict[str, Any], handle: OpenNd2, coords: tuple[int, int, int]) -> dict[str, Any]:
    t, z, p = coords
    planes, _ = extract_channels(handle, t=t, z=z, p=p)
    channels = rec.get("channels") or []
    limits = _limits(planes, channels)
    return {
        "display": gzip.compress(_display_bytes(planes, channels, limits), compresslevel=6),
        "autoscale": {"channels": limits},
    }


def is_slide(rec: dict[str, Any]) -> bool:
    return rec.get("format") in ("ome-tiff", "tiff")


def ensure_slide(file_id: str, source: Path) -> ometiff.Slide:
    """The slide handle, with virtual pyramid levels built first when the file lacks them."""
    slide = ometiff.open_slide(source, file_id)
    if not ometiff.needs_pyramid(slide):
        return slide
    with _file_lock(file_id):
        slide = ometiff.open_slide(source, file_id)
        if ometiff.needs_pyramid(slide) and not ometiff.pyramid_ready(file_id):
            ometiff.build_pyramid(source, file_id)
            slide = ometiff.open_slide(source, file_id)
    return slide


def _slide_limits(planes: list[np.ndarray], channels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Like _limits, but sparse channels (whole slides: mostly empty background) take their
    white point from the foreground, otherwise faint noise in a near-empty channel is blown up."""
    limits = _limits(planes, channels)
    for lim, plane in zip(limits, planes):
        fg = plane[plane > plane.min()]
        if 0 < fg.size < plane.size * 0.5:
            hi = float(np.percentile(fg, 99.9))
            lim["max"] = max(hi, lim["min"] + 1.0)
    return limits


def _build_slide(rec: dict[str, Any], slide: ometiff.Slide, coords: tuple[int, int, int]) -> dict[str, Any]:
    t, z, _ = coords
    planes = ometiff.overview_planes(slide, t=t, z=z)
    channels = rec.get("channels") or []
    limits = _slide_limits(planes, channels)
    return {
        "display": gzip.compress(_display_bytes(planes, channels, limits), compresslevel=6),
        "autoscale": {"channels": limits},
    }


def _build_any(rec: dict[str, Any], file_id: str, source: Path, coords: tuple[int, int, int]) -> dict[str, Any]:
    if is_slide(rec):
        return _build_slide(rec, ensure_slide(file_id, source), coords)
    return _build(rec, open_nd2(source), coords)


def raw_plane(rec: dict[str, Any], source: Path, coords: tuple[int, int, int]) -> bytes:
    """Raw channels (native bit depth) for the detailed view, gzip-compressed for transfer.

    Slides are far too large for one plane: they get their overview level instead."""
    t, z, p = coords
    if is_slide(rec):
        slide = ometiff.open_slide(source, rec.get("id"))
        planes = [ometiff.wire_dtype(plane) for plane in ometiff.overview_planes(slide, t=t, z=z)]
    else:
        planes, _ = extract_channels(open_nd2(source), t=t, z=z, p=p)
    return gzip.compress(pack_planes(planes, rec.get("channels") or []), compresslevel=1)


def _store(file_id: str, built: dict[str, Any]) -> None:
    folder = settings.cache_dir / file_id
    folder.mkdir(parents=True, exist_ok=True)
    for kind in _KINDS:
        path = _path(file_id, kind)
        tmp = path.with_name(path.name + ".tmp")
        if kind == "autoscale":
            tmp.write_text(json.dumps(built[kind]), encoding="utf-8")
        else:
            tmp.write_bytes(built[kind])
        tmp.replace(path)


def _read(file_id: str, kind: str) -> Any:
    path = _path(file_id, kind)
    if kind == "autoscale":
        return json.loads(path.read_text(encoding="utf-8"))
    return path.read_bytes()


def get(file_id: str, rec: dict[str, Any], source: Path, kind: str, coords: tuple[int, int, int]) -> Any:
    """Gzip bytes for 'display'/'plane', a dict for 'autoscale'."""
    if kind == "plane":
        return raw_plane(rec, source, coords)
    if coords != DEFAULT:
        return _build_any(rec, file_id, source, coords)[kind]
    try:
        return _read(file_id, kind)
    except (OSError, json.JSONDecodeError):
        pass
    # Not prepared yet (queued, or cache removed): build it now, once, and keep it.
    with _file_lock(file_id):
        if is_prepared(file_id):
            return _read(file_id, kind)
        built = _build_any(rec, file_id, source, DEFAULT)
        _store(file_id, built)
        return built[kind]


# --- queue ------------------------------------------------------------------


def _run(file_id: str) -> None:
    from nd2utils import store  # local import: store imports nd2io too

    try:
        rec = store.load_index().get(file_id)
        if not rec:
            return
        owner = rec.get(store.OWNER_FIELD) or ""
        if not is_prepared(file_id):
            source = settings.uploads_dir / file_id / "source.nd2"
            with _file_lock(file_id):
                if not is_prepared(file_id):
                    if is_slide(rec):
                        _store(file_id, _build_any(rec, file_id, source, DEFAULT))
                    else:
                        with open_uncached(source) as handle:
                            _store(file_id, _build(rec, handle, DEFAULT))
        if store.load_index().get(file_id) is None:
            # Deleted while we were working.
            shutil.rmtree(settings.cache_dir / file_id, ignore_errors=True)
            return
        store.update_file(file_id, owner, {"prepare": "ready"})
    except Exception:
        log.exception("Preparing %s failed", file_id)
        rec = store.load_index().get(file_id)
        if rec:
            store.update_file(file_id, rec.get(store.OWNER_FIELD) or "", {"prepare": "error"})
    finally:
        with _GUARD:
            _QUEUED.pop(file_id, None)


def schedule(file_id: str) -> None:
    executor = _executor()
    with _GUARD:
        if file_id in _QUEUED:
            return
        _QUEUED[file_id] = executor.submit(_run, file_id)


def schedule_missing() -> int:
    """Queue every file that is not prepared yet (e.g. imported by an older version)."""
    from nd2utils import store

    count = 0
    for file_id, rec in store.load_index().items():
        if rec.get("prepare") != "ready" or not is_prepared(file_id):
            schedule(file_id)
            count += 1
    return count


def wait_idle(timeout: float = 60) -> None:
    with _GUARD:
        pending = list(_QUEUED.values())
    if pending:
        wait(pending, timeout=timeout)
