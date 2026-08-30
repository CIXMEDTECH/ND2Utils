from __future__ import annotations

import asyncio
import json
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from nd2utils import __version__
from nd2utils.config import ensure_dirs, repo_root, settings
from nd2utils.export_jobs import new_job_id, run_export
from nd2utils.models import ExportRequest, MeasureRequest
from nd2utils.nd2io import (
    Nd2Error,
    axis_size,
    close_all,
    close_nd2,
    extract_channels,
    identify_path,
    open_nd2,
    pack_planes,
    projection,
)
from nd2utils.render import (
    autoscale_limits,
    encode_image,
    histogram,
    line_profile,
    measure_planes,
    parse_visible_mask,
    preview_rgb,
)
from nd2utils.store import (
    delete_file_record,
    file_dir,
    get_file,
    get_job,
    list_files,
    load_jobs,
    purge_expired,
    source_path,
    upsert_file,
    upsert_job,
)

FRONTEND_DIST = repo_root() / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_dirs()
    purge_expired()
    yield
    close_all()


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


def _raise_nd2(exc: Nd2Error) -> None:
    status = 400 if exc.code in {"not_nd2", "parse_failed", "empty"} else 500
    raise HTTPException(status_code=status, detail={"code": exc.code, "message": str(exc)})


def _need(file_id: str) -> dict[str, Any]:
    rec = get_file(file_id)
    if not rec:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File not found."})
    if rec.get("status") != "ready":
        raise HTTPException(status_code=409, detail={"code": "not_ready", "message": rec.get("error") or "File is not ready."})
    return rec


def _ingest_file(src: Path, name: str, size_bytes: int | None = None) -> dict[str, Any]:
    file_id = uuid.uuid4().hex
    dest = source_path(file_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
    size = size_bytes if size_bytes is not None else dest.stat().st_size
    if size > settings.max_upload_bytes:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail={"code": "too_large", "message": "File exceeds upload limit."})
    created = time.time()
    try:
        rec = identify_path(dest, file_id, name, size, created)
    except Nd2Error as exc:
        dest.unlink(missing_ok=True)
        _raise_nd2(exc)
    upsert_file(rec)
    return rec


class ChunkInit(BaseModel):
    filename: str
    size: int


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": __version__,
        "max_upload_bytes": settings.max_upload_bytes,
        "ttl_hours": settings.ttl_hours,
    }


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return {
        "max_upload_bytes": settings.max_upload_bytes,
        "ttl_hours": settings.ttl_hours,
    }


@app.get("/api/files")
def api_list_files() -> dict[str, Any]:
    purge_expired()
    items = list_files()
    summaries = []
    for rec in items:
        summaries.append({k: rec.get(k) for k in (
            "id", "name", "size_bytes", "status", "error", "version", "dtype",
            "shape", "axes", "width", "height", "channels", "voxel_um",
            "objective", "magnification", "na", "acquired", "instrument",
            "software", "bits_significant", "is_rgb", "created_at",
        )})
    return {"files": summaries}


@app.post("/api/files")
async def api_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    name = file.filename or "upload.nd2"
    if not name.lower().endswith(".nd2"):
        raise HTTPException(status_code=400, detail={"code": "not_nd2", "message": "Please upload a .nd2 file."})
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
        rec = _ingest_file(tmp, name, size)
    finally:
        tmp.unlink(missing_ok=True)
    return rec


@app.post("/api/uploads/init")
def api_chunk_init(body: ChunkInit) -> dict[str, str]:
    if body.size > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail={"code": "too_large", "message": "File exceeds upload limit."})
    upload_id = uuid.uuid4().hex
    dest = settings.staging_dir / upload_id
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "meta.json").write_text(
        json.dumps({"filename": body.filename, "size": body.size}),
        encoding="utf-8",
    )
    (dest / "source.partial").touch()
    return {"upload_id": upload_id}


@app.put("/api/uploads/{upload_id}/chunk")
async def api_chunk(upload_id: str, offset: int = 0, file: UploadFile = File(...)) -> dict[str, int]:
    dest = settings.staging_dir / upload_id / "source.partial"
    if not dest.parent.exists():
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
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
def api_chunk_complete(upload_id: str) -> dict[str, Any]:
    dest_dir = settings.staging_dir / upload_id
    partial = dest_dir / "source.partial"
    if not partial.exists():
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Upload session missing."})
    meta = json.loads((dest_dir / "meta.json").read_text(encoding="utf-8"))
    name = meta.get("filename") or "upload.nd2"
    rec = _ingest_file(partial, name, partial.stat().st_size)
    shutil.rmtree(dest_dir, ignore_errors=True)
    return rec


@app.get("/api/files/{file_id}")
def api_file(file_id: str) -> dict[str, Any]:
    return _need(file_id)


