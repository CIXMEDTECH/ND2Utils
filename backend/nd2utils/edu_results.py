"""EdU analyses: running a field, statistics, images and the export (see `edu.py` for the
image processing and `analyses.py` for the records and the queue).

Per field two files are written: <file id>.json with the outlines (for the viewer and the
overlays) and <file id>.stats.json with what the statistics need — per-nucleus EdU means,
the number of EdU objects, and the user's hand edits (`marks`, `edu_deleted`). Lists, group
statistics and the pooled threshold read only the small file.
"""

from __future__ import annotations

import io
import json
import logging
import time
import zipfile
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np

from nd2utils import analyses, comet, edu, jsoncache, store

log = logging.getLogger("nd2utils.edu")

_POOL_MEMO: dict[str, tuple[tuple[Any, ...], dict[str, float | None]]] = {}
_POOL_LOCK = Lock()


# --- channels --------------------------------------------------------------------------------


def _channel_meta(file_rec: dict[str, Any], index: int) -> dict[str, Any]:
    channels = file_rec.get("channels") or []
    ch = channels[index] if 0 <= index < len(channels) else {}
    return {
        "file_id": file_rec["id"],
        "file": file_rec.get("name"),
        "channel": index,
        "channel_name": ch.get("name") or f"C{index + 1}",
        "color": list(ch.get("color") or [255, 255, 255])[:3],
    }


def resolve(rec: dict[str, Any], owner_id: str, file_id: str, file_rec: dict[str, Any], params: edu.EduParams) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    """(nucleus channel meta, EdU channel meta, partner file record)."""
    partner_id = (rec.get("partners") or {}).get(file_id)
    channels = file_rec.get("channels") or []
    name = str(file_rec.get("name") or "")
    if partner_id:
        partner = store.get_owned_file(partner_id, owner_id)
        if partner is None:
            raise ValueError("The EdU image of this field was deleted.")
        kinds = [(i, edu.channel_kind(ch, name)) for i, ch in enumerate(channels)]
        nuc = next((i for i, k in kinds if k == "nucleus"), 0)
        pch = partner.get("channels") or []
        pkinds = [(i, edu.channel_kind(ch, str(partner.get("name") or ""))) for i, ch in enumerate(pch)]
        edu_idx = edu.pick_edu(pkinds, params.edu_kind)
        return _channel_meta(file_rec, nuc), _channel_meta(partner, edu_idx if edu_idx is not None else 0), partner
    nuc, edu_idx = edu.resolve_channels(channels, name, params)
    if nuc is None:
        raise ValueError("No nuclear (DAPI/Hoechst) channel found; choose it in the parameters.")
    if edu_idx is None or edu_idx == nuc:
        raise ValueError("No EdU channel found; choose it in the parameters.")
    return _channel_meta(file_rec, nuc), _channel_meta(file_rec, edu_idx), None


def planes(rec: dict[str, Any], owner_id: str, file_id: str, file_rec: dict[str, Any], params: edu.EduParams, cache: bool = False):
    nuc_meta, edu_meta, partner = resolve(rec, owner_id, file_id, file_rec, params)
    nuc_planes = analyses.load_planes(file_id, file_rec, cache=cache)
    edu_planes = analyses.load_planes(partner["id"], partner, cache=cache) if partner else nuc_planes
    for meta, stack in ((nuc_meta, nuc_planes), (edu_meta, edu_planes)):
        if meta["channel"] >= len(stack):
            raise ValueError(f"Channel {meta['channel'] + 1} does not exist in {meta['file']}.")
    return nuc_planes[nuc_meta["channel"]], edu_planes[edu_meta["channel"]], nuc_meta, edu_meta


# --- running ---------------------------------------------------------------------------------


def compute(rec: dict[str, Any], owner_id: str, file_id: str, file_rec: dict[str, Any], params: edu.EduParams, cache: bool = False) -> dict[str, Any]:
    nuc, edu_plane, nuc_meta, edu_meta = planes(rec, owner_id, file_id, file_rec, params, cache)
    res = edu.analyze(nuc, edu_plane, params, analyses.um_per_px(file_rec) or None)
    res.update({"nucleus": nuc_meta, "edu": edu_meta, "marks": {}, "edu_deleted": []})
    return res


