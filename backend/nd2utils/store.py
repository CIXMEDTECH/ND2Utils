from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from nd2utils.config import ensure_dirs, settings
from nd2utils.nd2io import close_nd2


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _write_json(path: Path, payload: Any) -> None:
    ensure_dirs()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_index() -> dict[str, dict[str, Any]]:
    ensure_dirs()
    data = _read_json(settings.index_path, {})
    return data if isinstance(data, dict) else {}


def save_index(index: dict[str, dict[str, Any]]) -> None:
    _write_json(settings.index_path, index)


def upsert_file(record: dict[str, Any]) -> dict[str, Any]:
    index = load_index()
    index[record["id"]] = record
    save_index(index)
    return record


def get_file(file_id: str) -> dict[str, Any] | None:
    return load_index().get(file_id)


def delete_file_record(file_id: str) -> None:
    index = load_index()
    index.pop(file_id, None)
    save_index(index)


def list_files() -> list[dict[str, Any]]:
    items = list(load_index().values())
    items.sort(key=lambda r: r.get("created_at") or 0, reverse=True)
    return items


def load_jobs() -> dict[str, dict[str, Any]]:
    ensure_dirs()
    data = _read_json(settings.jobs_path, {})
    return data if isinstance(data, dict) else {}


def save_jobs(jobs: dict[str, dict[str, Any]]) -> None:
    _write_json(settings.jobs_path, jobs)


def upsert_job(record: dict[str, Any]) -> dict[str, Any]:
    jobs = load_jobs()
    jobs[record["id"]] = record
    save_jobs(jobs)
    return record


def get_job(job_id: str) -> dict[str, Any] | None:
    return load_jobs().get(job_id)


def file_dir(file_id: str) -> Path:
    path = settings.uploads_dir / file_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def source_path(file_id: str) -> Path:
    return file_dir(file_id) / "source.nd2"


def purge_expired(now: float | None = None) -> list[str]:
    now = now or time.time()
    ttl = settings.ttl_hours * 3600
    removed: list[str] = []
    index = load_index()
    for file_id, rec in list(index.items()):
        created = rec.get("created_at") or 0
        if now - created > ttl:
            path = settings.uploads_dir / file_id
            close_nd2(path / "source.nd2")
            if path.exists():
                for child in path.rglob("*"):
                    if child.is_file():
                        child.unlink()
                for child in sorted(path.rglob("*"), reverse=True):
                    if child.is_dir():
                        child.rmdir()
                path.rmdir()
            cache = settings.cache_dir / file_id
            if cache.exists():
                for child in cache.rglob("*"):
                    if child.is_file():
                        child.unlink()
            index.pop(file_id, None)
            removed.append(file_id)
    if removed:
        save_index(index)
    return removed
