"""Runtime performance settings, edited by administrators (Settings → Performance).

Stored in data/performance.json and applied immediately, without a restart:
caches are resized, the preparation pool is replaced for new work, and the export gate lets
more (or fewer) jobs run at once.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Condition, Lock, RLock
from typing import Any, Iterator

from nd2utils import jsoncache
from nd2utils.config import settings

RENDER_MODES = ("auto", "browser", "server")

# name -> (default, minimum, maximum)
_NUMBERS: dict[str, tuple[int, int, int]] = {
    "tile_cache_mb": (192, 32, 16384),
    "render_cache_mb": (256, 0, 16384),
    "server_tile_quality": (85, 50, 98),
    "max_open_files": (6, 2, 64),
    "prepare_workers": (2, 1, 32),
    "export_workers": (2, 1, 16),
    "raster_max_mpx": (64, 4, 1024),
    # Browsers keep previews in IndexedDB up to this size (per browser profile).
    "local_cache_mb": (2048, 64, 16384),
}
# name -> default
_SWITCHES: dict[str, bool] = {
    # Browsers keep downloaded previews locally, so browsing a folder again needs no network.
    "local_cache": True,
    # ...and download every prepared preview of the workspace in the background (new imports too).
    "local_cache_auto": True,
    # Non-admin users may rebuild caches from the file tree (administrators always can).
    "cache_rebuild_users": True,
}
DEFAULTS: dict[str, Any] = {
    "render_mode": "auto",
    **{name: spec[0] for name, spec in _NUMBERS.items()},
    **_SWITCHES,
}

_LOCK = RLock()


class PerfError(ValueError):
    pass


def _path():
    return settings.data_dir / "performance.json"


def schema() -> dict[str, Any]:
    out: dict[str, Any] = {"render_mode": {"type": "choice", "choices": list(RENDER_MODES), "default": DEFAULTS["render_mode"]}}
    for name, (default, lo, hi) in _NUMBERS.items():
        out[name] = {"type": "int", "min": lo, "max": hi, "default": default}
    for name, default in _SWITCHES.items():
        out[name] = {"type": "bool", "default": default}
    return out


def _clean(raw: dict[str, Any]) -> dict[str, Any]:
    out = dict(DEFAULTS)
    mode = raw.get("render_mode")
    if mode in RENDER_MODES:
        out["render_mode"] = mode
    for name, (_, lo, hi) in _NUMBERS.items():
        value = raw.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[name] = int(min(max(int(value), lo), hi))
    for name in _SWITCHES:
        if isinstance(raw.get(name), bool):
            out[name] = raw[name]
    return out


def get() -> dict[str, Any]:
    data = jsoncache.read(_path(), dict)
    return _clean(data if isinstance(data, dict) else {})


def value(name: str) -> Any:
    return get()[name]


def update(changes: dict[str, Any]) -> dict[str, Any]:
    """Validate and store `changes` (unknown keys and out-of-range numbers are refused)."""
    with _LOCK:
        current = get()
        for name, new in changes.items():
            if name == "render_mode":
                if new not in RENDER_MODES:
                    raise PerfError(f"render_mode must be one of {', '.join(RENDER_MODES)}.")
            elif name in _NUMBERS:
                _, lo, hi = _NUMBERS[name]
                if isinstance(new, bool) or not isinstance(new, (int, float)) or not lo <= new <= hi:
                    raise PerfError(f"{name} must be a number between {lo} and {hi}.")
                new = int(new)
            elif name in _SWITCHES:
                if not isinstance(new, bool):
                    raise PerfError(f"{name} must be true or false.")
            else:
                raise PerfError(f"Unknown setting {name!r}.")
            current[name] = new
        jsoncache.write(_path(), current)
    apply(current)
    return current


def reset() -> dict[str, Any]:
    with _LOCK:
        jsoncache.write(_path(), dict(DEFAULTS))
    apply(dict(DEFAULTS))
    return dict(DEFAULTS)


def apply(values: dict[str, Any] | None = None) -> None:
    """Push settings into the running modules."""
    from nd2utils import nd2io, ometiff, prepare, slide_render  # local: they import config only

    v = values or get()
    ometiff.set_limits(segment_bytes=v["tile_cache_mb"] * 1024 * 1024, max_open=v["max_open_files"])
    nd2io.set_max_open(v["max_open_files"])
    slide_render.set_cache_limit(v["render_cache_mb"] * 1024 * 1024)
    prepare.set_workers(v["prepare_workers"])
    _GATE.set_limit(v["export_workers"])


# --- export gate ------------------------------------------------------------------


class _Gate:
    """A semaphore whose size can change while jobs wait on it."""

    def __init__(self, limit: int):
        self._cond = Condition()
        self._limit = limit
        self.running = 0
        self.waiting = 0

    def set_limit(self, limit: int) -> None:
        with self._cond:
            self._limit = max(1, int(limit))
            self._cond.notify_all()

    @contextmanager
    def slot(self) -> Iterator[None]:
        with self._cond:
            self.waiting += 1
            try:
                while self.running >= self._limit:
                    self._cond.wait()
            finally:
                self.waiting -= 1
            self.running += 1
        try:
            yield
        finally:
            with self._cond:
                self.running -= 1
                self._cond.notify_all()


_GATE = _Gate(DEFAULTS["export_workers"])


_EXPORT_POOL: ThreadPoolExecutor | None = None
_EXPORT_POOL_GUARD = Lock()


def export_executor() -> ThreadPoolExecutor:
    """Threads for export jobs (queued ones wait on the gate here, not in the request pool)."""
    global _EXPORT_POOL
    with _EXPORT_POOL_GUARD:
        if _EXPORT_POOL is None:
            _EXPORT_POOL = ThreadPoolExecutor(max_workers=32, thread_name_prefix="export")
        return _EXPORT_POOL


def export_slot():
    """Hold this while an export job runs; extra jobs wait (status "queued")."""
    return _GATE.slot()


# --- status -----------------------------------------------------------------------


def _memory() -> tuple[int | None, int | None]:
    try:
        page = os.sysconf("SC_PAGE_SIZE")
        total = page * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None, None
    try:
        available = page * os.sysconf("SC_AVPHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        available = None
    return total, available


def status() -> dict[str, Any]:
    from nd2utils import ometiff, slide_render

    total, available = _memory()
    return {
        "cpu_count": os.cpu_count(),
        "memory_total": total,
        "memory_available": available,
        "tile_cache_bytes": ometiff.segment_cache_bytes(),
        "render_cache_bytes": slide_render.cache_bytes(),
        "open_slides": ometiff.open_count(),
        "exports_running": _GATE.running,
        "exports_waiting": _GATE.waiting,
    }