def _stats_of(res: dict[str, Any]) -> dict[str, Any]:
    return {
        "analyzed_at": res.get("analyzed_at"),
        "error": res.get("error"),
        "seg": res.get("seg"),
        "edu": [n["edu"] for n in res.get("nuclei", [])],
        "area": [n["area"] for n in res.get("nuclei", [])],
        "objects": len(res.get("edu_objects", [])),
        "auto": res.get("auto_thresholds") or {},
        "marks": res.get("marks") or {},
        "edu_deleted": res.get("edu_deleted") or [],
        "um_per_px": res.get("um_per_px"),
        "median_area": res.get("median_area"),
    }


def read_stats(analysis_id: str, file_id: str) -> dict[str, Any] | None:
    data = jsoncache.read(analyses.stats_path(analysis_id, file_id), lambda: None)
    return data if isinstance(data, dict) else None


def _write(analysis_id: str, file_id: str, res: dict[str, Any], stats: dict[str, Any]) -> None:
    analyses._write_result(analysis_id, file_id, res)  # noqa: SLF001
    jsoncache.write(analyses.stats_path(analysis_id, file_id), stats)


def run_one(rec: dict[str, Any], owner_id: str, file_id: str, file_rec: dict[str, Any]) -> None:
    analysis_id = rec["id"]
    params = analyses.file_params(rec, file_id)
    previous = read_stats(analysis_id, file_id)
    seg = edu.segmentation_key(params)
    try:
        res = compute(rec, owner_id, file_id, file_rec, params)
        res["error"] = None
    except Exception as exc:
        log.warning("EdU analysis of %s failed: %s", file_id, exc)
        res = {"nuclei": [], "edu_objects": [], "error": str(exc)}
    keep = previous is not None and previous.get("seg") == seg and not previous.get("error")
    res.update(
        {
            "file_id": file_id,
            "name": (rec.get("names") or {}).get(file_id) or file_rec.get("name"),
            "folder": file_rec.get("folder") or "",
            "params": params.to_dict(),
            "seg": seg,
            "analyzed_at": time.time(),
            # Hand edits survive a re-run only when the segmentation did not change.
            "marks": (previous or {}).get("marks", {}) if keep else {},
            "edu_deleted": (previous or {}).get("edu_deleted", []) if keep else [],
        }
    )
    _write(analysis_id, file_id, res, _stats_of(res))
    for role in ("nucleus", "edu"):
        (analyses._dir(analysis_id) / f"{file_id}.{role}.png").unlink(missing_ok=True)  # noqa: SLF001


def full_result(analysis_id: str, file_id: str) -> dict[str, Any] | None:
    res = analyses.read_result(analysis_id, file_id)
    if res is None:
        return None
    stats = read_stats(analysis_id, file_id) or {}
    res["marks"] = stats.get("marks", res.get("marks") or {})
    res["edu_deleted"] = stats.get("edu_deleted", res.get("edu_deleted") or [])
    return res


def set_edits(analysis_id: str, file_id: str, marks: dict[str, str] | None, edu_deleted: list[int] | None) -> dict[str, Any] | None:
    stats = read_stats(analysis_id, file_id)
    if stats is None or stats.get("error"):
        return None
    stats = dict(stats)
    n = len(stats.get("edu") or [])
    if marks is not None:
        stats["marks"] = {str(int(k)): v for k, v in marks.items() if str(k).isdigit() and v in ("positive", "negative", "excluded") and 1 <= int(k) <= n}
    if edu_deleted is not None:
        stats["edu_deleted"] = sorted({int(k) for k in edu_deleted if 1 <= int(k) <= int(stats.get("objects") or 0)})
    jsoncache.write(analyses.stats_path(analysis_id, file_id), stats)
    return {"marks": stats["marks"], "edu_deleted": stats["edu_deleted"]}


