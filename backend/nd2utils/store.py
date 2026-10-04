from __future__ import annotations

import json
import re
import secrets
import shutil
import time
from pathlib import Path
from threading import RLock
from typing import Any

from nd2utils import auth
from nd2utils.config import ensure_dirs, settings
from nd2utils.nd2io import close_nd2


OWNER_FIELD = "_owner"
MAX_FOLDER_DEPTH = 32
MAX_SEGMENT = 120

# index.json / jobs.json / folders.json are read-modify-written from request
# threads and export background tasks at the same time.
_LOCK = RLock()


class PathError(ValueError):
    pass


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


def _segment(part: str) -> str:
    part = part.strip()
    if part in {"", "."}:
        return ""
    if part == ".." or len(part) > MAX_SEGMENT or any(ord(ch) < 32 for ch in part):
        raise PathError(f"Invalid folder name: {part[:40]!r}")
    return part


def normalize_folder(raw: str | None) -> str:
    """Normalize a workspace folder path: 'a/b', '' for the root."""
    parts = [_segment(p) for p in re.split(r"[\\/]+", str(raw or ""))]
    clean = [p for p in parts if p]
    if len(clean) > MAX_FOLDER_DEPTH:
        raise PathError("Folder nesting is too deep.")
    return "/".join(clean)


def normalize_filename(raw: str | None) -> str:
    name = re.split(r"[\\/]+", str(raw or "").strip())[-1].strip()
    if not name or name in {".", ".."} or len(name) > 200 or any(ord(ch) < 32 for ch in name):
        raise PathError("Invalid file name.")
    return name


def _in_folder(folder: str, root: str) -> bool:
    return not root or folder == root or folder.startswith(root + "/")


def _ancestors(folder: str) -> list[str]:
    parts = folder.split("/") if folder else []
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


# --- files -----------------------------------------------------------------


def load_index() -> dict[str, dict[str, Any]]:
    ensure_dirs()
    data = _read_json(settings.index_path, {})
    return data if isinstance(data, dict) else {}


def save_index(index: dict[str, dict[str, Any]]) -> None:
    _write_json(settings.index_path, index)


def upsert_file(record: dict[str, Any]) -> dict[str, Any]:
    if not record.get(OWNER_FIELD):
        raise ValueError("file record is missing an owner")
    with _LOCK:
        index = load_index()
        index[record["id"]] = record
        save_index(index)
        _register_folder(record[OWNER_FIELD], record.get("folder") or "")
    return record


def _owned(record: dict[str, Any] | None, owner_id: str) -> bool:
    stored = record.get(OWNER_FIELD) if record else None
    return isinstance(stored, str) and secrets.compare_digest(stored, owner_id)


def get_owned_file(file_id: str, owner_id: str) -> dict[str, Any] | None:
    record = load_index().get(file_id)
    return record if _owned(record, owner_id) else None


def delete_file_record(file_id: str, owner_id: str) -> None:
    with _LOCK:
        index = load_index()
        if _owned(index.get(file_id), owner_id):
            index.pop(file_id, None)
            save_index(index)


def list_files(owner_id: str) -> list[dict[str, Any]]:
    items = [record for record in load_index().values() if _owned(record, owner_id)]
    items.sort(key=lambda r: (r.get("folder") or "", (r.get("name") or "").lower()))
    return items


def find_file(owner_id: str, folder: str, name: str) -> dict[str, Any] | None:
    lowered = name.lower()
    for record in list_files(owner_id):
        if (record.get("folder") or "") == folder and (record.get("name") or "").lower() == lowered:
            return record
    return None


def files_in_folder(owner_id: str, folder: str) -> list[dict[str, Any]]:
    return [r for r in list_files(owner_id) if _in_folder(r.get("folder") or "", folder)]


