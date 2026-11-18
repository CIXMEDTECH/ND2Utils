"""Background preparation of imported ND2 and OME-TIFF files.

Right after import every file is queued here. A worker reads its first plane once and stores,
under cache/<file id>/:

- display_0_0_0.bin.gz  8-bit, auto-contrasted channels (what the workspace preview shows),
                        reduced to at most DISPLAY_EDGE pixels on the long side
- autoscale_0_0_0.json  per-channel auto-contrast limits (from the full-resolution plane)

When a file is ready its record gets `prepared_at`, the version of these cache files. Browsers key
their local copies of the preview by it, so a rebuild (see `rebuild`) replaces them everywhere.

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
import math
import shutil
import time
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
# The workspace preview is drawn at most this large, so the display data never needs more pixels.
DISPLAY_EDGE = 2048

_GUARD = Lock()
_FILE_LOCKS: dict[str, RLock] = {}
_QUEUED: dict[str, Future] = {}
# Files whose cache was rebuilt while a worker was already preparing them: run them once more.
_AGAIN: set[str] = set()
_EXECUTOR: ThreadPoolExecutor | None = None
# One extra worker for files someone is waiting for (opened while still queued).
_URGENT: ThreadPoolExecutor | None = None
_WORKERS = 2


class Pending(Exception):
    """The preview is not ready yet; it has been moved to the front of the queue."""


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


def _urgent() -> ThreadPoolExecutor:
    global _URGENT
    if _URGENT is None:  # caller holds _GUARD
        _URGENT = ThreadPoolExecutor(max_workers=1, thread_name_prefix="nd2-prepare-urgent")
    return _URGENT


def shutdown() -> None:
    global _EXECUTOR, _URGENT
    with _GUARD:
        executors = [_EXECUTOR, _URGENT]
        _EXECUTOR = _URGENT = None
        _QUEUED.clear()
        _AGAIN.clear()
    for executor in executors:
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
        min_pct = float(meta.get("min_pct") if meta.get("min_pct") is not None else 0.0)
        max_pct = float(meta.get("max_pct") if meta.get("max_pct") is not None else 100.0)
        span = max(hi - lo, 1.0)
        eff_min = lo + (min_pct / 100.0) * span
        eff_max = max(eff_min + 1e-3, lo + (max_pct / 100.0) * span)
        out.append(
            {
                "index": i,
                "name": meta.get("name"),
                "min": eff_min,
                "max": eff_max,
                "raw_min": lo,
                "raw_max": hi,
                "gamma": float(meta.get("lut_gamma") or 1.0),
                "brightness": float(meta.get("brightness") if meta.get("brightness") is not None else 1.0),
                "min_pct": min_pct,
                "max_pct": max_pct,
                "color": meta.get("color"),
            }
        )
    return out


def _shrink(plane: np.ndarray, edge: int = DISPLAY_EDGE) -> np.ndarray:
    """Block-average a plane until its long side is at most `edge` (a few edge pixels may drop)."""
    if plane.ndim != 2:
        return plane
    h, w = plane.shape
    f = math.ceil(max(h, w) / edge)
    if f <= 1:
        return plane
    hh, ww = h // f * f, w // f * f
    return np.asarray(plane[:hh, :ww]).reshape(hh // f, f, ww // f, f).mean(axis=(1, 3), dtype=np.float32)


def _display_bytes(planes: list[np.ndarray], channels: list[dict[str, Any]], limits: list[dict[str, Any]]) -> bytes:
    mapped = []
    for plane, lim in zip(planes, limits):
        span = max(lim["max"] - lim["min"], 1e-6)
        y = np.clip((np.asarray(_shrink(plane), dtype=np.float32) - lim["min"]) / span, 0.0, 1.0)
        gamma = lim["gamma"] if lim["gamma"] > 0 else 1.0
        if abs(gamma - 1.0) > 1e-6:
            y = np.power(y, 1.0 / gamma)
        brightness = float(lim.get("brightness") if lim.get("brightness") is not None else 1.0)
        if abs(brightness - 1.0) > 1e-6:
            y = np.clip(y * max(0.0, brightness), 0.0, 1.0)
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
    return rec.get("format") in ("ome-tiff", "tiff") and not rec.get("cropped")


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


def get(
    file_id: str,
    rec: dict[str, Any],
    source: Path,
    kind: str,
    coords: tuple[int, int, int],
    *,
    wait: bool = True,
) -> Any:
    """Gzip bytes for 'display'/'plane', a dict for 'autoscale'.

    With `wait=False` an unprepared file raises Pending (after moving it to the front of
    the queue) instead of building it on the calling request thread."""
    if kind == "plane":
        return raw_plane(rec, source, coords)
    if coords != DEFAULT:
        return _build_any(rec, file_id, source, coords)[kind]
    try:
        return _read(file_id, kind)
    except (OSError, json.JSONDecodeError):
        pass
    if not wait:
        prioritize(file_id)
        raise Pending(file_id)
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
        rec = store.index_get(file_id)
        if not rec:
            return
        owner = rec.get(store.OWNER_FIELD) or ""
        built = False
        if not is_prepared(file_id):
            source = settings.uploads_dir / file_id / "source.nd2"
            with _file_lock(file_id):
                if not is_prepared(file_id):
                    if is_slide(rec):
                        _store(file_id, _build_any(rec, file_id, source, DEFAULT))
                    else:
                        with open_uncached(source) as handle:
                            _store(file_id, _build(rec, handle, DEFAULT))
                    built = True
        current = store.index_get(file_id)
        if current is None:
            # Deleted while we were working.
            shutil.rmtree(settings.cache_dir / file_id, ignore_errors=True)
            return
        if built or current.get("prepare") != "ready" or not current.get("prepared_at"):
            # prepared_at versions the browsers' cached previews: bump it only when the
            # cache really changed (not when a moved/transferred file is re-checked).
            store.update_file(file_id, owner, {"prepare": "ready", "prepared_at": round(time.time(), 3)})
    except Exception:
        log.exception("Preparing %s failed", file_id)
        rec = store.index_get(file_id)
        if rec:
            store.update_file(file_id, rec.get(store.OWNER_FIELD) or "", {"prepare": "error"})
    finally:
        with _GUARD:
            _QUEUED.pop(file_id, None)
            again = file_id in _AGAIN
            _AGAIN.discard(file_id)
        if again:
            schedule(file_id)


def prioritize(file_id: str) -> None:
    """Someone is waiting for this file: prepare it next, ahead of the import backlog."""
    with _GUARD:
        future = _QUEUED.get(file_id)
        if future is not None:
            if future.running() or future.done() or not future.cancel():
                return  # being prepared right now (or just finished)
        _QUEUED[file_id] = _urgent().submit(_run, file_id)


def schedule(file_id: str, *, again: bool = False) -> None:
    """Queue `file_id`; with `again`, a file that is being prepared right now runs once more."""
    executor = _executor()
    with _GUARD:
        if file_id in _QUEUED:
            if again:
                _AGAIN.add(file_id)
            return
        _QUEUED[file_id] = executor.submit(_run, file_id)


def rebuild(file_ids: list[str]) -> int:
    """Drop the prepared previews of these files and prepare them again in the background.

    Slide pyramid levels are kept: they are derived from the unchanged source and written
    atomically, and rebuilding them can take minutes. Returns the number of files queued."""
    from nd2utils import slide_render, store

    index = dict(store.index_items())
    ids = [file_id for file_id in dict.fromkeys(file_ids) if file_id in index]
    for file_id in ids:
        with _file_lock(file_id):
            for kind in _KINDS:
                _path(file_id, kind).unlink(missing_ok=True)
        slide_render.forget(file_id)
    store.patch_files({file_id: {"prepare": "pending"} for file_id in ids})
    for file_id in ids:
        schedule(file_id, again=True)
    return len(ids)


def schedule_missing() -> int:
    """Queue every file that is not prepared yet (e.g. imported by an older version)."""
    from nd2utils import store

    count = 0
    stamps: dict[str, dict[str, Any]] = {}
    for file_id, rec in store.index_items():
        if rec.get("prepare") != "ready" or not is_prepared(file_id):
            schedule(file_id)
            count += 1
        elif not rec.get("prepared_at"):
            # Prepared by a version without cache versions: the files' age is the version.
            stamps[file_id] = {"prepared_at": round(_path(file_id, "display").stat().st_mtime, 3)}
    if stamps:
        store.patch_files(stamps)
    return count


def wait_idle(timeout: float = 60) -> None:
    with _GUARD:
        pending = list(_QUEUED.values())
    if pending:
        wait(pending, timeout=timeout)