# --- thresholds and statistics -------------------------------------------------------------------


def pooled_thresholds(rec: dict[str, Any]) -> dict[str, float | None]:
    """Automatic thresholds over the per-nucleus EdU means of every analysed field."""
    stats = [(fid, read_stats(rec["id"], fid)) for fid in rec["file_ids"]]
    stamp = tuple((fid, s.get("analyzed_at") if s else None) for fid, s in stats)
    with _POOL_LOCK:
        hit = _POOL_MEMO.get(rec["id"])
        if hit and hit[0] == stamp:
            return hit[1]
    values: list[float] = []
    for _, s in stats:
        if s and not s.get("error"):
            values.extend(s.get("edu") or [])
    out = {m: edu.auto_threshold(values, m) for m in edu.EDU_METHODS if m != "manual"}
    with _POOL_LOCK:
        _POOL_MEMO[rec["id"]] = (stamp, out)
    return out


def threshold_for(params: edu.EduParams, stats: dict[str, Any] | None, pooled: dict[str, float | None]) -> float | None:
    if params.edu_method == "manual":
        return params.edu_threshold
    if params.edu_scope == "analysis":
        return pooled.get(params.edu_method)
    return ((stats or {}).get("auto") or {}).get(params.edu_method)


def field_summary(rec: dict[str, Any], file_id: str, pooled: dict[str, float | None]) -> dict[str, Any]:
    stats = read_stats(rec["id"], file_id)
    if not stats:
        return {"analyzed": False}
    if stats.get("error"):
        return {"analyzed": True, "error": stats["error"], "analyzed_at": stats.get("analyzed_at")}
    params = edu.EduParams.from_dict(rec.get("params"))
    threshold = threshold_for(params, stats, pooled)
    c = edu.counts(stats.get("edu") or [], threshold, stats.get("marks"), int(stats.get("objects") or 0), stats.get("edu_deleted"))
    return {"analyzed": True, "error": None, "analyzed_at": stats.get("analyzed_at"), "counts": c, "threshold": threshold}


def summary(rec: dict[str, Any]) -> dict[str, Any]:
    pooled = pooled_thresholds(rec)
    params = edu.EduParams.from_dict(rec.get("params"))
    groups_of = rec.get("groups") or {}
    names = rec.get("names") or {}
    order = list(dict.fromkeys(groups_of.get(fid, "/") for fid in rec["file_ids"]))
    rows = []
    for fid in rec["file_ids"]:
        s = field_summary(rec, fid, pooled)
        if s.get("counts"):
            rows.append({"group": groups_of.get(fid, "/"), "file_id": fid, "name": names.get(fid, fid), **s["counts"], "threshold": s["threshold"]})
    groups = []
    for label in order:
        members = [r for r in rows if r["group"] == label]
        nuclei = sum(r["nuclei"] for r in members)
        positive = sum(r["positive"] for r in members)
        independent = sum(r["independent"] for r in members)
        pct = [100.0 * r["ratio"] for r in members if r["ratio"] is not None]
        pct_ind = [100.0 * r["ratio_independent"] for r in members if r["ratio_independent"] is not None]
        groups.append(
            {
                "group": label,
                "fields": len(members),
                "nuclei": nuclei,
                "positive": positive,
                "independent": independent,
                "pooled_percent": 100.0 * positive / nuclei if nuclei else None,
                "pooled_percent_independent": 100.0 * independent / nuclei if nuclei else None,
                "percent": comet.describe(pct),
                "percent_independent": comet.describe(pct_ind),
                "values": [round(v, 3) for v in pct],
                "values_independent": [round(v, 3) for v in pct_ind],
                "names": [r["name"] for r in members if r["ratio"] is not None],
            }
        )
    threshold = threshold_for(params, None, pooled) if params.edu_scope == "analysis" or params.edu_method == "manual" else None
    return {"type": "edu", "count_mode": params.count_mode, "groups": groups, "fields": rows, "threshold": threshold, "pooled": pooled, "total": sum(r["nuclei"] for r in rows)}


