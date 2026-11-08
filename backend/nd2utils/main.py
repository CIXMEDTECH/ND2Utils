from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from nd2utils import __version__, auth, lifio, ometiff, perf, prepare, slide_render
from nd2utils.config import ensure_dirs, repo_root, settings
from nd2utils.export_jobs import _write_ome_tiff, new_job_id, run_export
from nd2utils.models import CropRequest, ExportRequest, MeasureRequest
from nd2utils.nd2io import (
    Nd2Error,
    axis_size,
    close_all,
    extract_channels,
    identify_path,
    open_nd2,
    pack_planes,
    projection,
    read_crop,
    write_crop,
)
from nd2utils.lifio import LifError
from nd2utils.ometiff import SlideError
from nd2utils.render import (
    encode_image,
    histogram,
    line_profile,
    measure_planes,
    parse_visible_mask,
    preview_rgb,
)
from nd2utils.slide_export import SlideExportError, SlideExportRequest, run_slide_export
from nd2utils.slide_export import plan as plan_slide_export
from nd2utils.store import (
    PathError,
    create_folder,
    delete_file,
    delete_folder,
    delete_workspace,
    file_dir,
    files_in_folder,
    find_file,
    get_file_detail,
    get_owned_file,
    get_owned_job,
    list_files,
    list_folders,
    list_jobs,
    migrate_index,
    normalize_filename,
    normalize_folder,
    purge_expired,
    remove_file_data,
    rename_folder,
    source_path,
    transfer,
    update_file,
    upsert_file,
    upsert_files,
    upsert_job,
    workspace_usage,
)

FRONTEND_DIST = repo_root() / "frontend" / "dist"
SESSION_COOKIE = "nd2utils_session"
log = logging.getLogger("nd2utils")

# Reachable without logging in. Everything else under /api/ needs a valid session.
_PUBLIC_API = {"/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/docs", "/api/openapi.json"}


async def _purge_loop() -> None:
    while True:
        await asyncio.sleep(max(settings.purge_interval_seconds, 30))
        try:
            await asyncio.to_thread(purge_expired)
        except Exception:  # keep the loop alive; the next round retries
            log.exception("Scheduled cleanup failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_dirs()
    auth.ensure_admin()
    migrate_index()
    perf.apply()
    purge_expired()
    # Files imported before background preparation existed (or interrupted by a restart).
    prepare.schedule_missing()
    task = asyncio.create_task(_purge_loop())
    yield
    task.cancel()
    prepare.shutdown()
    close_all()
    ometiff.close_all()


app = FastAPI(
    title="ND2Utils",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _unauthorized() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"detail": {"code": "unauthorized", "message": "Log in with an access code."}},
    )


@app.middleware("http")
async def require_login(request: Request, call_next):
    token = request.cookies.get(SESSION_COOKIE)
    user = await run_in_threadpool(auth.resolve_session, token) if token else None
    request.state.user = user
    path = request.url.path
    if path.startswith("/api/") and path not in _PUBLIC_API and user is None:
        response = _unauthorized()
    else:
        response = await call_next(request)
    if path.startswith("/api/"):
        # Per-user data: never let a browser or CDN reuse it (e.g. a stale "not logged in").
        response.headers.setdefault("Cache-Control", "no-store")
    return response


def _current_user(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail={"code": "unauthorized", "message": "Log in with an access code."})
    return user


def _workspace_owner(user: Annotated[dict[str, Any], Depends(_current_user)]) -> str:
    # One access code == one workspace.
    return user["id"]


def _admin_user(user: Annotated[dict[str, Any], Depends(_current_user)]) -> dict[str, Any]:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Administrator access required."})
    return user


CurrentUser = Annotated[dict[str, Any], Depends(_current_user)]
Owner = Annotated[str, Depends(_workspace_owner)]
AdminUser = Annotated[dict[str, Any], Depends(_admin_user)]


def _public(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if not key.startswith("_")}


def _raise_nd2(exc: Nd2Error | SlideError | LifError) -> None:
    status = 400 if exc.code in {"not_nd2", "not_tiff", "not_lif", "parse_failed", "empty", "unsupported"} else 500
    raise HTTPException(status_code=status, detail={"code": exc.code, "message": str(exc)})


def _owned_file(file_id: str, owner_id: str) -> dict[str, Any]:
    rec = get_owned_file(file_id, owner_id)
    if not rec:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File not found."})
    return rec


def _need(file_id: str, owner_id: str) -> dict[str, Any]:
    rec = _owned_file(file_id, owner_id)
    if rec.get("status") != "ready":
        raise HTTPException(status_code=409, detail={"code": "not_ready", "message": rec.get("error") or "File is not ready."})
    return rec


def _need_nd2(file_id: str, owner_id: str) -> dict[str, Any]:
    rec = _need(file_id, owner_id)
    if prepare.is_slide(rec):
        raise HTTPException(
            status_code=400,
            detail={"code": "slide_file", "message": "This is an OME-TIFF slide; open it in the slide viewer."},
        )
    return rec


def _need_slide(file_id: str, owner_id: str) -> dict[str, Any]:
    rec = _need(file_id, owner_id)
    if not prepare.is_slide(rec):
        raise HTTPException(status_code=400, detail={"code": "not_slide", "message": "This file is not an OME-TIFF slide."})
    return rec


def _bad_path(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "bad_path", "message": str(exc) or "Invalid path."})


def _folder_arg(raw: str | None) -> str:
    try:
        return normalize_folder(raw)
    except PathError as exc:
        raise _bad_path(exc) from exc


def _source_name(raw: str | None) -> str:
    try:
        name = normalize_filename(raw or "upload.nd2")
    except PathError as exc:
        raise _bad_path(exc) from exc
    if not (name.lower().endswith(".nd2") or ometiff.is_tiff_name(name) or lifio.is_lif_name(name)):
        raise HTTPException(
            status_code=400,
            detail={"code": "not_nd2", "message": "Please upload a .nd2, OME-TIFF (.ome.tif / .ome.tiff) or Leica .lif file."},
        )
    return name


def _identify(path: Path, file_id: str, name: str, size: int, created: float) -> dict[str, Any]:
    if ometiff.is_tiff_name(name):
        return ometiff.identify_path(path, file_id, name, size, created)
    rec = identify_path(path, file_id, name, size, created)
    rec["format"] = "nd2"
    return rec