@app.delete("/api/files/{file_id}")
def api_delete(file_id: str) -> dict[str, str]:
    rec = get_file(file_id)
    if not rec:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File not found."})
    close_nd2(source_path(file_id))
    shutil.rmtree(file_dir(file_id), ignore_errors=True)
    cache = settings.cache_dir / file_id
    shutil.rmtree(cache, ignore_errors=True)
    delete_file_record(file_id)
    return {"id": file_id, "status": "deleted"}


def _planes(file_id: str, t: int, z: int, p: int):
    rec = _need(file_id)
    handle = open_nd2(source_path(file_id))
    planes, sizes = extract_channels(handle, t=t, z=z, p=p)
    return rec, handle, planes, sizes


@app.get("/api/files/{file_id}/preview")
def api_preview(
    file_id: str,
    t: int = 0,
    z: int = 0,
    p: int = 0,
    composite: bool = True,
    scale_bar: bool = True,
    format: str = "jpeg",
    quality: int = 88,
    visible: str | None = None,
) -> Response:
    rec, _, planes, _ = _planes(file_id, t, z, p)
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


@app.get("/api/files/{file_id}/plane")
def api_plane(file_id: str, t: int = 0, z: int = 0, p: int = 0) -> Response:
    rec, _, planes, _ = _planes(file_id, t, z, p)
    payload = pack_planes(planes, rec.get("channels") or [])
    return Response(content=payload, media_type="application/octet-stream")


@app.get("/api/files/{file_id}/histogram")
def api_histogram(file_id: str, t: int = 0, z: int = 0, p: int = 0, c: int = 0) -> dict[str, Any]:
    rec, _, planes, _ = _planes(file_id, t, z, p)
    if c < 0 or c >= len(planes):
        raise HTTPException(status_code=400, detail={"code": "bad_channel", "message": "Channel index out of range."})
    bits = rec.get("bits_significant") or 16
    return histogram(planes[c], vmax=float(2 ** bits - 1))


@app.get("/api/files/{file_id}/autoscale")
def api_autoscale(file_id: str, t: int = 0, z: int = 0, p: int = 0) -> dict[str, Any]:
    rec, _, planes, _ = _planes(file_id, t, z, p)
    items = []
    for i, plane in enumerate(planes):
        lo, hi = autoscale_limits(plane)
        ch = (rec.get("channels") or [{}])[i] if i < len(rec.get("channels") or []) else {}
        items.append(
            {
                "index": i,
                "name": ch.get("name"),
                "min": lo,
                "max": hi,
                "color": ch.get("color"),
            }
        )
    return {"channels": items}


@app.get("/api/files/{file_id}/projection")
def api_projection(
    file_id: str,
    axis: str = "Z",
    mode: str = "max",
    t: int = 0,
    z: int = 0,
    p: int = 0,
    scale_bar: bool = True,
) -> Response:
    rec = _need(file_id)
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
    axis: str = "Z",
    t: int = 0,
    p: int = 0,
    max_tiles: int = 24,
) -> dict[str, Any]:
    rec = _need(file_id)
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
def api_measure(file_id: str, body: MeasureRequest) -> dict[str, Any]:
    rec, _, planes, _ = _planes(file_id, body.t, body.z, body.p)
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
    t: int = 0,
    z: int = 0,
    p: int = 0,
    x: int | None = None,
    y: int | None = None,
) -> dict[str, Any]:
    rec = _need(file_id)
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


@app.post("/api/export")
def api_export(body: ExportRequest, background: BackgroundTasks) -> dict[str, Any]:
    if not body.file_ids:
        raise HTTPException(status_code=400, detail={"code": "empty", "message": "Select at least one file."})
    for fid in body.file_ids:
        _need(fid)
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
            "file_ids": body.file_ids,
        }
    )
    background.add_task(run_export, job_id, body)
    return {"id": job_id, "status": "queued"}


@app.get("/api/jobs")
def api_jobs() -> dict[str, Any]:
    jobs = list(load_jobs().values())
    jobs.sort(key=lambda j: j.get("created_at") or 0, reverse=True)
    return {"jobs": jobs[:50]}


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict[str, Any]:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found."})
    return job


@app.get("/api/jobs/{job_id}/events")
async def api_job_events(job_id: str) -> StreamingResponse:
    if not get_job(job_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found."})

    async def gen():
        last = None
        for _ in range(600):
            job = get_job(job_id) or {}
            payload = json.dumps(job)
            if payload != last:
                yield f"data: {payload}\n\n"
                last = payload
            if job.get("status") in {"done", "error"}:
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/jobs/{job_id}/download")
def api_job_download(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found."})
    if job.get("status") != "done":
        raise HTTPException(status_code=409, detail={"code": "not_ready", "message": "Export is not finished."})
    zip_path = Path(job.get("zip_path") or (settings.exports_dir / (job.get("download_name") or "")))
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail={"code": "missing", "message": "Export file missing."})
    return FileResponse(zip_path, filename=job.get("download_name") or zip_path.name, media_type="application/zip")


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
    if full_path and candidate.is_file():
        return FileResponse(candidate)
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"ok": True, "frontend": False}
