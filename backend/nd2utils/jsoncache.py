"""Parsed-JSON cache for the small state files (index, jobs, folders, auth).

These files are read on almost every request. Re-parsing them each time gets slow once a
workspace holds hundreds of files, so the parsed object is kept until the file's
mtime/size changes. Writers go through `write()`, which refreshes the cache.

Callers may mutate the returned object only if they write it back afterwards.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import RLock
from typing import Any, Callable

# One lock per state file: a slow index write must not hold up session lookups in auth.json.
_LOCKS: dict[str, RLock] = {}
_LOCKS_GUARD = RLock()
_CACHE: dict[str, tuple[tuple[int, int], Any]] = {}


def _lock(key: str) -> RLock:
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = _LOCKS[key] = RLock()
        return lock


def _stamp(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return (st.st_mtime_ns, st.st_size)


def read(path: Path, default: Callable[[], Any], *, strict: bool = False) -> Any:
    """Return the parsed file, or `default()` when missing (or unreadable unless `strict`)."""
    key = str(path)
    with _lock(key):
        stamp = _stamp(path)
        if stamp is None:
            _CACHE.pop(key, None)
            return default()
        cached = _CACHE.get(key)
        if cached and cached[0] == stamp:
            return cached[1]
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            if strict:
                raise
            return default()
        _CACHE[key] = (stamp, data)
        return data


def write(path: Path, payload: Any, *, mode: int | None = None) -> None:
    key = str(path)
    with _lock(key):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        # Compact output uses the C encoder (indent= falls back to pure Python, ~5x slower).
        tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        if mode is not None:
            os.chmod(tmp, mode)
        tmp.replace(path)
        stamp = _stamp(path)
        if stamp is not None:
            _CACHE[key] = (stamp, payload)


def forget(path: Path) -> None:
    key = str(path)
    with _lock(key):
        _CACHE.pop(key, None)