def _ingest_file(
    src: Path,
    name: str,
    owner_id: str,
    size_bytes: int | None = None,
    folder: str = "",
) -> dict[str, Any]:
    if lifio.is_lif_name(name):
        return _ingest_lif(src, name, owner_id, size_bytes if size_bytes is not None else src.stat().st_size, folder)
    file_id = uuid.uuid4().hex
    dest = source_path(file_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.resolve() != dest.resolve():
        shutil.move(src, dest)
    size = size_bytes if size_bytes is not None else dest.stat().st_size
    if size > settings.max_upload_bytes:
        delete_file(file_id, owner_id)
        raise HTTPException(status_code=413, detail={"code": "too_large", "message": "File exceeds upload limit."})
    created = time.time()
    try:
        rec = _identify(dest, file_id, name, size, created)
    except (Nd2Error, SlideError) as exc:
        delete_file(file_id, owner_id)
        _raise_nd2(exc)
    rec["_owner"] = owner_id
    rec["folder"] = folder
    rec["prepare"] = "pending"
    # Uploading the same file name into the same folder replaces the old copy, like a file system.
    previous = find_file(owner_id, folder, name)
    upsert_file(rec)
    if previous and previous["id"] != file_id:
        delete_file(previous["id"], owner_id)
    # Prepare previews in the background so opening the file later is instant.
    prepare.schedule(file_id)
    return rec


def _link_or_copy(src: Path, dest: Path) -> None:
    try:
        os.link(src, dest)
    except OSError:
        # File systems without hard links: every image keeps its own copy of the project.
        shutil.copy2(src, dest)


def _ingest_lif(src: Path, name: str, owner_id: str, size: int, folder: str) -> dict[str, Any]:
    """A Leica LIF file is a whole project: it becomes a folder named after the file, holding one
    workspace file per image (the project's own folders become subfolders).

    Every image links to the same uploaded data (see lifio). Images with the same name in the same
    folder replace older ones, like re-uploading an ND2 file. Returns the first image's record."""
    if size > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail={"code": "too_large", "message": "File exceeds upload limit."})
    try:
        entries = lifio.read_project(src)
    except LifError as exc:
        _raise_nd2(exc)
    if not entries:
        raise HTTPException(status_code=400, detail={"code": "empty", "message": "The LIF file contains no readable images."})
    try:
        base = normalize_folder("/".join(p for p in (folder, lifio.project_folder_name(name)) if p))
    except PathError as exc:
        raise _bad_path(exc) from exc
    created = time.time()
    records: list[dict[str, Any]] = []
    made: list[str] = []
    replaced: list[str] = []
    taken: set[tuple[str, str]] = set()
    try:
        for entry in entries:
            sub = normalize_folder("/".join(p for p in (base, entry["folder"]) if p))
            child = entry["name"]
            n = 2
            while (sub, child.lower()) in taken:
                child = f"{entry['name']} ({n})"
                n += 1
            taken.add((sub, child.lower()))
            file_id = uuid.uuid4().hex
            made.append(file_id)
            directory = file_dir(file_id)
            _link_or_copy(src, directory / "source.nd2")
            lifio.write_sidecar(directory, entry)
            rec = {
                **entry["record"],
                "id": file_id,
                "name": child,
                "created_at": created,
                "_owner": owner_id,
                "folder": sub,
                "prepare": "pending",
                "lif": {"project": name, "path": entry["path"]},
            }
            previous = find_file(owner_id, sub, child)
            if previous:
                replaced.append(previous["id"])
            records.append(rec)
    except PathError as exc:
        for file_id in made:
            remove_file_data(file_id)
        raise _bad_path(exc) from exc
    except Exception:
        for file_id in made:
            remove_file_data(file_id)
        raise
    upsert_files(records)
    for file_id in replaced:
        delete_file(file_id, owner_id)
    for rec in records:
        prepare.schedule(rec["id"])
    return {**records[0], "imported": {"folder": base, "count": len(records)}}


def _need_upload(upload_id: str, owner_id: str) -> tuple[Path, dict[str, Any]]:
    if not upload_id.isalnum():
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
    dest_dir = settings.staging_dir / upload_id
    meta_path = dest_dir / "meta.json"
    if not meta_path.is_file():
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
    stored_owner = meta.get("_owner")
    if not isinstance(stored_owner, str) or not secrets.compare_digest(stored_owner, owner_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
    return dest_dir, meta


class ChunkInit(BaseModel):
    filename: str
    size: int
    folder: str = ""


class LoginBody(BaseModel):
    code: str


class FolderBody(BaseModel):
    path: str


class FolderRename(BaseModel):
    path: str
    new_path: str


class FilePatch(BaseModel):
    name: str | None = None
    folder: str | None = None


class CodeCreate(BaseModel):
    label: str = ""
    kind: auth.Kind = "temporary"
    expires_at: float | None = None


class CodePatch(BaseModel):
    label: str | None = None
    kind: auth.Kind | None = None
    expires_at: float | None = None
    disabled: bool | None = None


def _user_info(user: dict[str, Any]) -> dict[str, Any]:
    info = auth.public_code(user)
    info["usage"] = workspace_usage(user["id"])
    return info


def _auth_error(exc: auth.AuthError) -> HTTPException:
    status = {
        "rate_limited": 429,
        "not_found": 404,
        "forbidden": 403,
    }.get(exc.code, 401)
    return HTTPException(status_code=status, detail={"code": exc.code, "message": str(exc)})


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__}


@app.post("/api/auth/login")
def api_login(body: LoginBody, request: Request) -> JSONResponse:
    client = request.client.host if request.client else ""
    try:
        token, user = auth.login(body.code, client)
    except auth.AuthError as exc:
        raise _auth_error(exc) from exc
    response = JSONResponse({"authenticated": True, "user": _user_info(user)})
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=auth.SESSION_MAX_AGE,
        httponly=True,
        secure=https,
        samesite="lax",
        path="/",
    )
    return response


@app.post("/api/auth/logout")
def api_logout(request: Request) -> JSONResponse:
    auth.logout(request.cookies.get(SESSION_COOKIE))
    response = JSONResponse({"authenticated": False})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@app.get("/api/auth/me")
