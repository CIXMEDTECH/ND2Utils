"""Statistical analyses of workspace images (v1.1: comet assay, EdU proliferation).

An analysis is a named set of images with parameters and a `type` ("comet" or "edu");
results are stored per image under data/analyses/<analysis id>/<file id>.json (comets with
outlines, head discs, metrics and the ids the user deleted by hand; for EdU the nuclei and
EdU objects, with a small <file id>.stats.json beside it for the statistics). Images are
analysed one at a time on a dedicated thread, so a batch never competes with request threads;
progress lives on the analysis record.

An EdU field may span two files (nuclear stain and EdU stored separately): `file_ids` holds
the primary (nuclear or multi-channel) file of each field and `partners` maps it to the EdU
file. Groups, overrides and results are keyed by the primary file.

`preview()` analyses one image with draft parameters without storing anything, so parameters
can be tuned before a batch runs.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import shutil
import time
import uuid
import zipfile
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Any

import numpy as np

from nd2utils import comet, edu, jsoncache, ometiff, prepare, store
from nd2utils.config import settings
from nd2utils.nd2io import extract_channels, open_nd2

log = logging.getLogger("nd2utils.analyses")

KEY_METRICS = ("TailDNAPercent", "TailMoment", "OliveMoment", "TailLength", "CometLength", "HeadDNAPercent")
MAX_PIXELS = 80_000_000

TYPES = ("comet", "edu")
DEFAULT_NAMES = {"comet": "Comet assay", "edu": "EdU assay"}

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analysis")
_GUARD = Lock()
_RUNNING: dict[str, set[str]] = {}  # analysis id -> files queued or running
# Previews run on request threads; at most two at a time (each may hold a full image).
_PREVIEW = BoundedSemaphore(2)


class NoFields(ValueError):
    """No EdU field (nuclear + EdU channel) among the chosen files."""

    def __init__(self, unpaired: list[dict[str, Any]]):
        super().__init__("No image with both a nuclear and an EdU channel.")
        self.unpaired = unpaired


def rec_type(rec: dict[str, Any]) -> str:
    return "edu" if rec.get("type") == "edu" else "comet"


def params_class(kind: str):
    return edu.EduParams if kind == "edu" else comet.CometParams


# Per-image overrides: everything but what must hold for the whole analysis.
_NO_OVERRIDE = {"comet": set(), "edu": {"count_mode", "edu_scope", "edu_kind", "edu_method", "edu_threshold"}}


def override_keys(kind: str) -> set[str]:
    return set(params_class(kind).__dataclass_fields__) - _NO_OVERRIDE[kind]


# --- records ---------------------------------------------------------------------------


def _load() -> dict[str, dict[str, Any]]:
    data = store._read_json(settings.analyses_path, {})  # noqa: SLF001
    return data if isinstance(data, dict) else {}


def _save(data: dict[str, dict[str, Any]]) -> None:
    store._write_json(settings.analyses_path, data)  # noqa: SLF001


def _dir(analysis_id: str) -> Path:
    return settings.analyses_dir / analysis_id


def _result_path(analysis_id: str, file_id: str) -> Path:
    return _dir(analysis_id) / f"{file_id}.json"


def stats_path(analysis_id: str, file_id: str) -> Path:
    return _dir(analysis_id) / f"{file_id}.stats.json"


def _drop_results(analysis_id: str, file_id: str) -> None:
    for suffix in (".json", ".stats.json", ".png", ".nucleus.png", ".edu.png"):
        path = _dir(analysis_id) / f"{file_id}{suffix}"
        path.unlink(missing_ok=True)
        jsoncache.forget(path)
    for path in _dir(analysis_id).glob(f"{file_id}.c*.png"):
        path.unlink(missing_ok=True)


def list_analyses(owner_id: str) -> list[dict[str, Any]]:
    items = [rec for _, rec in store._snapshot(_load) if store._owned(rec, owner_id)]  # noqa: SLF001
    items.sort(key=lambda r: r.get("updated_at") or r.get("created_at") or 0, reverse=True)
    return items


def get_owned(analysis_id: str, owner_id: str) -> dict[str, Any] | None:
    rec = store._get_copy(_load, analysis_id)  # noqa: SLF001
    return rec if store._owned(rec, owner_id) else None  # noqa: SLF001


def _patch(analysis_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    with store._LOCK:  # noqa: SLF001
        data = _load()
        rec = data.get(analysis_id)
        if rec is None:
            return None
        data[analysis_id] = {**rec, **changes, "updated_at": time.time()}
        _save(data)
        return dict(data[analysis_id])


def _pairing(files: list[dict[str, Any]], edu_kind: str) -> dict[str, Any]:
    """file_ids / partners / names / unpaired of an EdU analysis over these file records."""
    units, unpaired = edu.pair_files(files, edu_kind)
    return {
        "file_ids": [u["file_id"] for u in units],
        "partners": {u["file_id"]: u["partner"] for u in units if u["partner"]},
        "names": {u["file_id"]: u["name"] for u in units},
        "unpaired": unpaired,
    }


def pairing_preview(owner_id: str, file_ids: list[str], edu_kind: str) -> dict[str, Any]:
    files = [f for f in (store.get_owned_file(fid, owner_id) for fid in dict.fromkeys(file_ids)) if f]
    by_id = {f["id"]: f for f in files}
    out = _pairing(files, edu_kind)
    fields = [
        {
            "file_id": fid,
            "name": out["names"][fid],
            "folder": by_id[fid].get("folder") or "",
            "nucleus": by_id[fid].get("name"),
            "edu": by_id[out["partners"][fid]].get("name") if fid in out["partners"] else None,
        }
        for fid in out["file_ids"]
    ]
    return {"fields": fields, "unpaired": out["unpaired"]}


def create(owner_id: str, *, name: str, file_ids: list[str], params: dict[str, Any] | None, kind: str = "comet") -> dict[str, Any]:
    kind = kind if kind in TYPES else "comet"
    files = [store.get_owned_file(fid, owner_id) for fid in dict.fromkeys(file_ids)]
    files = [f for f in files if f]
    folders = {f["id"]: f.get("folder") or "/" for f in files}
    parsed = params_class(kind).from_dict(params)
    extra: dict[str, Any] = {}
    ids = [f["id"] for f in files]
    if kind == "edu":
        extra = _pairing(files, parsed.edu_kind)
        if not extra["file_ids"]:
            raise NoFields(extra["unpaired"])
        ids = extra.pop("file_ids")
        extra["source_ids"] = [f["id"] for f in files]
    now = time.time()
    rec = {
        "id": uuid.uuid4().hex,
        "type": kind,
        "name": (name or "").strip()[:120] or DEFAULT_NAMES[kind],
        "file_ids": ids,
        # Default groups: the folder each image sits in (one condition per folder).
        "groups": {fid: folders[fid] for fid in ids},
        "params": parsed.to_dict(),
        "overrides": {},
        "status": "idle",
        "progress": 0.0,
        "created_at": now,
        "updated_at": now,
        **extra,
        store.OWNER_FIELD: owner_id,
    }
    with store._LOCK:  # noqa: SLF001
        data = _load()
        data[rec["id"]] = rec
        _save(data)
    return dict(rec)


def update(analysis_id: str, owner_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    rec = get_owned(analysis_id, owner_id)
    if rec is None:
        return None
    out: dict[str, Any] = {}
    if "name" in changes and changes["name"]:
        out["name"] = str(changes["name"]).strip()[:120]
    kind = rec_type(rec)
    if "params" in changes and changes["params"] is not None:
        out["params"] = params_class(kind).from_dict({**rec.get("params", {}), **changes["params"]}).to_dict()
        if kind == "edu" and out["params"]["edu_kind"] != (rec.get("params") or {}).get("edu_kind", "auto"):
            out.update(_repair(rec, owner_id, out["params"]["edu_kind"]))
            rec = {**rec, **out}
    if "groups" in changes and isinstance(changes["groups"], dict):
        groups = dict(rec.get("groups") or {})
        for fid, label in changes["groups"].items():
            if fid in rec["file_ids"]:
                groups[fid] = str(label or "/").strip()[:120] or "/"
        out["groups"] = groups
    if "file_ids" in changes and isinstance(changes["file_ids"], list):
        keep = []
        groups = dict(out.get("groups") or rec.get("groups") or {})
        for fid in dict.fromkeys(changes["file_ids"]):
            if kind == "edu" and fid not in rec["file_ids"]:
                continue  # EdU fields come from pairing; they can only be removed here
            f = store.get_owned_file(fid, owner_id)
            if f:
                keep.append(fid)
                groups.setdefault(fid, f.get("folder") or "/")
        for fid in set(rec["file_ids"]) - set(keep):
            _drop_results(analysis_id, fid)
            groups.pop(fid, None)
        out["file_ids"] = keep
        out["groups"] = groups
        if kind == "edu":
            out["partners"] = {k: v for k, v in (rec.get("partners") or {}).items() if k in keep}
    return _patch(analysis_id, out)


def _repair(rec: dict[str, Any], owner_id: str, edu_kind: str) -> dict[str, Any]:
    """Pair the analysis' files again (another EdU colour was chosen)."""
    files = [f for f in (store.get_owned_file(fid, owner_id) for fid in rec.get("source_ids") or rec["file_ids"]) if f]
    paired = _pairing(files, edu_kind)
    old_groups = rec.get("groups") or {}
    folders = {f["id"]: f.get("folder") or "/" for f in files}
    ids = paired.pop("file_ids")
    partners = rec.get("partners") or {}
    for fid in rec["file_ids"]:
        if fid not in ids or partners.get(fid) != paired["partners"].get(fid):
            _drop_results(rec["id"], fid)
    return {**paired, "file_ids": ids, "groups": {fid: old_groups.get(fid) or folders[fid] for fid in ids}}


