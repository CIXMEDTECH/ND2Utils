from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import time
import uuid
from pathlib import Path
from threading import RLock
from typing import Any

from nd2utils import auth, jsoncache
from nd2utils.config import ensure_dirs, settings
from nd2utils.nd2io import close_nd2
from nd2utils.ometiff import close_slide
from nd2utils.slide_render import forget as forget_rendered


OWNER_FIELD = "_owner"
MAX_FOLDER_DEPTH = 32
MAX_SEGMENT = 120

# index.json / jobs.json / folders.json are read-modify-written from request
# threads and export background tasks at the same time.
_LOCK = RLock()


class PathError(ValueError):
    pass


class JobCancelled(Exception):
    """The job's record was deleted while it ran: stop and clean up."""


# Ids of jobs deleted while queued/running. A running export keeps writing its progress;
# without these markers the record would come back.
_DELETED_JOBS: set[str] = set()


# Large acquisition metadata lives in uploads/<id>/detail.json, not in index.json:
# the index is consulted on every request and must stay small.
DETAIL_KEYS = ("text_info", "experiment", "events", "metadata", "app_info", "groups")


def _read_json(path: Path, default: Any) -> Any:
    return jsoncache.read(path, lambda: default)


def _write_json(path: Path, payload: Any) -> None:
    ensure_dirs()
    jsoncache.write(path, payload)


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
    """The shared, cached index. Mutate it only while holding _LOCK (and save it back);
    readers outside the lock should use index_items() / list_files() snapshots."""
    data = _read_json(settings.index_path, {})
    return data if isinstance(data, dict) else {}


def _snapshot(loader: Any) -> list[tuple[str, dict[str, Any]]]:
    # Writers mutate the cached object in place under _LOCK; copying under the same lock
    # avoids "dictionary changed size during iteration" in concurrent readers.
    with _LOCK:
        return [(key, dict(rec)) for key, rec in loader().items() if isinstance(rec, dict)]


def _get_copy(loader: Any, key: str) -> dict[str, Any] | None:
    with _LOCK:
        rec = loader().get(key)
        return dict(rec) if isinstance(rec, dict) else None


def index_items() -> list[tuple[str, dict[str, Any]]]:
    return _snapshot(load_index)


def index_get(file_id: str) -> dict[str, Any] | None:
    return _get_copy(load_index, file_id)


def save_index(index: dict[str, dict[str, Any]]) -> None:
    _write_json(settings.index_path, index)


def _detail_path(file_id: str) -> Path:
    return settings.uploads_dir / file_id / "detail.json"