def api_me(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if not user:
        return {"authenticated": False, "user": None}
    return {"authenticated": True, "user": _user_info(user)}


def _may_rebuild(user: dict[str, Any]) -> bool:
    return user.get("role") == "admin" or bool(perf.value("cache_rebuild_users"))


@app.get("/api/settings")
def get_settings(user: CurrentUser) -> dict[str, Any]:
    values = perf.get()
    return {
        "version": __version__,
        "max_upload_bytes": settings.max_upload_bytes,
        "ttl_hours": settings.ttl_hours,
        # How slide tiles are composited: in the browser (GPU), on the server, or decided per browser.
        "render_mode": values["render_mode"],
        "raster_max_pixels": values["raster_max_mpx"] * 1_000_000,
        # Previews kept by the browser (IndexedDB), see Settings → Performance.
        "local_cache": values["local_cache"],
        "local_cache_auto": values["local_cache"] and values["local_cache_auto"],
        "local_cache_bytes": values["local_cache_mb"] * 1024 * 1024,
        "cache_rebuild": _may_rebuild(user),
    }


# --- admin: performance -----------------------------------------------------------


def _performance_view() -> dict[str, Any]:
    return {"values": perf.get(), "schema": perf.schema(), "status": perf.status()}


@app.get("/api/admin/performance")
def api_admin_performance(_admin: AdminUser) -> dict[str, Any]:
    return _performance_view()


@app.put("/api/admin/performance")
def api_admin_update_performance(body: dict[str, Any], _admin: AdminUser) -> dict[str, Any]:
    try:
        perf.update(body)
    except perf.PerfError as exc:
        raise HTTPException(status_code=400, detail={"code": "bad_setting", "message": str(exc)}) from exc
    return _performance_view()


@app.post("/api/admin/performance/reset")
def api_admin_reset_performance(_admin: AdminUser) -> dict[str, Any]:
    perf.reset()
    return _performance_view()


def _gated(job, *args) -> None:
    """Run an export job once the export gate (Settings → Performance) lets it."""
    with perf.export_slot():
        job(*args)


# --- admin: access codes ----------------------------------------------------


def _admin_code_view(rec: dict[str, Any]) -> dict[str, Any]:
    out = auth.public_code(rec, reveal=True)
    out["usage"] = workspace_usage(rec["id"])
    return out


@app.get("/api/admin/codes")
def api_admin_codes(_admin: AdminUser) -> dict[str, Any]:
    return {
        "codes": [_admin_code_view(rec) for rec in auth.list_codes()],
        "ttl_hours": settings.ttl_hours,
    }


@app.post("/api/admin/codes")
def api_admin_create_code(body: CodeCreate, _admin: AdminUser) -> dict[str, Any]:
    if body.expires_at is not None and body.expires_at <= time.time():
        raise HTTPException(status_code=400, detail={"code": "bad_expiry", "message": "Expiry must be in the future."})
    return _admin_code_view(auth.create_code(label=body.label, kind=body.kind, expires_at=body.expires_at))


@app.patch("/api/admin/codes/{code_id}")
def api_admin_update_code(code_id: str, body: CodePatch, _admin: AdminUser) -> dict[str, Any]:
    # Only fields sent by the client change; an explicit `"expires_at": null` means "never expires".
    changes = {field: getattr(body, field) for field in body.model_fields_set}
    try:
        rec = auth.update_code(code_id, changes)
    except auth.AuthError as exc:
        raise _auth_error(exc) from exc
    purge_expired()
    return _admin_code_view(rec)


@app.post("/api/admin/codes/{code_id}/regenerate")
def api_admin_regenerate_code(code_id: str, _admin: AdminUser) -> dict[str, Any]:
    try:
        return _admin_code_view(auth.regenerate_code(code_id))
    except auth.AuthError as exc:
        raise _auth_error(exc) from exc


@app.delete("/api/admin/codes/{code_id}")
def api_admin_delete_code(code_id: str, _admin: AdminUser) -> dict[str, str]:
    try:
        auth.delete_code(code_id)
    except auth.AuthError as exc:
        raise _auth_error(exc) from exc
    delete_workspace(code_id)
    return {"id": code_id, "status": "deleted"}


class TransferBody(BaseModel):
    source: str
    target: str
    file_ids: list[str] = []
    folders: list[str] = []
    target_folder: str = ""
    mode: Literal["copy", "move"] = "copy"
    conflict: Literal["skip", "replace"] = "skip"


def _known_code(code_id: str) -> dict[str, Any]:
    rec = auth.get_code(code_id)
    if rec is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Access code not found."})
    return rec


@app.get("/api/admin/workspaces/{code_id}")
def api_admin_workspace(code_id: str, _admin: AdminUser) -> dict[str, Any]:
    _known_code(code_id)
    return _workspace_listing(code_id)


@app.post("/api/admin/transfer")
def api_admin_transfer(body: TransferBody, _admin: AdminUser) -> dict[str, Any]:
    """Copy or move files/folders between any two workspaces (or within one)."""
    _known_code(body.source)
    _known_code(body.target)
    if not body.file_ids and not body.folders:
        raise HTTPException(status_code=400, detail={"code": "empty", "message": "Select files or folders first."})
    try:
        result = transfer(
            body.source,
            body.target,
            file_ids=body.file_ids,
            folders=body.folders,
            target_folder=body.target_folder,
            mode=body.mode,
            conflict=body.conflict,
        )
    except PathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File or folder not found."}) from exc
    for file_id in result["files"]:
        prepare.schedule(file_id)
    result.pop("files")
    return result


# --- workspace --------------------------------------------------------------

_SUMMARY_KEYS = (
    "id", "name", "folder", "format", "levels", "size_bytes", "status", "error", "version", "dtype",
    "shape", "axes", "width", "height", "channels", "voxel_um",
    "objective", "magnification", "na", "acquired", "instrument",
    "software", "bits_significant", "is_rgb", "created_at", "prepare", "prepared_at",
    "cropped", "crop",
)


def _workspace_listing(owner_id: str) -> dict[str, Any]:
    files = [{k: rec.get(k) for k in _SUMMARY_KEYS} for rec in list_files(owner_id)]
    for item in files:
        item["folder"] = item.get("folder") or ""
    return {"files": files, "folders": list_folders(owner_id)}


@app.get("/api/files")
def api_list_files(owner_id: Owner) -> dict[str, Any]:
    return _workspace_listing(owner_id)


@app.post("/api/folders")
def api_create_folder(body: FolderBody, owner_id: Owner) -> dict[str, str]:
    try:
        return {"path": create_folder(owner_id, body.path)}
    except PathError as exc:
        raise _bad_path(exc) from exc


@app.post("/api/folders/rename")
def api_rename_folder(body: FolderRename, owner_id: Owner) -> dict[str, str]:
    old = _folder_arg(body.path)
    if old not in list_folders(owner_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Folder not found."})
    try:
        return {"path": rename_folder(owner_id, old, body.new_path)}
    except PathError as exc:
        raise _bad_path(exc) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail={"code": "exists", "message": "A folder with this name already exists."}) from exc


@app.post("/api/folders/delete")
def api_delete_folder(body: FolderBody, owner_id: Owner) -> dict[str, Any]:
    folder = _folder_arg(body.path)
    if folder not in list_folders(owner_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Folder not found."})
    try:
        removed = delete_folder(owner_id, folder)
    except PathError as exc:
        raise _bad_path(exc) from exc
    return {"path": folder, "removed_files": removed}


@app.post("/api/files")
async def api_upload(owner_id: Owner, folder: str = "", file: UploadFile = File(...)) -> dict[str, Any]:
    name = _source_name(file.filename)
    target = _folder_arg(folder)
    tmp = settings.staging_dir / f"{uuid.uuid4().hex}.nd2"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    with tmp.open("wb") as fh:
        while True:
            chunk = await file.read(8 * 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.max_upload_bytes:
                fh.close()
                tmp.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail={"code": "too_large", "message": "File exceeds upload limit."})
            fh.write(chunk)
    try:
        rec = await run_in_threadpool(_ingest_file, tmp, name, owner_id, size, target)
    finally:
        tmp.unlink(missing_ok=True)
    return _public(rec)


@app.post("/api/uploads/init")
def api_chunk_init(body: ChunkInit, owner_id: Owner) -> dict[str, str]:
    name = _source_name(body.filename)
    folder = _folder_arg(body.folder)
    if body.size > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail={"code": "too_large", "message": "File exceeds upload limit."})
    upload_id = uuid.uuid4().hex
    dest = settings.staging_dir / upload_id
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "meta.json").write_text(
        json.dumps({"filename": name, "folder": folder, "size": body.size, "_owner": owner_id}),
        encoding="utf-8",
    )
    (dest / "source.partial").touch()
    return {"upload_id": upload_id}