def update_file(file_id: str, owner_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    with _LOCK:
        index = load_index()
        record = index.get(file_id)
        if not _owned(record, owner_id):
            return None
        record.update(changes)
        save_index(index)
        _register_folder(owner_id, record.get("folder") or "")
        return record


def file_dir(file_id: str) -> Path:
    path = settings.uploads_dir / file_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def source_path(file_id: str) -> Path:
    return file_dir(file_id) / "source.nd2"


def remove_file_data(file_id: str) -> None:
    path = settings.uploads_dir / file_id
    close_nd2(path / "source.nd2")
    shutil.rmtree(path, ignore_errors=True)
    shutil.rmtree(settings.cache_dir / file_id, ignore_errors=True)


def delete_file(file_id: str, owner_id: str) -> None:
    remove_file_data(file_id)
    delete_file_record(file_id, owner_id)


# --- folders ---------------------------------------------------------------


def _load_folders() -> dict[str, list[str]]:
    data = _read_json(settings.folders_path, {})
    return data if isinstance(data, dict) else {}


def _register_folder(owner_id: str, folder: str) -> None:
    """Folders persist after their files are moved or deleted, like on a file system."""
    if not folder:
        return
    with _LOCK:
        data = _load_folders()
        current = set(data.get(owner_id) or [])
        if folder not in current:
            current.add(folder)
            data[owner_id] = sorted(current)
            _write_json(settings.folders_path, data)


def list_folders(owner_id: str) -> list[str]:
    explicit = set(_load_folders().get(owner_id) or [])
    for record in list_files(owner_id):
        explicit.update(_ancestors(record.get("folder") or ""))
    out: set[str] = set()
    for folder in explicit:
        out.update(_ancestors(folder))
    return sorted(out, key=lambda f: f.lower())


def create_folder(owner_id: str, folder: str) -> str:
    folder = normalize_folder(folder)
    if not folder:
        raise PathError("Folder name is required.")
    _register_folder(owner_id, folder)
    return folder


def rename_folder(owner_id: str, old: str, new: str) -> str:
    old = normalize_folder(old)
    new = normalize_folder(new)
    if not old or not new:
        raise PathError("Folder name is required.")
    if new == old:
        return new
    if _in_folder(new, old):
        raise PathError("A folder cannot be moved into itself.")
    if new in list_folders(owner_id):
        raise FileExistsError(new)

    def moved(path: str) -> str:
        return new + path[len(old):]

    with _LOCK:
        data = _load_folders()
        data[owner_id] = sorted({moved(f) if _in_folder(f, old) else f for f in data.get(owner_id) or []} | {new})
        _write_json(settings.folders_path, data)
        index = load_index()
        for record in index.values():
            folder = record.get("folder") or ""
            if _owned(record, owner_id) and _in_folder(folder, old):
                record["folder"] = moved(folder)
        save_index(index)
    return new


def delete_folder(owner_id: str, folder: str) -> list[str]:
    folder = normalize_folder(folder)
    if not folder:
        raise PathError("The workspace root cannot be deleted.")
    removed = [r["id"] for r in files_in_folder(owner_id, folder)]
    for file_id in removed:
        delete_file(file_id, owner_id)
    with _LOCK:
        data = _load_folders()
        data[owner_id] = [f for f in data.get(owner_id) or [] if not _in_folder(f, folder)]
        _write_json(settings.folders_path, data)
    return removed


# --- jobs ------------------------------------------------------------------


def load_jobs() -> dict[str, dict[str, Any]]:
    ensure_dirs()
    data = _read_json(settings.jobs_path, {})
    return data if isinstance(data, dict) else {}


def save_jobs(jobs: dict[str, dict[str, Any]]) -> None:
    _write_json(settings.jobs_path, jobs)


def upsert_job(record: dict[str, Any]) -> dict[str, Any]:
    if not record.get(OWNER_FIELD):
        raise ValueError("job record is missing an owner")
    with _LOCK:
        jobs = load_jobs()
        jobs[record["id"]] = record
        save_jobs(jobs)
    return record


def get_owned_job(job_id: str, owner_id: str) -> dict[str, Any] | None:
    record = load_jobs().get(job_id)
    return record if _owned(record, owner_id) else None


def list_jobs(owner_id: str) -> list[dict[str, Any]]:
    items = [record for record in load_jobs().values() if _owned(record, owner_id)]
    items.sort(key=lambda record: record.get("created_at") or 0, reverse=True)
    return items


def _remove_job_output(job: dict[str, Any]) -> None:
    zip_path = job.get("zip_path")
    if zip_path:
        Path(zip_path).unlink(missing_ok=True)
    shutil.rmtree(settings.exports_dir / str(job.get("id")), ignore_errors=True)


# --- workspace lifecycle ---------------------------------------------------


def workspace_usage(owner_id: str) -> dict[str, int]:
    files = list_files(owner_id)
    return {"files": len(files), "bytes": int(sum(r.get("size_bytes") or 0 for r in files))}


def delete_workspace(owner_id: str) -> None:
    for record in list_files(owner_id):
        delete_file(record["id"], owner_id)
    with _LOCK:
        jobs = load_jobs()
        for job_id, job in list(jobs.items()):
            if _owned(job, owner_id):
                _remove_job_output(job)
                jobs.pop(job_id, None)
        save_jobs(jobs)
        folders = _load_folders()
        if folders.pop(owner_id, None) is not None:
            _write_json(settings.folders_path, folders)


def purge_expired(now: float | None = None) -> list[str]:
    """Apply retention rules.

    - temporary codes: files older than TTL are removed; an expired code loses its whole workspace
    - permanent codes: ND2 files are never removed automatically
    - files whose owner code no longer exists (e.g. pre-auth data) are removed after TTL
    - export archives are transient for everyone and removed after TTL
    """
    now = now or time.time()
    ttl = settings.ttl_hours * 3600
    codes = auth.known_owner_ids()

    def temporary_gone(owner: str | None) -> bool:
        rec = codes.get(owner or "")
        return rec is not None and rec.get("kind") == "temporary" and auth.code_status(rec, now) == "expired"

    removed: list[str] = []
    for file_id, rec in list(load_index().items()):
        owner = rec.get(OWNER_FIELD)
        code = codes.get(owner or "")
        old = now - (rec.get("created_at") or 0) > ttl
        if code is None:
            drop = old
        elif code.get("kind") == "permanent":
            drop = False
        else:
            drop = old or temporary_gone(owner)
        if drop:
            remove_file_data(file_id)
            removed.append(file_id)
    with _LOCK:
        if removed:
            index = load_index()
            for file_id in removed:
                index.pop(file_id, None)
            save_index(index)

        jobs = load_jobs()
        changed = False
        for job_id, job in list(jobs.items()):
            owner = job.get(OWNER_FIELD)
            if now - (job.get("created_at") or 0) > ttl or owner not in codes or temporary_gone(owner):
                _remove_job_output(job)
                jobs.pop(job_id, None)
                changed = True
        if changed:
            save_jobs(jobs)

        folders = _load_folders()
        stale = [owner for owner in folders if owner not in codes or temporary_gone(owner)]
        for owner in stale:
            folders.pop(owner, None)
        if stale:
            _write_json(settings.folders_path, folders)

    if settings.staging_dir.exists():
        for child in settings.staging_dir.iterdir():
            try:
                if now - child.stat().st_mtime > ttl:
                    shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
            except OSError:
                continue
    return removed