def _split_detail(record: dict[str, Any]) -> dict[str, Any]:
    """Move heavy metadata into detail.json and return the slim index record."""
    detail = {k: record[k] for k in DETAIL_KEYS if k in record}
    if detail:
        path = _detail_path(record["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(detail, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    return {k: v for k, v in record.items() if k not in DETAIL_KEYS}


def upsert_file(record: dict[str, Any]) -> dict[str, Any]:
    if not record.get(OWNER_FIELD):
        raise ValueError("file record is missing an owner")
    slim = _split_detail(record)
    with _LOCK:
        index = load_index()
        index[record["id"]] = slim
        save_index(index)
        _register_folder(record[OWNER_FIELD], record.get("folder") or "")
    return record


def upsert_files(records: list[dict[str, Any]]) -> None:
    """upsert_file for many records (e.g. the images of a LIF project) with one index write."""
    if any(not record.get(OWNER_FIELD) for record in records):
        raise ValueError("file record is missing an owner")
    slim = [_split_detail(record) for record in records]
    with _LOCK:
        index = load_index()
        for record in slim:
            index[record["id"]] = record
        save_index(index)
        for record in slim:
            _register_folder(record[OWNER_FIELD], record.get("folder") or "")


def migrate_index() -> None:
    """Older versions kept the full metadata in index.json; split it out once."""
    with _LOCK:
        index = load_index()
        changed = False
        for file_id, record in list(index.items()):
            if any(k in record for k in DETAIL_KEYS):
                index[file_id] = _split_detail(record)
                changed = True
        if changed:
            save_index(index)


def get_file_detail(file_id: str, owner_id: str) -> dict[str, Any] | None:
    record = get_owned_file(file_id, owner_id)
    if record is None:
        return None
    try:
        detail = json.loads(_detail_path(file_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        detail = {}
    return {**record, **detail}


def _owned(record: dict[str, Any] | None, owner_id: str) -> bool:
    stored = record.get(OWNER_FIELD) if record else None
    return isinstance(stored, str) and secrets.compare_digest(stored, owner_id)


def get_owned_file(file_id: str, owner_id: str) -> dict[str, Any] | None:
    record = index_get(file_id)
    return record if _owned(record, owner_id) else None


def delete_file_record(file_id: str, owner_id: str) -> None:
    with _LOCK:
        index = load_index()
        if _owned(index.get(file_id), owner_id):
            index.pop(file_id, None)
            save_index(index)
        projects = load_projects()
        p_changed = False
        for proj in projects.values():
            if _owned(proj, owner_id) and file_id in (proj.get("file_ids") or []):
                proj["file_ids"] = [fid for fid in (proj.get("file_ids") or []) if fid != file_id]
                p_changed = True
        if p_changed:
            save_projects(projects)


def list_files(owner_id: str) -> list[dict[str, Any]]:
    items = [record for _, record in index_items() if _owned(record, owner_id)]
    items.sort(key=lambda r: (r.get("folder") or "", (r.get("name") or "").lower()))
    return items


def find_file(owner_id: str, folder: str, name: str) -> dict[str, Any] | None:
    lowered = name.lower()
    for _, record in index_items():
        if (
            (record.get("folder") or "") == folder
            and (record.get("name") or "").lower() == lowered
            and _owned(record, owner_id)
        ):
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
        return dict(record)


def patch_files(changes: dict[str, dict[str, Any]]) -> None:
    """Apply per-file changes (file id -> fields) with one index write. Unknown ids are skipped."""
    if not changes:
        return
    with _LOCK:
        index = load_index()
        for file_id, fields in changes.items():
            if file_id in index:
                index[file_id].update(fields)
        save_index(index)


def file_dir(file_id: str) -> Path:
    path = settings.uploads_dir / file_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def source_path(file_id: str) -> Path:
    # The uploaded file, whatever its format (ND2, OME-TIFF or a hard link to a LIF project):
    # the readers sniff the content.
    return file_dir(file_id) / "source.nd2"


def remove_file_data(file_id: str) -> None:
    path = settings.uploads_dir / file_id
    close_nd2(path / "source.nd2")
    close_slide(path / "source.nd2")
    forget_rendered(file_id)
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
    with _LOCK:
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
    data = _read_json(settings.jobs_path, {})
    return data if isinstance(data, dict) else {}


def save_jobs(jobs: dict[str, dict[str, Any]]) -> None:
    _write_json(settings.jobs_path, jobs)


def upsert_job(record: dict[str, Any]) -> dict[str, Any]:
    if not record.get(OWNER_FIELD):
        raise ValueError("job record is missing an owner")
    with _LOCK:
        if record["id"] in _DELETED_JOBS:
            raise JobCancelled(record["id"])
        jobs = load_jobs()
        # A copy: export threads keep mutating their own record between progress writes.
        jobs[record["id"]] = dict(record)
        save_jobs(jobs)
    return record


def job_cancelled(job_id: str) -> bool:
    return job_id in _DELETED_JOBS


def delete_jobs(owner_id: str, job_ids: list[str] | None = None, *, finished_only: bool = False) -> list[str]:
    """Delete these jobs (all of the owner's when None) and their downloads. Running ones are
    cancelled: they stop at their next progress update. Returns the deleted ids."""
    with _LOCK:
        jobs = load_jobs()
        wanted = set(job_ids) if job_ids is not None else None
        doomed = [
            rec
            for job_id, rec in jobs.items()
            if _owned(rec, owner_id)
            and (wanted is None or job_id in wanted)
            and (not finished_only or rec.get("status") in ("done", "error"))
        ]
        for rec in doomed:
            jobs.pop(rec["id"], None)
            if rec.get("status") in ("queued", "running"):
                _DELETED_JOBS.add(rec["id"])
        if doomed:
            save_jobs(jobs)
    for rec in doomed:
        _remove_job_output(rec)
    return [rec["id"] for rec in doomed]


def fail_interrupted_jobs() -> int:
    """At startup: jobs left queued/running by a previous process will never finish."""
    with _LOCK:
        jobs = load_jobs()
        stale = [rec for rec in jobs.values() if rec.get("status") in ("queued", "running")]
        for rec in stale:
            rec.update({"status": "error", "error": "interrupted", "message": "Interrupted by a server restart"})
        if stale:
            save_jobs(jobs)
    return len(stale)


def get_owned_job(job_id: str, owner_id: str) -> dict[str, Any] | None:
    record = _get_copy(load_jobs, job_id)
    return record if _owned(record, owner_id) else None


def list_jobs(owner_id: str) -> list[dict[str, Any]]:
    items = [record for _, record in _snapshot(load_jobs) if _owned(record, owner_id)]
    items.sort(key=lambda record: record.get("created_at") or 0, reverse=True)
    return items


def _remove_job_output(job: dict[str, Any]) -> None:
    zip_path = job.get("zip_path")
    if zip_path:
        Path(zip_path).unlink(missing_ok=True)
    shutil.rmtree(settings.exports_dir / str(job.get("id")), ignore_errors=True)


# --- projects (Studio multi-image editing projects) ------------------------


def load_projects() -> dict[str, dict[str, Any]]:
    ensure_dirs()
    data = _read_json(settings.projects_path, {})
    return data if isinstance(data, dict) else {}


def save_projects(projects: dict[str, dict[str, Any]]) -> None:
    _write_json(settings.projects_path, projects)


def list_projects(owner_id: str) -> list[dict[str, Any]]:
    items = [record for _, record in _snapshot(load_projects) if _owned(record, owner_id)]
    items.sort(key=lambda r: r.get("updated_at") or r.get("created_at") or 0, reverse=True)
    return items


def get_owned_project(project_id: str, owner_id: str) -> dict[str, Any] | None:
    record = _get_copy(load_projects, project_id)
    return record if _owned(record, owner_id) else None


def create_project(
    owner_id: str,
    name: str,
    description: str = "",
    file_ids: list[str] | None = None,
    project_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    clean_name = (name or "").strip() or "Untitled Project"
    if len(clean_name) > 160:
        clean_name = clean_name[:160]
    now = time.time()
    owned_ids = [
        fid
        for fid in dict.fromkeys(file_ids or [])
        if get_owned_file(fid, owner_id) is not None
    ]
    rec: dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "name": clean_name,
        "description": (description or "").strip()[:500],
        "file_ids": owned_ids,
        "settings": dict(project_settings or {}),
        "created_at": now,
        "updated_at": now,
        OWNER_FIELD: owner_id,
    }
    with _LOCK:
        projects = load_projects()
        projects[rec["id"]] = rec
        save_projects(projects)
    return dict(rec)


def update_project(project_id: str, owner_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    with _LOCK:
        projects = load_projects()
        rec = projects.get(project_id)
        if not _owned(rec, owner_id):
            return None
        if "name" in changes and changes["name"] is not None:
            clean_name = str(changes["name"]).strip()
            if clean_name:
                rec["name"] = clean_name[:160]
        if "description" in changes and changes["description"] is not None:
            rec["description"] = str(changes["description"]).strip()[:500]
        if "file_ids" in changes and changes["file_ids"] is not None:
            rec["file_ids"] = [
                fid
                for fid in dict.fromkeys(changes["file_ids"])
                if get_owned_file(fid, owner_id) is not None
            ]
        if "settings" in changes and isinstance(changes["settings"], dict):
            rec["settings"] = {**(rec.get("settings") or {}), **changes["settings"]}
        rec["updated_at"] = time.time()
        save_projects(projects)
        return dict(rec)


def delete_project(project_id: str, owner_id: str) -> bool:
    with _LOCK:
        projects = load_projects()
        if not _owned(projects.get(project_id), owner_id):
            return False
        projects.pop(project_id, None)
        save_projects(projects)
        return True


# --- admin: copy / move between workspaces ---------------------------------


def _clone_file_data(src_id: str, dst_id: str) -> None:
    src = settings.uploads_dir / src_id
    dst = settings.uploads_dir / dst_id
    dst.mkdir(parents=True, exist_ok=True)
    for child in src.iterdir():
        target = dst / child.name
        if child.name == "source.nd2":
            # Uploaded files are never modified in place, so a hard link is a safe, instant copy.
            try:
                os.link(child, target)
                continue
            except OSError:
                pass
        if child.is_file():
            shutil.copy2(child, target)
    cache = settings.cache_dir / src_id
    if cache.is_dir():
        shutil.copytree(cache, settings.cache_dir / dst_id, dirs_exist_ok=True)


_DOUBLE_EXT = (".ome.tiff", ".ome.tif")


def _split_ext(name: str) -> tuple[str, str]:
    lowered = name.lower()
    for ext in _DOUBLE_EXT:
        if lowered.endswith(ext) and len(name) > len(ext):
            return name[: -len(ext)], name[-len(ext):]
    stem, dot, ext = name.rpartition(".")
    return (stem, dot + ext) if dot and stem else (name, "")


def unique_name(taken: set[str], name: str) -> str:
    """`name`, or "stem (2).ext", "stem (3).ext"… — the first not in `taken` (lower-case names)."""
    if name.lower() not in taken:
        return name
    stem, ext = _split_ext(name)
    n = 2
    while f"{stem} ({n}){ext}".lower() in taken:
        n += 1
    return f"{stem} ({n}){ext}"


def move_items(
    owner_id: str,
    *,
    file_ids: list[str],
    folders: list[str],
    target_folder: str,
    conflict: str = "skip",
) -> dict[str, Any]:
    """Move files and folders within one workspace, like a file manager.

    A moved folder keeps its name (and its subfolders) below `target_folder`, merging into a
    folder of the same name that is already there. Name clashes are skipped, replace the
    existing file, or get a " (2)" suffix (`conflict`: skip / replace / rename). Only metadata
    changes - files are stored by id - so previews and caches stay valid. One index write.

    Returns counts plus `undo`, the original places, for undo_move()."""
    target = normalize_folder(target_folder)
    normalized = [normalize_folder(f) for f in folders]
    if "" in normalized:
        # The workspace root contains every target folder.
        raise PathError("A folder cannot be moved into itself.")
    picked = list(dict.fromkeys(normalized))
    # Moving a folder moves everything inside it: drop selections nested in another one.
    picked = [f for f in picked if not any(f != g and _in_folder(f, g) for g in picked)]
    replaced_ids: list[str] = []
    with _LOCK:
        existing = set(list_folders(owner_id))
        for folder in picked:
            if folder not in existing:
                raise FileNotFoundError(folder)
            if _in_folder(target, folder):
                raise PathError("A folder cannot be moved into itself.")
        index = load_index()
        owned = {fid: rec for fid, rec in index.items() if _owned(rec, owner_id)}
        plan: list[tuple[str, str]] = []
        folder_map: dict[str, str] = {}
        skipped = 0
        for folder in picked:
            dest = "/".join(p for p in (target, folder.rsplit("/", 1)[-1]) if p)
            if dest == folder:
                continue  # already there
            for sub in existing:
                if _in_folder(sub, folder):
                    folder_map[sub] = dest + sub[len(folder):]
            for fid, rec in owned.items():
                current = rec.get("folder") or ""
                if _in_folder(current, folder):
                    plan.append((fid, dest + current[len(folder):]))
        planned = {fid for fid, _ in plan}
        for fid in dict.fromkeys(file_ids):
            rec = owned.get(fid)
            if rec is None:
                raise FileNotFoundError(fid)
            if fid in planned:
                continue
            if (rec.get("folder") or "") == target:
                skipped += 1
                continue
            planned.add(fid)
            plan.append((fid, target))
        # Names already present in each destination (files that stay where they are).
        names: dict[str, dict[str, str]] = {}
        for fid, rec in owned.items():
            if fid not in planned:
                names.setdefault(rec.get("folder") or "", {})[(rec.get("name") or "").lower()] = fid
        moved = renamed = 0
        undo_files: list[dict[str, str]] = []
        for fid, dest in plan:
            rec = index[fid]
            name = rec.get("name") or fid
            here = names.setdefault(dest, {})
            new_name = name
            clash = here.get(name.lower())
            if clash:
                # Never replace a file that is itself part of this move.
                if conflict == "replace" and clash not in planned:
                    replaced_ids.append(clash)
                    here.pop(name.lower(), None)
                elif conflict == "rename":
                    new_name = unique_name(set(here), name)
                    renamed += 1
                else:
                    skipped += 1
                    continue
            undo_files.append({"id": fid, "folder": rec.get("folder") or "", "name": name})
            # A new record object: readers may still hold the old one.
            index[fid] = {**rec, "folder": dest, "name": new_name}
            here[new_name.lower()] = fid
            moved += 1
        if moved:
            save_index(index)
        data = _load_folders()
        current = set(data.get(owner_id) or [])
        removed = sorted(f for f in current if f in folder_map)
        current.difference_update(folder_map)
        current.update(folder_map.values())
        current.update(_ancestors(target))
        data[owner_id] = sorted(current)
        _write_json(settings.folders_path, data)
    for clash in replaced_ids:
        delete_file(clash, owner_id)  # data, and references from projects
    return {
        "moved": moved,
        "skipped": skipped,
        "renamed": renamed,
        "replaced": len(replaced_ids),
        "undo": {
            "files": undo_files,
            "folders_removed": removed,
            "folders_added": sorted(set(folder_map.values())),
        },
    }


def undo_move(owner_id: str, undo: dict[str, Any]) -> dict[str, int]:
    """Put files back where move_items found them (skipping any whose old name is now taken)."""
    files = [f for f in undo.get("files") or [] if isinstance(f, dict)]
    restored = skipped = 0
    with _LOCK:
        index = load_index()
        taken: dict[str, dict[str, str]] = {}
        moving = {f.get("id") for f in files}
        for fid, rec in index.items():
            if _owned(rec, owner_id) and fid not in moving:
                taken.setdefault(rec.get("folder") or "", {})[(rec.get("name") or "").lower()] = fid
        for item in files:
            fid = str(item.get("id") or "")
            rec = index.get(fid)
            if not _owned(rec, owner_id):
                skipped += 1
                continue
            folder = normalize_folder(item.get("folder"))
            name = normalize_filename(item.get("name") or rec.get("name"))
            here = taken.setdefault(folder, {})
            if name.lower() in here:
                skipped += 1
                continue
            index[fid] = {**rec, "folder": folder, "name": name}
            here[name.lower()] = fid
            restored += 1
        if restored:
            save_index(index)
        data = _load_folders()
        current = set(data.get(owner_id) or [])
        current.update(normalize_folder(f) for f in undo.get("folders_removed") or [] if f)
        in_use = {rec.get("folder") or "" for rec in index.values() if _owned(rec, owner_id)}
        for added in undo.get("folders_added") or []:
            added = normalize_folder(added)
            if not any(_in_folder(u, added) for u in in_use):
                current = {f for f in current if not _in_folder(f, added)}
        data[owner_id] = sorted(current)
        _write_json(settings.folders_path, data)
    return {"restored": restored, "skipped": skipped}


def transfer(
    source_owner: str,
    target_owner: str,
    *,
    file_ids: list[str],
    folders: list[str],
    target_folder: str,
    mode: str,
    conflict: str,
) -> dict[str, Any]:
    """Copy or move files/folders from one workspace into a folder of another (or the same) one.

    A selected folder keeps its name and inner structure below `target_folder`; selected files
    land directly in `target_folder`. Same-name files in the destination are skipped or replaced.
    """
    same = source_owner == target_owner
    if same and mode == "move":
        moved = move_items(
            source_owner, file_ids=file_ids, folders=folders, target_folder=target_folder,
            conflict="replace" if conflict == "replace" else "skip",
        )
        return {"copied": 0, "moved": moved["moved"], "skipped": moved["skipped"], "replaced": moved["replaced"], "files": []}
    target_folder = normalize_folder(target_folder)
    folders = [normalize_folder(f) for f in folders]
    existing_folders = set(list_folders(source_owner))
    plan: list[tuple[dict[str, Any], str]] = []
    seen: set[str] = set()
    new_folders: set[str] = {target_folder} if target_folder else set()

    for folder in folders:
        if folder and folder not in existing_folders:
            raise FileNotFoundError(folder)
        # ("" is the whole workspace, which contains every possible target folder.)
        if same and mode == "move" and _in_folder(target_folder, folder):
            raise PathError("A folder cannot be moved into itself.")
        base = folder.rsplit("/", 1)[0] if "/" in folder else ""

        def relocate(path: str, base: str = base) -> str:
            rel = path[len(base):].lstrip("/") if base else path
            return "/".join(p for p in (target_folder, rel) if p)

        for sub in existing_folders:
            if _in_folder(sub, folder) and sub:
                new_folders.add(relocate(sub))
        for record in files_in_folder(source_owner, folder):
            if record["id"] not in seen:
                seen.add(record["id"])
                plan.append((record, relocate(record.get("folder") or "")))
    for file_id in file_ids:
        record = get_owned_file(file_id, source_owner)
        if record is None:
            raise FileNotFoundError(file_id)
        if file_id not in seen:
            seen.add(file_id)
            plan.append((record, target_folder))

    result = {"copied": 0, "moved": 0, "skipped": 0, "replaced": 0, "files": []}
    now = time.time()
    for record, folder in plan:
        if same and mode == "move" and (record.get("folder") or "") == folder:
            result["skipped"] += 1
            continue
        clash = find_file(target_owner, folder, record.get("name") or "")
        if clash:
            # Never replace a file that is itself being copied/moved (or the file with itself).
            if conflict != "replace" or clash["id"] in seen:
                result["skipped"] += 1
                continue
            delete_file(clash["id"], target_owner)
            result["replaced"] += 1
        if mode == "move":
            changes: dict[str, Any] = {"folder": folder}
            if not same:
                # The retention clock of the new owner starts now.
                changes.update({OWNER_FIELD: target_owner, "created_at": now})
            with _LOCK:
                index = load_index()
                index[record["id"]].update(changes)
                save_index(index)
            result["moved"] += 1
            result["files"].append(record["id"])
        else:
            new_id = uuid.uuid4().hex
            _clone_file_data(record["id"], new_id)
            clone = {**record, "id": new_id, OWNER_FIELD: target_owner, "folder": folder, "created_at": now}
            with _LOCK:
                index = load_index()
                index[new_id] = clone
                save_index(index)
            result["copied"] += 1
            result["files"].append(new_id)

    with _LOCK:
        data = _load_folders()
        if mode == "move":
            # Moved folders disappear from the source, like a file-system move.
            data[source_owner] = [
                f for f in data.get(source_owner) or [] if not any(_in_folder(f, src) for src in folders)
            ]
        current = set(data.get(target_owner) or [])
        for folder in new_folders:
            current.update(_ancestors(folder))
        data[target_owner] = sorted(current)
        _write_json(settings.folders_path, data)
    return result


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
        projects = load_projects()
        for pid, proj in list(projects.items()):
            if _owned(proj, owner_id):
                projects.pop(pid, None)
        save_projects(projects)
    from nd2utils import analyses  # local import: analyses imports store

    analyses.delete_owner(owner_id)


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