@app.put("/api/uploads/{upload_id}/chunk")
async def api_chunk(
    upload_id: str,
    owner_id: Owner,
    offset: int = 0,
    file: UploadFile = File(...),
) -> dict[str, int]:
    dest_dir, _ = _need_upload(upload_id, owner_id)
    dest = dest_dir / "source.partial"
    if not dest.is_file():
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
    if offset < 0 or offset > settings.max_upload_bytes:
        raise HTTPException(status_code=400, detail={"code": "bad_offset", "message": "Invalid chunk offset."})
    data = await file.read()
    with dest.open("r+b") as fh:
        if offset > dest.stat().st_size:
            fh.seek(offset - 1)
            fh.write(b"\0")
        fh.seek(offset)
        fh.write(data)
        size = fh.seek(0, 2)
    if size > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail={"code": "too_large", "message": "File exceeds upload limit."})
    return {"received": size}


@app.post("/api/uploads/{upload_id}/complete")
def api_chunk_complete(upload_id: str, owner_id: Owner) -> dict[str, Any]:
    dest_dir, meta = _need_upload(upload_id, owner_id)
    partial = dest_dir / "source.partial"
    if not partial.exists():
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
    name = _source_name(meta.get("filename"))
    folder = _folder_arg(meta.get("folder"))
    try:
        rec = _ingest_file(partial, name, owner_id, partial.stat().st_size, folder)
    finally:
        shutil.rmtree(dest_dir, ignore_errors=True)
    return _public(rec)


class RebuildBody(BaseModel):
    file_ids: list[str] = []
    folders: list[str] = []


@app.post("/api/cache/rebuild")
def api_rebuild_cache(body: RebuildBody, user: CurrentUser) -> dict[str, int]:
    """Prepare the previews of these files (and of every file below these folders) again."""
    if not _may_rebuild(user):
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Rebuilding caches is turned off."})
    owner_id = user["id"]
    ids: list[str] = []
    for raw in body.folders:
        folder = _folder_arg(raw)
        if folder and folder not in list_folders(owner_id):
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Folder not found."})
        ids.extend(rec["id"] for rec in files_in_folder(owner_id, folder))
    for file_id in body.file_ids:
        _owned_file(file_id, owner_id)
        ids.append(file_id)
    # Files still being imported or that failed to import have nothing to rebuild.
    ready = [file_id for file_id in dict.fromkeys(ids) if (get_owned_file(file_id, owner_id) or {}).get("status") == "ready"]
    return {"count": prepare.rebuild(ready)}


@app.get("/api/files/{file_id}")
def api_file(file_id: str, owner_id: Owner) -> dict[str, Any]:
    _need(file_id, owner_id)
    return _public(get_file_detail(file_id, owner_id) or {})


@app.patch("/api/files/{file_id}")
def api_update_file(file_id: str, body: FilePatch, owner_id: Owner) -> dict[str, Any]:
    rec = _owned_file(file_id, owner_id)
    if rec.get("format") == "lif":
        # Images of a LIF project are named by LAS X and carry no file extension.
        try:
            name = normalize_filename(body.name) if body.name is not None else rec.get("name")
        except PathError as exc:
            raise _bad_path(exc) from exc
    else:
        name = _source_name(body.name) if body.name is not None else rec.get("name")
        if not rec.get("cropped") and (ometiff.is_tiff_name(name) != prepare.is_slide(rec) or lifio.is_lif_name(name)):
            raise HTTPException(status_code=400, detail={"code": "bad_extension", "message": "Keep the file extension when renaming."})
    folder = _folder_arg(body.folder) if body.folder is not None else rec.get("folder") or ""
    clash = find_file(owner_id, folder, name)
    if clash and clash["id"] != file_id:
        raise HTTPException(status_code=409, detail={"code": "exists", "message": "A file with this name already exists here."})
    updated = update_file(file_id, owner_id, {"name": name, "folder": folder})
    return _public(updated or rec)