def delete(analysis_id: str, owner_id: str) -> bool:
    with store._LOCK:  # noqa: SLF001
        data = _load()
        if not store._owned(data.get(analysis_id), owner_id):  # noqa: SLF001
            return False
        data.pop(analysis_id, None)
        _save(data)
    shutil.rmtree(_dir(analysis_id), ignore_errors=True)
    return True


def delete_owner(owner_id: str) -> None:
    for rec in list_analyses(owner_id):
        delete(rec["id"], owner_id)


# --- results ---------------------------------------------------------------------------------


def read_result(analysis_id: str, file_id: str) -> dict[str, Any] | None:
    try:
        return json.loads(_result_path(analysis_id, file_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_result(analysis_id: str, file_id: str, payload: dict[str, Any]) -> None:
    path = _result_path(analysis_id, file_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def set_deleted(analysis_id: str, file_id: str, keys: list[int]) -> dict[str, Any] | None:
    res = read_result(analysis_id, file_id)
    if res is None:
        return None
    known = {c["key"] for c in res.get("comets", [])}
    res["deleted"] = sorted({int(k) for k in keys if int(k) in known})
    _write_result(analysis_id, file_id, res)
    return res


def file_params(rec: dict[str, Any], file_id: str) -> Any:
    raw = {**(rec.get("params") or {}), **((rec.get("overrides") or {}).get(file_id) or {})}
    return params_class(rec_type(rec)).from_dict(raw)


def set_override(analysis_id: str, owner_id: str, file_id: str, params: dict[str, Any] | None) -> dict[str, Any] | None:
    rec = get_owned(analysis_id, owner_id)
    if rec is None or file_id not in rec["file_ids"]:
        return None
    overrides = dict(rec.get("overrides") or {})
    allowed = override_keys(rec_type(rec))
    picked = {k: v for k, v in (params or {}).items() if k in allowed}
    if picked:
        overrides[file_id] = picked
    else:
        overrides.pop(file_id, None)
    return _patch(analysis_id, {"overrides": overrides})


def flag(c: dict[str, Any], deleted: set[int]) -> str:
    return "deleted" if c["key"] in deleted else c["status"]


def file_summary(res: dict[str, Any] | None) -> dict[str, Any]:
    if not res:
        return {"analyzed": False}
    if res.get("error"):
        return {"analyzed": True, "error": res["error"]}
    deleted = set(res.get("deleted") or [])
    counts = {"valid": 0, "outlier": 0, "invalid": 0, "deleted": 0}
    for c in res.get("comets", []):
        counts[flag(c, deleted)] += 1
    return {"analyzed": True, "counts": counts, "analyzed_at": res.get("analyzed_at")}


# --- running ---------------------------------------------------------------------------------


# Recently read images for previews: tuning parameters re-reads the same file many times.
_PLANES: OrderedDict[tuple[str, int, int], list[np.ndarray]] = OrderedDict()
_PLANES_LOCK = Lock()
PLANE_CACHE_PIXELS = 96_000_000


def _read_planes(file_id: str, rec: dict[str, Any]) -> list[np.ndarray]:
    source = store.source_path(file_id)
    if prepare.is_slide(rec):
        slide = ometiff.open_slide(source, file_id)
        lv = slide.levels[0]
        if lv.width * lv.height > MAX_PIXELS:
            raise ValueError("Image too large for the analysis.")
        return [ometiff.read_region(slide, 0, c, 0, 0, lv.width, lv.height) for c in range(slide.n_channels)]
    planes, _ = extract_channels(open_nd2(source))
    return planes


def load_planes(file_id: str, rec: dict[str, Any], cache: bool = False) -> list[np.ndarray]:
    """Full-resolution channels of an image (first T/Z/position). With `cache`, recently read
    images are reused (read-only arrays)."""
    if not cache:
        return _read_planes(file_id, rec)
    try:
        st = store.source_path(file_id).stat()
        key = (file_id, st.st_mtime_ns, st.st_size)
    except OSError:
        return _read_planes(file_id, rec)
    with _PLANES_LOCK:
        hit = _PLANES.get(key)
        if hit is not None:
            _PLANES.move_to_end(key)
            return hit
    planes = _read_planes(file_id, rec)
    for p in planes:
        p.setflags(write=False)
    with _PLANES_LOCK:
        for old in [k for k in _PLANES if k[0] == file_id]:
            _PLANES.pop(old, None)
        _PLANES[key] = planes
        while len(_PLANES) > 1 and sum(p.size for v in _PLANES.values() for p in v) > PLANE_CACHE_PIXELS:
            _PLANES.popitem(last=False)
    return planes


def um_per_px(file_rec: dict[str, Any]) -> float:
    return float((file_rec.get("voxel_um") or [0])[0] or 0) if file_rec.get("calibrated") is not False else 0.0


def _run_one(analysis_id: str, owner_id: str, file_id: str) -> None:
    rec = get_owned(analysis_id, owner_id)
    file_rec = store.get_owned_file(file_id, owner_id)
    if rec is None or file_rec is None:
        return
    if rec_type(rec) == "edu":
        from nd2utils import edu_results

        edu_results.run_one(rec, owner_id, file_id, file_rec)
        return
    params = file_params(rec, file_id)
    previous = read_result(analysis_id, file_id)
    um = um_per_px(file_rec)
    try:
        planes = load_planes(file_id, file_rec)
        res = comet.analyze(planes, params, um or None)
        res["error"] = None
    except Exception as exc:  # unreadable image, nothing found to threshold, …
        log.warning("Comet analysis of %s failed: %s", file_id, exc)
        res = {"comets": [], "error": str(exc)}
    res.update(
        {
            "file_id": file_id,
            "name": file_rec.get("name"),
            "folder": file_rec.get("folder") or "",
            "um_per_px": um or None,
            "params": params.to_dict(),
            "analyzed_at": time.time(),
            # Hand deletions survive a re-run only when nothing changed in the segmentation.
            "deleted": previous.get("deleted", [])
            if previous and comet.CometParams.from_dict(previous.get("params")).to_dict() == params.to_dict()
            else [],
        }
    )
    _write_result(analysis_id, file_id, res)
    image_cache(analysis_id, file_id).unlink(missing_ok=True)


def _worker(analysis_id: str, owner_id: str, file_ids: list[str]) -> None:
    total = len(file_ids)
    _patch(analysis_id, {"status": "running", "progress": 0.0})
    for i, file_id in enumerate(file_ids):
        if get_owned(analysis_id, owner_id) is None:
            break  # deleted meanwhile
        try:
            _run_one(analysis_id, owner_id, file_id)
        finally:
            with _GUARD:
                _RUNNING.get(analysis_id, set()).discard(file_id)
        _patch(analysis_id, {"progress": round((i + 1) / max(total, 1), 4)})
    with _GUARD:
        busy = bool(_RUNNING.get(analysis_id))
    if not busy and get_owned(analysis_id, owner_id) is not None:
        _patch(analysis_id, {"status": "done", "progress": 1.0})


def run(analysis_id: str, owner_id: str, file_ids: list[str] | None = None) -> int:
    rec = get_owned(analysis_id, owner_id)
    if rec is None:
        return 0
    ids = [fid for fid in (file_ids or rec["file_ids"]) if fid in rec["file_ids"]]
    with _GUARD:
        running = _RUNNING.setdefault(analysis_id, set())
        ids = [fid for fid in ids if fid not in running]
        running.update(ids)
    if ids:
        _patch(analysis_id, {"status": "queued", "progress": 0.0})
        _EXECUTOR.submit(_worker, analysis_id, owner_id, ids)
    return len(ids)


def preview(rec: dict[str, Any], owner_id: str, file_id: str, params: dict[str, Any] | None) -> dict[str, Any]:
    """Analyse one image with draft parameters (on top of its own) without storing anything."""
    file_rec = store.get_owned_file(file_id, owner_id)
    if file_rec is None:
        raise FileNotFoundError(file_id)
    kind = rec_type(rec)
    parsed = params_class(kind).from_dict({**file_params(rec, file_id).to_dict(), **(params or {})})
    with _PREVIEW:
        try:
            if kind == "edu":
                from nd2utils import edu_results

                res = edu_results.compute(rec, owner_id, file_id, file_rec, parsed, cache=True)
            else:
                res = comet.analyze(load_planes(file_id, file_rec, cache=True), parsed, um_per_px(file_rec) or None)
            res["error"] = None
        except Exception as exc:
            log.info("Preview of %s failed: %s", file_id, exc)
            res = {"comets": [], "nuclei": [], "edu_objects": [], "error": str(exc)}
    res.update({"file_id": file_id, "name": file_rec.get("name"), "params": parsed.to_dict(), "preview": True, "deleted": [], "analyzed_at": None})
    return res


def reset_interrupted() -> None:
    """At startup: analyses that were running when the server stopped."""
    with store._LOCK:  # noqa: SLF001
        data = _load()
        changed = False
        for rec in data.values():
            if rec.get("status") in ("queued", "running"):
                rec["status"] = "idle"
                changed = True
        if changed:
            _save(data)


# --- statistics --------------------------------------------------------------------------------


def collect(rec: dict[str, Any], include_outliers: bool) -> list[dict[str, Any]]:
    """Counted comets (valid, plus outliers when asked; never deleted or invalid) with their
    image and group."""
    out = []
    groups = rec.get("groups") or {}
    for fid in rec["file_ids"]:
        res = read_result(rec["id"], fid)
        if not res:
            continue
        deleted = set(res.get("deleted") or [])
        for c in res.get("comets", []):
            status = flag(c, deleted)
            if status == "valid" or (include_outliers and status == "outlier"):
                out.append({"group": groups.get(fid, "/"), "file_id": fid, "name": res.get("name"), "num": c.get("num"), "metrics": c["metrics"]})
    return out


def summary(rec: dict[str, Any], include_outliers: bool = False) -> dict[str, Any]:
    if rec_type(rec) == "edu":
        from nd2utils import edu_results

        return edu_results.summary(rec)
    return comet_summary(rec, include_outliers)


def comet_summary(rec: dict[str, Any], include_outliers: bool) -> dict[str, Any]:
    rows = collect(rec, include_outliers)
    order = list(dict.fromkeys((rec.get("groups") or {}).get(fid, "/") for fid in rec["file_ids"]))
    groups = []
    for label in order:
        members = [r for r in rows if r["group"] == label]
        groups.append(
            {
                "group": label,
                "metrics": {m: comet.describe([r["metrics"].get(m) for r in members]) for m in KEY_METRICS},
                # Raw values for the plots (per metric, in comet order).
                "values": {m: [round(r["metrics"].get(m, 0.0), 3) for r in members] for m in KEY_METRICS[:3]},
            }
        )
    return {"groups": groups, "total": len(rows), "include_outliers": include_outliers}


# --- images and export -----------------------------------------------------------------------------


def image_cache(analysis_id: str, file_id: str) -> Path:
    return _dir(analysis_id) / f"{file_id}.png"


def analysis_image(analysis_id: str, owner_id: str, file_id: str, role: str | None = None, channel: int | None = None) -> bytes:
    """The analysed 8-bit channel as PNG (what the overlay coordinates refer to). EdU analyses
    have two: role "nucleus" and "edu". A comet `channel` picks that channel (previews)."""
    rec = get_owned(analysis_id, owner_id)
    if rec is not None and rec_type(rec) == "edu":
        from nd2utils import edu_results

        return edu_results.channel_png(rec, owner_id, file_id, "edu" if role == "edu" else "nucleus")
    path = image_cache(analysis_id, file_id) if channel is None else _dir(analysis_id) / f"{file_id}.c{int(channel)}.png"
    try:
        return path.read_bytes()
    except OSError:
        pass
    rec = get_owned(analysis_id, owner_id)
    file_rec = store.get_owned_file(file_id, owner_id)
    if rec is None or file_rec is None:
        raise FileNotFoundError(file_id)
    from PIL import Image

    params = file_params(rec, file_id)
    gray, _ = comet.to_gray8(load_planes(file_id, file_rec, cache=True), params.channel if channel is None else channel)
    buf = io.BytesIO()
    Image.fromarray(gray, "L").save(buf, format="PNG", optimize=False)
    body = buf.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return body


_COLORS = {"valid": (239, 68, 68), "outlier": (249, 115, 22), "invalid": (148, 163, 184), "deleted": (100, 116, 139)}


def overlay_png(analysis_id: str, owner_id: str, file_id: str) -> bytes | None:
    from PIL import Image, ImageDraw

    from nd2utils.render import _font

    res = read_result(analysis_id, file_id)
    if not res or res.get("error"):
        return None
    gray = Image.open(io.BytesIO(analysis_image(analysis_id, owner_id, file_id))).convert("RGB")
    draw = ImageDraw.Draw(gray)
    deleted = set(res.get("deleted") or [])
    font = _font(max(14, gray.width // 60))
    line = max(1, gray.width // 600)
    for c in res.get("comets", []):
        status = flag(c, deleted)
        color = _COLORS[status]
        pts = [tuple(p) for p in (c.get("hull") or c.get("outline") or [])]
        if len(pts) > 2:
            draw.line(pts + [pts[0]], fill=color, width=line)
        head = c.get("head")
        if head and status != "invalid":
            r = head["r"]
            draw.ellipse([head["cx"] - r, head["cy"] - r, head["cx"] + r, head["cy"] + r], outline=color, width=line)
        if c.get("num") and pts:
            x = max(p[0] for p in pts)
            y = min(p[1] for p in pts)
            draw.text((x + 3, y), str(c["num"]), fill=color, font=font)
    buf = io.BytesIO()
    gray.save(buf, format="PNG")
    return buf.getvalue()


def _csv_bytes(rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return ("﻿" + buf.getvalue()).encode("utf-8")  # BOM: Excel opens UTF-8 correctly


def export_archive(analysis_id: str, owner_id: str, dest: Path, progress=None) -> None:
    rec = get_owned(analysis_id, owner_id)
    if rec is None:
        raise FileNotFoundError(analysis_id)
    if rec_type(rec) == "edu":
        from nd2utils import edu_results

        edu_results.export_archive(rec, owner_id, dest, progress)
        return
    groups = rec.get("groups") or {}
    calibrated = False
    rows: list[list[Any]] = []
    results = []
    for fid in rec["file_ids"]:
        res = read_result(analysis_id, fid)
        if res and not res.get("error"):
            results.append((fid, res))
            calibrated = calibrated or bool(res.get("um_per_px"))
    extra = ["CometLength_um", "HeadLength_um", "TailLength_um", "CometArea_um2", "TailMoment_um", "OliveMoment_um"] if calibrated else []
    rows.append(["Group", "FileName", "Num", "Flag", *comet.METRICS, *extra])
    for fid, res in results:
        deleted = set(res.get("deleted") or [])
        for c in res.get("comets", []):
            status = flag(c, deleted)
            if status == "invalid":
                continue
            m = c["metrics"]
            rows.append([groups.get(fid, "/"), res.get("name"), c.get("num"), {"valid": "normal"}.get(status, status), *(m.get(k) for k in comet.METRICS), *(m.get(k, "") for k in extra)])
    summary_rows: list[list[Any]] = [["Group", "Comets", "Metric", "n", "Mean", "SD", "SEM", "Median", "Min", "Max"]]
    for include in (False, True):
        for g in comet_summary(rec, include)["groups"]:
            for metric, st in g["metrics"].items():
                summary_rows.append([g["group"], "normal+outlier" if include else "normal", metric, st["n"], st["mean"], st["sd"], st["sem"], st["median"], st["min"], st["max"]])
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("comets.csv", _csv_bytes(rows))
        zf.writestr("summary.csv", _csv_bytes(summary_rows))
        params = {"params": rec.get("params"), "overrides": rec.get("overrides"), "groups": groups}
        zf.writestr("parameters.json", json.dumps(params, ensure_ascii=False, indent=2))
        for i, (fid, res) in enumerate(results):
            png = overlay_png(analysis_id, owner_id, fid)
            if png:
                stem = Path(str(res.get("name") or fid)).stem
                folder = groups.get(fid, "/").strip("/").replace("/", "_") or "root"
                zf.writestr(f"overlays/{folder}/{stem}_comets.png", png)
            if progress:
                progress((i + 1) / max(len(results), 1))