# --- images ------------------------------------------------------------------------------------------


def channel_png(rec: dict[str, Any], owner_id: str, file_id: str, role: str) -> bytes:
    """One analysed channel as an 8-bit PNG (cached)."""
    from PIL import Image

    path = analyses._dir(rec["id"]) / f"{file_id}.{role}.png"  # noqa: SLF001
    try:
        return path.read_bytes()
    except OSError:
        pass
    file_rec = store.get_owned_file(file_id, owner_id)
    if file_rec is None:
        raise FileNotFoundError(file_id)
    nuc, edu_plane, _, _ = planes(rec, owner_id, file_id, file_rec, analyses.file_params(rec, file_id), cache=True)
    gray, _ = comet.to_gray8([nuc if role == "nucleus" else edu_plane], 0)
    buf = io.BytesIO()
    Image.fromarray(gray, "L").save(buf, format="PNG", optimize=False)
    body = buf.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return body


def _stretch(gray: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(gray, [0.1, 99.9])
    hi = max(hi, lo + 1)
    return np.clip((gray.astype(np.float32) - lo) / (hi - lo), 0, 1)


FLAG_COLORS = {"positive": (250, 204, 21), "negative": (148, 163, 184), "excluded": (71, 85, 105)}


def overlay_png(rec: dict[str, Any], owner_id: str, file_id: str, pooled: dict[str, float | None]) -> bytes | None:
    """DAPI (blue) + EdU (its channel colour) with nucleus outlines by class (and the EdU
    objects for independent counting)."""
    from PIL import Image, ImageDraw

    res = full_result(rec["id"], file_id)
    if not res or res.get("error"):
        return None
    nuc = np.asarray(Image.open(io.BytesIO(channel_png(rec, owner_id, file_id, "nucleus"))))
    edu_gray = np.asarray(Image.open(io.BytesIO(channel_png(rec, owner_id, file_id, "edu"))))
    color = np.array((res.get("edu") or {}).get("color") or [0, 255, 0], np.float32)
    if color.max() <= 0 or (color.min() > 200):
        color = np.array([0, 255, 0], np.float32)
    rgb = _stretch(nuc)[..., None] * np.array([0, 90, 255], np.float32) + _stretch(edu_gray)[..., None] * color
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(img)
    params = edu.EduParams.from_dict(rec.get("params"))
    stats = read_stats(rec["id"], file_id)
    threshold = threshold_for(params, stats, pooled)
    flags = edu.classify([n["edu"] for n in res.get("nuclei", [])], threshold, res.get("marks"))
    line = max(1, img.width // 1000)
    for n, f in zip(res.get("nuclei", []), flags):
        o = n.get("outline") or []
        pts = list(zip(o[::2], o[1::2]))
        if len(pts) > 2:
            draw.line(pts + [pts[0]], fill=FLAG_COLORS[f], width=line)
    if params.count_mode == "independent":
        deleted = set(res.get("edu_deleted") or [])
        for obj in res.get("edu_objects", []):
            o = obj.get("outline") or []
            pts = list(zip(o[::2], o[1::2]))
            if len(pts) > 2:
                draw.line(pts + [pts[0]], fill=(71, 85, 105) if obj["key"] in deleted else (236, 72, 153), width=line)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --- export --------------------------------------------------------------------------------------------


def export_archive(rec: dict[str, Any], owner_id: str, dest: Path, progress=None) -> None:
    pooled = pooled_thresholds(rec)
    params = edu.EduParams.from_dict(rec.get("params"))
    groups = rec.get("groups") or {}
    names = rec.get("names") or {}
    fields = [["Group", "Field", "NucleusFile", "NucleusChannel", "EdUFile", "EdUChannel", "Nuclei", "EdUPositive", "EdUPercent", "Excluded", "Threshold", "EdUObjects", "EdUPercentIndependent", "Error"]]
    nuclei_rows = [["Group", "Field", "Nucleus", "X", "Y", "Area_px", "Area_um2", "DAPI_mean", "EdU_mean", "Class", "SetByHand"]]
    object_rows = [["Group", "Field", "Object", "X", "Y", "Area_px", "Area_um2", "EdU_mean", "Deleted"]]
    done = []
    for fid in rec["file_ids"]:
        res = full_result(rec["id"], fid)
        group = groups.get(fid, "/")
        name = names.get(fid) or (res or {}).get("name") or fid
        if res is None:
            continue
        if res.get("error"):
            fields.append([group, name, "", "", "", "", "", "", "", "", "", "", "", res["error"]])
            continue
        stats = read_stats(rec["id"], fid)
        threshold = threshold_for(params, stats, pooled)
        marks = res.get("marks") or {}
        c = edu.counts([n["edu"] for n in res["nuclei"]], threshold, marks, len(res["edu_objects"]), res.get("edu_deleted"))
        pct = lambda r: round(100.0 * r, 3) if r is not None else ""  # noqa: E731
        nm, em = res.get("nucleus") or {}, res.get("edu") or {}
        fields.append(
            [group, name, nm.get("file"), nm.get("channel_name"), em.get("file"), em.get("channel_name"), c["nuclei"], c["positive"], pct(c["ratio"]), c["excluded"],
             "" if threshold is None else round(threshold, 3), c["independent"], pct(c["ratio_independent"]), ""]
        )
        um = float(res.get("um_per_px") or 0)
        flags = edu.classify([n["edu"] for n in res["nuclei"]], threshold, marks)
        for n, f in zip(res["nuclei"], flags):
            nuclei_rows.append([group, name, n["key"], n["cx"], n["cy"], n["area"], round(n["area"] * um * um, 3) if um else "", n["dapi"], n["edu"], f, "yes" if str(n["key"]) in marks else ""])
        deleted = set(res.get("edu_deleted") or [])
        for o in res["edu_objects"]:
            object_rows.append([group, name, o["key"], o["cx"], o["cy"], o["area"], round(o["area"] * um * um, 3) if um else "", o["mean"], "yes" if o["key"] in deleted else ""])
        done.append((fid, name, group))
    summary_rows = [["Group", "Counting", "Fields", "Nuclei", "EdUPositive", "PooledPercent", "MeanPercent", "SD", "SEM", "Median", "Min", "Max"]]
    s = summary(rec)
    for g in s["groups"]:
        for mode, positive, pooled_pct, st in (
            ("nucleus", g["positive"], g["pooled_percent"], g["percent"]),
            ("independent", g["independent"], g["pooled_percent_independent"], g["percent_independent"]),
        ):
            summary_rows.append([g["group"], mode, g["fields"], g["nuclei"], positive, "" if pooled_pct is None else round(pooled_pct, 3), st["mean"], st["sd"], st["sem"], st["median"], st["min"], st["max"]])
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("fields.csv", analyses._csv_bytes(fields))  # noqa: SLF001
        zf.writestr("summary.csv", analyses._csv_bytes(summary_rows))  # noqa: SLF001
        zf.writestr("nuclei.csv", analyses._csv_bytes(nuclei_rows))  # noqa: SLF001
        zf.writestr("edu_objects.csv", analyses._csv_bytes(object_rows))  # noqa: SLF001
        meta = {"params": rec.get("params"), "overrides": rec.get("overrides"), "groups": groups, "threshold": s["threshold"], "pooled_thresholds": pooled, "unpaired": rec.get("unpaired") or []}
        zf.writestr("parameters.json", json.dumps(meta, ensure_ascii=False, indent=2))
        for i, (fid, name, group) in enumerate(done):
            png = overlay_png(rec, owner_id, fid, pooled)
            if png:
                folder = group.strip("/").replace("/", "_") or "root"
                stem = "".join(ch if ch.isalnum() or ch in "-_+. " else "_" for ch in name).strip() or fid
                zf.writestr(f"overlays/{folder}/{stem}_edu.png", png)
            if progress:
                progress((i + 1) / max(len(done), 1))