def _unique_filename(owner_id: str, folder: str, desired: str) -> str:
    if not find_file(owner_id, folder, desired):
        return desired
    lower = desired.lower()
    ext = ""
    for suffix in (".ome.tiff", ".ome.tif", ".tiff", ".tif", ".nd2", ".lif"):
        if lower.endswith(suffix):
            ext = desired[-len(suffix) :]
            stem = desired[: -len(suffix)]
            break
    else:
        stem = desired
    n = 2
    while True:
        candidate = f"{stem} ({n}){ext}"
        if not find_file(owner_id, folder, candidate):
            return candidate
        n += 1


@app.post("/api/files/{file_id}/crop")
def api_crop_file(file_id: str, body: CropRequest, owner_id: Owner) -> dict[str, Any]:
    rec = _need(file_id, owner_id)
    detail = get_file_detail(file_id, owner_id) or dict(rec)
    src_w = int(rec.get("width") or 0)
    src_h = int(rec.get("height") or 0)
    if src_w < 2 or src_h < 2:
        raise HTTPException(status_code=400, detail={"code": "bad_crop", "message": "Source image dimensions are invalid."})
    x = max(0, min(int(body.x), src_w - 2))
    y = max(0, min(int(body.y), src_h - 2))
    w = max(2, min(int(body.w), src_w - x))
    h = max(2, min(int(body.h), src_h - y))

    folder = _folder_arg(body.folder) if body.folder is not None else (rec.get("folder") or "")
    orig_name = str(rec.get("name") or "image.nd2")
    fmt = rec.get("format") or "nd2"

    if body.name and body.name.strip():
        try:
            raw_name = normalize_filename(body.name.strip())
        except PathError as exc:
            raise _bad_path(exc) from exc
    else:
        lower = orig_name.lower()
        stem = orig_name
        for suffix in (".ome.tiff", ".ome.tif", ".tiff", ".tif", ".nd2", ".lif"):
            if lower.endswith(suffix):
                stem = orig_name[: -len(suffix)]
                break
        if fmt == "lif":
            raw_name = f"{stem}_crop_{w}x{h}"
        elif fmt in ("ome-tiff", "tiff"):
            raw_name = f"{stem}_crop_{w}x{h}.ome.tif"
        else:
            raw_name = f"{stem}_crop_{w}x{h}.nd2"

    if fmt == "lif":
        final_name = _unique_filename(owner_id, folder, raw_name)
    elif fmt in ("ome-tiff", "tiff"):
        if not ometiff.is_tiff_name(raw_name):
            raw_name = f"{raw_name}.ome.tif"
        final_name = _unique_filename(owner_id, folder, raw_name)
    else:
        if not raw_name.lower().endswith(".nd2"):
            raw_name = f"{raw_name}.nd2"
        final_name = _unique_filename(owner_id, folder, raw_name)

    new_id = uuid.uuid4().hex
    src_dir = file_dir(file_id)
    dst_dir = file_dir(new_id)
    src_file = src_dir / "source.nd2"
    dst_file = dst_dir / "source.nd2"
    voxel = list(rec.get("voxel_um") or [1.0, 1.0, 1.0])
    channels = [dict(ch) for ch in (rec.get("channels") or [])]

    try:
        if prepare.is_slide(rec):
            slide = prepare.ensure_slide(file_id, src_file)
            lv_idx = 0
            for idx, lv in enumerate(slide.levels):
                ds = slide.width / max(lv.width, 1)
                if max(w / ds, h / ds) <= 4096 or idx == len(slide.levels) - 1:
                    lv_idx = idx
                    break
            lv = slide.levels[lv_idx]
            ds_x = slide.width / max(lv.width, 1)
            ds_y = slide.height / max(lv.height, 1)
            lx = max(0, min(int(round(x / ds_x)), lv.width - 1))
            ly = max(0, min(int(round(y / ds_y)), lv.height - 1))
            lw = max(2, min(int(round(w / ds_x)), lv.width - lx))
            lh = max(2, min(int(round(h / ds_y)), lv.height - ly))
            planes = [
                ometiff.read_region(slide, lv_idx, c, lx, ly, lw, lh, t=int(body.t), z=int(body.z))
                for c in range(slide.n_channels)
            ]
            if len(voxel) >= 2:
                voxel = [float(voxel[0]) * ds_x, float(voxel[1]) * ds_y, *(voxel[2:] or [1.0])]
            names = [str(ch.get("name") or f"C{i}") for i, ch in enumerate(channels)]
            colors = [list(ch.get("color") or [255, 255, 255]) for ch in channels]
            _write_ome_tiff(dst_file, planes, names, colors, voxel, rec.get("bits_significant"))
            w, h = lw, lh
            abs_x, abs_y = x, y
            size_bytes = dst_file.stat().st_size
            axes = [{"name": "C", "size": len(planes)}, {"name": "Y", "size": h}, {"name": "X", "size": w}]
            sizes = {"C": len(planes), "Y": h, "X": w}
            shape = [len(planes), h, w]
        else:
            _link_or_copy(src_file, dst_file)
            if (src_dir / lifio.SIDECAR).is_file():
                shutil.copy2(src_dir / lifio.SIDECAR, dst_dir / lifio.SIDECAR)
            prev_crop = read_crop(src_file)
            abs_x = (prev_crop[0] if prev_crop else 0) + x
            abs_y = (prev_crop[1] if prev_crop else 0) + y
            write_crop(dst_dir, abs_x, abs_y, w, h)
            orig_area = max(src_w * src_h, 1)
            size_bytes = max(1024, int(round(float(rec.get("size_bytes") or 0) * ((w * h) / orig_area))))
            old_sizes = dict(detail.get("sizes") or {})
            for ax_info in rec.get("axes") or []:
                old_sizes.setdefault(ax_info["name"], ax_info["size"])
            sizes = dict(old_sizes)
            for k in list(sizes.keys()):
                if k.upper() == "X":
                    sizes[k] = w
                elif k.upper() == "Y":
                    sizes[k] = h
            if not any(k.upper() == "X" for k in sizes):
                sizes["X"] = w
            if not any(k.upper() == "Y" for k in sizes):
                sizes["Y"] = h
            axes = [{"name": k, "size": int(v)} for k, v in sizes.items()]
            shape = [int(v) for v in sizes.values()]

        now = time.time()
        text_info = dict(detail.get("text_info") or {})
        text_info["Crop region"] = f"x={abs_x}, y={abs_y}, w={w}, h={h} (from {orig_name})"
        groups = dict(detail.get("groups") or {})
        if "file" in groups and isinstance(groups["file"], dict):
            groups["file"] = {
                **groups["file"],
                "name": final_name,
                "shape": shape,
                "axes": axes,
                "crop": {"x": abs_x, "y": abs_y, "w": w, "h": h, "source": orig_name},
            }

        new_rec: dict[str, Any] = {
            **detail,
            "id": new_id,
            "name": final_name,
            "folder": folder,
            "format": fmt,
            "size_bytes": size_bytes,
            "status": "ready",
            "error": None,
            "width": w,
            "height": h,
            "axes": axes,
            "sizes": sizes,
            "shape": shape,
            "voxel_um": voxel,
            "channels": channels,
            "created_at": now,
            "_owner": owner_id,
            "cropped": True,
            "crop": {
                "x": abs_x,
                "y": abs_y,
                "w": w,
                "h": h,
                "source_id": file_id,
                "source_name": orig_name,
            },
            "text_info": text_info,
            "groups": groups,
            "prepare": "pending",
        }
        new_rec.pop("levels", None)
        upsert_file(new_rec)
        prepare.get(new_id, new_rec, dst_file, "display", (0, 0, 0))
        ready_at = round(time.time(), 3)
        updated = update_file(new_id, owner_id, {"prepare": "ready", "prepared_at": ready_at})
        return _public(updated or {**new_rec, "prepare": "ready", "prepared_at": ready_at})
    except Exception:
        remove_file_data(new_id)
        raise


@app.delete("/api/files/{file_id}")
def api_delete(file_id: str, owner_id: Owner) -> dict[str, str]:
    _owned_file(file_id, owner_id)
    delete_file(file_id, owner_id)
    return {"id": file_id, "status": "deleted"}


def _planes(file_id: str, owner_id: str, t: int, z: int, p: int):
    rec = _need_nd2(file_id, owner_id)
    handle = open_nd2(source_path(file_id))
    planes, sizes = extract_channels(handle, t=t, z=z, p=p)
    return rec, handle, planes, sizes


@app.get("/api/files/{file_id}/preview")
def api_preview(
    file_id: str,
    owner_id: Owner,
    t: int = 0,
    z: int = 0,
    p: int = 0,
    composite: bool = True,
    scale_bar: bool = True,
    format: str = "jpeg",
    quality: int = 88,
    visible: str | None = None,
) -> Response:
    rec = _need(file_id, owner_id)
    if prepare.is_slide(rec):
        planes = ometiff.overview_planes(prepare.ensure_slide(file_id, source_path(file_id)), t=t, z=z)
    else:
        rec, _, planes, _ = _planes(file_id, owner_id, t, z, p)
    vis = parse_visible_mask(visible, len(planes))
    rgb = preview_rgb(
        planes,
        rec.get("channels") or [],
        composite=composite,
        scale_bar=scale_bar,
        visible=vis,
        voxel_um=rec.get("voxel_um"),
    )
    fmt = "png" if format == "png" else "jpeg"
    payload = encode_image(rgb, fmt, quality)
    media = "image/png" if fmt == "png" else "image/jpeg"
    return Response(content=payload, media_type=media)


def _gzip_response(request: Request, body: bytes) -> Response:
    headers = {"Vary": "Accept-Encoding"}
    if "gzip" in request.headers.get("accept-encoding", ""):
        headers["Content-Encoding"] = "gzip"
        return Response(content=body, media_type="application/octet-stream", headers=headers)
    return Response(content=gzip.decompress(body), media_type="application/octet-stream", headers=headers)


def _prepared(file_id: str, owner_id: str, kind: str, t: int, z: int, p: int) -> Any:
    rec = _need(file_id, owner_id)
    coords = (max(t, 0), max(z, 0), max(p, 0))
    return prepare.get(file_id, rec, source_path(file_id), kind, coords)


@app.get("/api/files/{file_id}/display")
def api_display(
    file_id: str,
    request: Request,
    owner_id: Owner,
    t: int = 0,
    z: int = 0,
    p: int = 0,
    wire: Literal["auto", "gzip"] = "auto",
) -> Response:
    """8-bit, auto-contrasted channels for the workspace preview (same layout as /plane).

    `wire=gzip` sends the stored gzip file as is (application/gzip): browsers keep it compressed
    in their local cache and decompress it themselves."""
    body = _prepared(file_id, owner_id, "display", t, z, p)
    if wire == "gzip":
        return Response(content=body, media_type="application/gzip")
    return _gzip_response(request, body)


@app.get("/api/files/{file_id}/plane")
def api_plane(file_id: str, request: Request, owner_id: Owner, t: int = 0, z: int = 0, p: int = 0) -> Response:
    body = _prepared(file_id, owner_id, "plane", t, z, p)
    return _gzip_response(request, body)


@app.get("/api/files/{file_id}/histogram")
def api_histogram(
    file_id: str,
    owner_id: Owner,
    t: int = 0,
    z: int = 0,
    p: int = 0,
    c: int = 0,
) -> dict[str, Any]:
    rec, _, planes, _ = _planes(file_id, owner_id, t, z, p)
    if c < 0 or c >= len(planes):
        raise HTTPException(status_code=400, detail={"code": "bad_channel", "message": "Channel index out of range."})
    bits = rec.get("bits_significant") or 16
    return histogram(planes[c], vmax=float(2 ** bits - 1))


@app.get("/api/files/{file_id}/autoscale")
def api_autoscale(file_id: str, owner_id: Owner, t: int = 0, z: int = 0, p: int = 0) -> dict[str, Any]:
    return _prepared(file_id, owner_id, "autoscale", t, z, p)


@app.get("/api/files/{file_id}/projection")
def api_projection(
    file_id: str,
    owner_id: Owner,
    axis: str = "Z",
    mode: str = "max",
    t: int = 0,
    z: int = 0,
    p: int = 0,
    scale_bar: bool = True,
) -> Response:
    rec = _need_nd2(file_id, owner_id)
    handle = open_nd2(source_path(file_id))
    if axis_size(handle.sizes, axis.upper()) <= 1:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_axis", "message": f"This file has no {axis.upper()} dimension to project."},
        )
    planes = projection(handle, axis=axis, mode=mode, t=t, z=z, p=p)
    rgb = preview_rgb(
        planes,
        rec.get("channels") or [],
        composite=True,
        scale_bar=scale_bar,
        voxel_um=rec.get("voxel_um"),
    )
    return Response(content=encode_image(rgb, "jpeg", 88), media_type="image/jpeg")


@app.get("/api/files/{file_id}/tiles")
def api_tiles(
    file_id: str,
    owner_id: Owner,
    axis: str = "Z",
    t: int = 0,
    p: int = 0,
    max_tiles: int = 24,
) -> dict[str, Any]:
    rec = _need_nd2(file_id, owner_id)
    handle = open_nd2(source_path(file_id))
    n = axis_size(handle.sizes, axis.upper())
    step = max(1, n // max_tiles)
    indices = list(range(0, n, step))[:max_tiles]
    return {
        "axis": axis.upper(),
        "size": n,
        "indices": indices,
        "width": rec.get("width"),
        "height": rec.get("height"),
    }


@app.post("/api/files/{file_id}/measure")
def api_measure(file_id: str, body: MeasureRequest, owner_id: Owner) -> dict[str, Any]:
    rec, _, planes, _ = _planes(file_id, owner_id, body.t, body.z, body.p)
    names = [c.get("name") or f"C{i}" for i, c in enumerate(rec.get("channels") or [])]
    voxel = rec.get("voxel_um") or [0, 0, 0]
    um = float(voxel[0]) if voxel else 0
    if body.channel is not None:
        if body.channel < 0 or body.channel >= len(planes):
            raise HTTPException(status_code=400, detail={"code": "bad_channel", "message": "Channel index out of range."})
        planes = [planes[body.channel]]
        names = [names[body.channel]] if body.channel < len(names) else names
    result = measure_planes(planes, names, body.tool, body.points, um)
    if body.tool == "line" and len(body.points) >= 2:
        x0, y0 = body.points[0]
        x1, y1 = body.points[1]
        profiles = []
        for i, plane in enumerate(planes):
            prof = line_profile(plane, x0, y0, x1, y1)
            prof["name"] = names[i] if i < len(names) else f"C{i}"
            if um:
                prof["distance_um"] = prof["distance_px"] * um
            profiles.append(prof)
        result["profiles"] = profiles
    return result


@app.get("/api/files/{file_id}/orthogonal")
def api_orthogonal(
    file_id: str,
    owner_id: Owner,
    t: int = 0,
    z: int = 0,
    p: int = 0,
    x: int | None = None,
    y: int | None = None,
) -> dict[str, Any]:
    rec = _need_nd2(file_id, owner_id)
    handle = open_nd2(source_path(file_id))
    sizes = handle.sizes
    n_z = axis_size(sizes, "Z")
    if n_z <= 1:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_z", "message": "Orthogonal slices need a Z stack."},
        )
    w = rec.get("width") or axis_size(sizes, "X")
    h = rec.get("height") or axis_size(sizes, "Y")
    cx = w // 2 if x is None else int(x)
    cy = h // 2 if y is None else int(y)
    return {"z": n_z, "x": cx, "y": cy, "width": w, "height": h}


# --- whole-slide (OME-TIFF) viewer --------------------------------------------------


def _tile_cache_control(version: str) -> str:
    """Tiles never change for a file. With the cache version in the URL (and the local cache on)
    browsers may keep them for a week; otherwise for the session, as before."""
    if version and perf.value("local_cache"):
        return "private, max-age=604800"
    return "private, max-age=3600"


@app.get("/api/files/{file_id}/slide")
def api_slide(file_id: str, owner_id: Owner) -> dict[str, Any]:
    """Resolution levels and tile grid for the slide viewer (builds missing pyramid levels first)."""
    rec = _need_slide(file_id, owner_id)
    slide = prepare.ensure_slide(file_id, source_path(file_id))
    limits = _prepared(file_id, owner_id, "autoscale", 0, 0, 0)
    return {
        "id": file_id,
        "width": slide.width,
        "height": slide.height,
        "tile_size": ometiff.TILE,
        "dtype": str(slide.dtype),
        "levels": ometiff.describe_levels(slide),
        "sizes": {"T": slide.axis_len("T"), "Z": slide.axis_len("Z"), "C": slide.n_channels},
        "channels": rec.get("channels") or [],
        "autoscale": limits.get("channels") or [],
        "um_per_px": (rec.get("voxel_um") or [None])[0],
        "magnification": rec.get("magnification"),
        # Tile URLs carry it, so browsers may keep tiles until the cache is rebuilt.
        "version": rec.get("prepared_at") or rec.get("created_at") or 0,
    }


@app.get("/api/files/{file_id}/slide/tile")
def api_slide_tile(
    file_id: str,
    request: Request,
    owner_id: Owner,
    level: int,
    x: int,
    y: int,
    c: str = "",
    t: int = 0,
    z: int = 0,
    v: str = "",
) -> Response:
    """Native-value channels of one TILE x TILE viewer tile (packed planes, gzip)."""
    rec = _need_slide(file_id, owner_id)
    slide = prepare.ensure_slide(file_id, source_path(file_id))
    if not 0 <= level < len(slide.levels):
        raise HTTPException(status_code=400, detail={"code": "bad_level", "message": "Resolution level out of range."})
    try:
        channels = [int(v) for v in c.split(",") if v.strip()] if c else list(range(slide.n_channels))
    except ValueError:
        channels = []
    if not channels or any(ch < 0 or ch >= slide.n_channels for ch in channels):
        raise HTTPException(status_code=400, detail={"code": "bad_channel", "message": "Channel index out of range."})
    try:
        planes = ometiff.tile_planes(slide, level, x, y, channels, t=t, z=z)
    except SlideError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc
    meta = rec.get("channels") or []
    body = gzip.compress(pack_planes(planes, [meta[ch] if ch < len(meta) else {} for ch in channels]), compresslevel=1)
    response = _gzip_response(request, body)
    response.headers["Cache-Control"] = _tile_cache_control(v)
    return response


@app.get("/api/files/{file_id}/slide/render")
def api_slide_render(
    file_id: str,
    owner_id: Owner,
    level: int,
    x: int,
    y: int,
    d: str = "",
    t: int = 0,
    z: int = 0,
    v: str = "",
) -> Response:
    """A viewer tile composited on the server (render mode "server"), as JPEG.

    `d` lists the visible channels as `channel,min,max,gamma,rrggbb` separated by `;`."""
    _need_slide(file_id, owner_id)
    slide = prepare.ensure_slide(file_id, source_path(file_id))
    if not 0 <= level < len(slide.levels):
        raise HTTPException(status_code=400, detail={"code": "bad_level", "message": "Resolution level out of range."})
    try:
        layers = slide_render.parse_layers(d, slide.n_channels)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "bad_display", "message": "Malformed display settings."}) from exc
    try:
        body = slide_render.render_tile(
            file_id, slide, level, x, y, layers, t=t, z=z, quality=perf.value("server_tile_quality")
        )
    except SlideError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc
    # The URL carries the display settings, so a tile at a URL never changes.
    return Response(content=body, media_type="image/jpeg", headers={"Cache-Control": _tile_cache_control(v)})


@app.post("/api/files/{file_id}/slide/export")
def api_slide_export(
    file_id: str,
    body: SlideExportRequest,
    background: BackgroundTasks,
    owner_id: Owner,
) -> dict[str, Any]:
    rec = _need_slide(file_id, owner_id)
    slide = prepare.ensure_slide(file_id, source_path(file_id))
    try:
        planned = plan_slide_export(slide, body, rec.get("voxel_um"))
    except SlideExportError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc
    job_id = new_job_id()
    upsert_job(
        {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "message": "Queued",
            "created_at": time.time(),
            "download_name": None,
            "error": None,
            "format": f"slide · {body.format}",
            "file_ids": [file_id],
            "label": rec.get("name"),
            "_owner": owner_id,
        }
    )
    background.add_task(_gated, run_slide_export, job_id, file_id, body, owner_id)
    return {"id": job_id, "status": "queued", "width": planned.width, "height": planned.height}


def _resolve_export(body: ExportRequest, owner_id: str) -> tuple[list[str], str | None]:
    ids: list[str] = []
    label = body.label
    for raw in body.folders:
        folder = _folder_arg(raw)
        if folder and folder not in list_folders(owner_id):
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Folder not found."})
        # Slides are exported region by region from the slide viewer, not in batches.
        ids.extend(rec["id"] for rec in files_in_folder(owner_id, folder) if not prepare.is_slide(rec))
        if label is None and len(body.folders) == 1 and folder:
            label = folder.rsplit("/", 1)[-1]
    ids.extend(body.file_ids)
    unique = list(dict.fromkeys(ids))
    for fid in unique:
        _need_nd2(fid, owner_id)
    return unique, label


@app.post("/api/export")
def api_export(body: ExportRequest, background: BackgroundTasks, owner_id: Owner) -> dict[str, Any]:
    file_ids, label = _resolve_export(body, owner_id)
    if not file_ids:
        raise HTTPException(status_code=400, detail={"code": "empty", "message": "There are no ND2 files to export."})
    body = body.model_copy(update={"file_ids": file_ids, "folders": [], "label": label})
    job_id = new_job_id()
    upsert_job(
        {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "message": "Queued",
            "created_at": time.time(),
            "download_name": None,
            "error": None,
            "format": body.format,
            "file_ids": file_ids,
            "label": label,
            "_owner": owner_id,
        }
    )
    background.add_task(_gated, run_export, job_id, body, owner_id)
    return {"id": job_id, "status": "queued", "file_count": len(file_ids)}


@app.get("/api/jobs")
def api_jobs(owner_id: Owner) -> dict[str, Any]:
    return {"jobs": [_public(job) for job in list_jobs(owner_id)[:50]]}


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str, owner_id: Owner) -> dict[str, Any]:
    job = get_owned_job(job_id, owner_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found."})
    return _public(job)


@app.get("/api/jobs/{job_id}/events")
async def api_job_events(job_id: str, owner_id: Owner) -> StreamingResponse:
    if not get_owned_job(job_id, owner_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found."})

    async def gen():
        last = None
        for _ in range(600):
            job = get_owned_job(job_id, owner_id)
            if not job:
                break
            payload = json.dumps(_public(job))
            if payload != last:
                yield f"data: {payload}\n\n"
                last = payload
            if job.get("status") in {"done", "error"}:
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/jobs/{job_id}/download")
def api_job_download(job_id: str, owner_id: Owner) -> FileResponse:
    job = get_owned_job(job_id, owner_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found."})
    if job.get("status") != "done":
        raise HTTPException(status_code=409, detail={"code": "not_ready", "message": "Export is not finished."})
    zip_path = Path(job.get("zip_path") or (settings.exports_dir / (job.get("download_name") or "")))
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail={"code": "missing", "message": "Export file missing."})
    name = job.get("download_name") or zip_path.name
    return FileResponse(zip_path, filename=name, media_type=_DOWNLOAD_TYPES.get(Path(name).suffix.lower(), "application/octet-stream"))


_DOWNLOAD_TYPES = {".zip": "application/zip", ".tif": "image/tiff", ".png": "image/png", ".jpg": "image/jpeg"}


# Vite puts content-hashed bundles under /assets: their URL changes whenever their content does.
_IMMUTABLE = "public, max-age=31536000, immutable"
# index.html must be revalidated on every load, otherwise browsers/CDNs keep an old page that points
# at bundles which no longer exist after a redeploy (blank page).
_REVALIDATE = "no-cache"


def _index_response() -> Response:
    index = FRONTEND_DIST / "index.html"
    if not index.exists():
        return JSONResponse({"ok": True, "frontend": False})
    return FileResponse(index, headers={"Cache-Control": _REVALIDATE})


@app.get("/{full_path:path}")
def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "API route not found."})
    if not FRONTEND_DIST.exists():
        return {"ok": True, "frontend": False, "docs": "/api/docs"}
    candidate = (FRONTEND_DIST / full_path).resolve()
    try:
        candidate.relative_to(FRONTEND_DIST.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid path") from exc
    if full_path and candidate.is_file() and candidate.name != "index.html":
        cache = _IMMUTABLE if full_path.startswith("assets/") else "public, max-age=3600"
        return FileResponse(candidate, headers={"Cache-Control": cache})
    if full_path.startswith("assets/") or Path(full_path).suffix in {".js", ".css", ".map", ".woff2", ".svg", ".png"}:
        # A missing bundle must fail loudly. Answering with index.html (200, text/html) makes the
        # browser - and Cloudflare, which caches by extension - store HTML as the "script".
        return Response(status_code=404, headers={"Cache-Control": "no-store"})
    return _index_response()
