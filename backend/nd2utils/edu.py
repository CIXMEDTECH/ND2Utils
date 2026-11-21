"""EdU proliferation assay: the share of nuclei that incorporated EdU.

One field of view = a nuclear stain (DAPI / Hoechst) plus the EdU channel (green, red or far
red). Both can sit in one multi-channel file (ND2, LIF, OME-TIFF) or in two single-channel
files named alike ("well3_0066_DAPI.tiff" + "well3_0066_GFP.tiff"); `pair_files` finds the
fields of a set of workspace files.

Pipeline (each step has a parameter in `EduParams`):

1. Nuclear channel: Gaussian smoothing, background removed with a morphological opening whose
   window is about twice the typical nucleus (estimated from a first threshold pass), threshold
   (Otsu / Li / Triangle × factor, or manual), small opening, holes filled.
2. Touching nuclei are split by a watershed on the distance transform seeded with h-maxima
   (larger h = fewer splits). Objects below the minimum area (default a quarter of the median
   nucleus) or above the maximum, and optionally those on the border, are dropped.
3. Each nucleus gets its mean EdU intensity (background-subtracted, same window).
4. "nucleus" counting: a nucleus is EdU+ when that mean is above the threshold — by default
   Li's minimum cross-entropy split of the per-nucleus means pooled over the whole analysis,
   so every image is judged by the same cut-off (on the demo EVOS images plain Otsu misses
   clearly green but dim nuclei; log-Otsu also takes barely tinted ones). The threshold only reclassifies; it never needs a new
   segmentation. Users can flip or exclude single nuclei.
5. "independent" counting: the EdU channel is segmented on its own (same steps) and its
   objects are counted, as done by hand in ImageJ; ratio = EdU objects / nuclei.

Both counts are computed every time, so switching the counting mode needs no re-run.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage

COUNT_MODES = ("nucleus", "independent")
EDU_KINDS = ("auto", "green", "red", "farred")
SEG_METHODS = ("otsu", "li", "triangle", "manual")
EDU_METHODS = ("li", "log-otsu", "otsu", "manual")
SCOPES = ("analysis", "image")

# Parameters that only change how nuclei are classified (no new segmentation needed).
CLASSIFY_KEYS = ("count_mode", "edu_method", "edu_threshold", "edu_scope")


@dataclass
class EduParams:
    nucleus_channel: int | None = None  # multi-channel files; None = the DAPI/Hoechst channel
    edu_channel: int | None = None  # multi-channel files; None = by `edu_kind`
    edu_kind: str = "auto"
    count_mode: str = "nucleus"
    # Segmentation (nuclei; the independent EdU count uses the same steps).
    smooth_sigma: float = 1.5
    background_radius: float = 0.0  # px; 0 = automatic (≈ 1.2 × nucleus diameter)
    nucleus_method: str = "otsu"
    nucleus_factor: float = 1.0
    nucleus_threshold: float = 0.0  # manual, background-subtracted intensity
    split_touching: bool = True
    split_strength: float = 2.0  # h of the h-maxima seeds, px of the distance map
    min_area: int = 0  # px; 0 = automatic (a quarter of the median nucleus)
    max_area: int = 0  # px; 0 = no limit
    exclude_border: bool = False
    # Classification ("nucleus" counting).
    edu_method: str = "li"
    edu_threshold: float = 0.0  # manual
    edu_scope: str = "analysis"
    # Independent EdU segmentation.
    edu_seg_method: str = "otsu"
    edu_seg_factor: float = 1.0
    edu_seg_threshold: float = 0.0

    _CHOICES = {
        "edu_kind": EDU_KINDS,
        "count_mode": COUNT_MODES,
        "nucleus_method": SEG_METHODS,
        "edu_method": EDU_METHODS,
        "edu_scope": SCOPES,
        "edu_seg_method": SEG_METHODS,
    }
    # name -> (low, high, integer?)
    _RANGES = {
        "smooth_sigma": (0.0, 10.0, False),
        "background_radius": (0.0, 2000.0, False),
        "nucleus_factor": (0.2, 5.0, False),
        "nucleus_threshold": (0.0, 1e9, False),
        "split_strength": (0.2, 50.0, False),
        "min_area": (0, 10_000_000, True),
        "max_area": (0, 100_000_000, True),
        "edu_threshold": (0.0, 1e9, False),
        "edu_seg_factor": (0.2, 5.0, False),
        "edu_seg_threshold": (0.0, 1e9, False),
    }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> "EduParams":
        raw = raw or {}
        out = cls()
        for key in ("nucleus_channel", "edu_channel"):
            value = raw.get(key)
            if value is not None and value != "":
                try:
                    setattr(out, key, max(0, int(value)))
                except (TypeError, ValueError):
                    pass
        for key, choices in cls._CHOICES.items():
            if raw.get(key) in choices:
                setattr(out, key, raw[key])
        for key in ("split_touching", "exclude_border"):
            if key in raw and raw[key] is not None:
                setattr(out, key, bool(raw[key]))
        for key, (lo, hi, integer) in cls._RANGES.items():
            value = raw.get(key)
            if value is None or value == "":
                continue
            try:
                num = float(value)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(num):
                continue
            num = min(hi, max(lo, num))
            setattr(out, key, int(round(num)) if integer else num)
        return out

    def to_dict(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


def segmentation_key(params: dict[str, Any] | EduParams | None) -> dict[str, Any]:
    """The parameters that decide the segmentation (hand edits survive when these match)."""
    p = params if isinstance(params, EduParams) else EduParams.from_dict(params)
    return {k: v for k, v in p.to_dict().items() if k not in CLASSIFY_KEYS}


# --- channels and pairing ----------------------------------------------------------------

_EXACT = {
    "nucleus": {"dapi", "hoechst", "h33342", "h33258", "bfp", "nuclei", "nucleus", "nuc"},
    "edu": {"edu", "click"},
    "green": {"gfp", "egfp", "fitc", "af488", "a488", "alexa488", "cy2", "green", "yfp", "venus"},
    "red": {"rfp", "mcherry", "tritc", "cy3", "af555", "af568", "af594", "alexa555", "alexa568", "alexa594", "txred", "texasred", "dsred", "tdtomato", "red", "pi"},
    "farred": {"cy5", "af647", "alexa647", "af680", "farred", "cy7"},
    "bf": {"bf", "brightfield", "tl", "phase", "dic", "trans", "ph"},
}
_CONTAINS = (
    ("nucleus", ("dapi", "hoechst")),
    ("edu", ("edu",)),
    ("farred", ("647", "680", "cy5", "farred")),
    ("red", ("555", "568", "594", "cy3", "rfp", "cherry", "tritc", "texas", "tomato")),
    ("green", ("488", "gfp", "fitc")),
    ("bf", ("bright", "phase", "dic", "trans")),
)
_CHANNEL_TOKEN = re.compile(r"^(ch|c|w)\d{1,2}$", re.I)
KIND_ORDER = ("edu", "green", "red", "farred", "other")


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def kind_of_name(name: str) -> str | None:
    norm = _norm(name)
    if not norm:
        return None
    for kind, tokens in _EXACT.items():
        if norm in tokens:
            return kind
    for kind, parts in _CONTAINS:
        if any(p in norm for p in parts):
            return kind
    return None


def channel_kind(channel: dict[str, Any], file_name: str = "") -> str:
    """nucleus / edu / green / red / farred / bf / other, from the channel's name, emission
    wavelength or colour, and finally the file name."""
    kind = kind_of_name(channel.get("name") or "")
    if kind:
        return kind
    em = channel.get("emission_nm")
    if em:
        em = float(em)
        return "nucleus" if em < 490 else "green" if em < 560 else "red" if em < 640 else "farred"
    color = [int(c) for c in (channel.get("color") or [])[:3]]
    if len(color) == 3 and max(color) > 0 and not (min(color) > 200):
        r, g, b = color
        if b > r and b > g:
            return "nucleus"
        if g > r and g > b:
            return "green"
        if r >= g and b > 120:
            return "farred"
        if r > g:
            return "red"
    for token in reversed([t for t in re.split(r"[^A-Za-z0-9]+", Path(file_name).stem) if t]):
        kind = kind_of_name(token) if _norm(token) in set().union(*_EXACT.values()) else None
        if kind:
            return kind
    return "other"


def _fluorescent(kind: str) -> bool:
    return kind not in ("nucleus", "bf")


def pick_edu(kinds: list[tuple[Any, str]], edu_kind: str) -> Any | None:
    """The EdU candidate among (item, kind) pairs: an explicit "EdU" channel first, then the
    requested colour (auto: green, red, far red, anything else fluorescent)."""
    candidates = [(item, k) for item, k in kinds if _fluorescent(k)]
    if not candidates:
        return None
    order = KIND_ORDER if edu_kind == "auto" else ("edu", edu_kind)
    for wanted in order:
        for item, k in candidates:
            if k == wanted:
                return item
    return None


def resolve_channels(channels: list[dict[str, Any]], file_name: str, params: EduParams) -> tuple[int | None, int | None]:
    """Nuclear and EdU channel indexes inside one multi-channel file."""
    n = len(channels)
    kinds = [(i, channel_kind(ch, file_name)) for i, ch in enumerate(channels)]
    nuc = params.nucleus_channel if params.nucleus_channel is not None and params.nucleus_channel < n else None
    if nuc is None:
        nuc = next((i for i, k in kinds if k == "nucleus"), None)
    edu = params.edu_channel if params.edu_channel is not None and params.edu_channel < n else None
    if edu is None:
        edu = pick_edu([(i, k) for i, k in kinds if i != nuc], params.edu_kind)
    return nuc, edu


def field_key(name: str) -> tuple[str, str]:
    """(lower-case key, display name) of a single-channel file's field: the file name without
    its channel token (the last fluorophore / "ch00" / "w1" token)."""
    stem = Path(name).stem
    parts = re.split(r"([_\-\s.]+)", stem)  # keep separators to rebuild the display name
    tokens = [i for i in range(0, len(parts), 2) if parts[i]]
    known = set().union(*_EXACT.values())
    drop = None
    for i in reversed(tokens):
        if _norm(parts[i]) in known or _CHANNEL_TOKEN.match(parts[i]):
            drop = i
            break
    if drop is None:
        return stem.lower(), stem
    kept = [parts[i] for i in tokens if i != drop]
    seps = [parts[i] for i in range(1, len(parts), 2)]
    sep = seps[0] if seps else "_"
    display = sep.join(kept) or stem
    return display.lower(), display


def pair_files(files: list[dict[str, Any]], edu_kind: str = "auto") -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Fields of view among workspace file records.

    Returns (units, unpaired). A unit is {"file_id", "partner" (EdU file id or None), "name"};
    unpaired entries are {"file_id", "name", "reason"} with reason no_nucleus / no_edu."""
    params = EduParams(edu_kind=edu_kind if edu_kind in EDU_KINDS else "auto")
    units: list[dict[str, Any]] = []
    unpaired: list[dict[str, Any]] = []
    singles: dict[tuple[str, str], list[tuple[dict[str, Any], str, str]]] = {}
    for rec in files:
        name = str(rec.get("name") or rec.get("id"))
        channels = [c for c in (rec.get("channels") or []) if isinstance(c, dict)]
        if len(channels) >= 2:
            nuc, edu = resolve_channels(channels, name, params)
            if nuc is None:
                unpaired.append({"file_id": rec["id"], "name": name, "reason": "no_nucleus"})
            elif edu is None:
                unpaired.append({"file_id": rec["id"], "name": name, "reason": "no_edu"})
            else:
                units.append({"file_id": rec["id"], "partner": None, "name": Path(name).stem})
            continue
        kind = channel_kind(channels[0] if channels else {}, name)
        key, display = field_key(name)
        singles.setdefault((rec.get("folder") or "", key), []).append((rec, kind, display))
    for (_, _), members in singles.items():
        nuclei = [m for m in members if m[1] == "nucleus"]
        edu = pick_edu([(m, m[1]) for m in members if m[1] != "nucleus"], params.edu_kind)
        if nuclei and edu is not None:
            nuc = nuclei[0]
            units.append({"file_id": nuc[0]["id"], "partner": edu[0]["id"], "name": nuc[2]})
            used = {nuc[0]["id"], edu[0]["id"]}
            reason = None
        else:
            used = set()
            reason = "no_edu" if nuclei else "no_nucleus"
        for rec, kind, _ in members:
            if rec["id"] in used or kind == "bf":
                continue
            if reason is None:
                # A third channel next to a complete pair (e.g. DAPI + GFP + RFP): not used.
                continue
            unpaired.append({"file_id": rec["id"], "name": str(rec.get("name")), "reason": reason})
    units.sort(key=lambda u: u["name"].lower())
    return units, unpaired


# --- image processing ---------------------------------------------------------------------


def estimate_background(img: np.ndarray, radius: float) -> np.ndarray:
    """Smooth background under bright objects: grey opening with a (2r+1)² window on a
    min-shrunk copy, box-smoothed and enlarged back (bilinear)."""
    radius = max(2.0, float(radius))
    f = int(max(1, min(8, radius // 6)))
    h, w = img.shape
    if f > 1:
        hs, ws = math.ceil(h / f), math.ceil(w / f)
        pad = np.pad(img, ((0, hs * f - h), (0, ws * f - w)), mode="edge")
        small = pad.reshape(hs, f, ws, f).min(axis=(1, 3))
    else:
        small = img
    size = max(3, int(2 * radius / f) | 1)
    bg = ndimage.grey_opening(small, size=(size, size), mode="nearest")
    bg = ndimage.uniform_filter(bg, size=size, mode="nearest")
    if f == 1:
        return bg
    ys = (np.arange(h) + 0.5) / f - 0.5
    xs = (np.arange(w) + 0.5) / f - 0.5
    yy, xx = np.meshgrid(np.clip(ys, 0, small.shape[0] - 1), np.clip(xs, 0, small.shape[1] - 1), indexing="ij")
    return ndimage.map_coordinates(bg, [yy, xx], order=1, mode="nearest").astype(np.float32)


def _auto_level(values: np.ndarray, method: str) -> float:
    from skimage import filters

    values = np.asarray(values, np.float32)
    lo, hi = float(values.min()), float(values.max())
    if hi <= lo:
        return lo
    if method == "li":
        return float(filters.threshold_li(values))
    if method == "triangle":
        return float(filters.threshold_triangle(values, nbins=256))
    return float(filters.threshold_otsu(values, nbins=256))


def estimate_diameter(smoothed: np.ndarray) -> float:
    """Typical object diameter (px) from a quick Otsu pass with a coarse background removal."""
    coarse = smoothed - estimate_background(smoothed, min(smoothed.shape) / 10)
    mask = coarse > _auto_level(coarse, "otsu")
    mask = ndimage.binary_opening(mask, iterations=1)
    labels, n = ndimage.label(mask)
    if n == 0:
        return 20.0
    areas = np.bincount(labels.ravel())[1:]
    areas = areas[areas >= 10]
    if areas.size == 0:
        return 20.0
    d = 2.0 * math.sqrt(float(np.median(areas)) / math.pi)
    return float(min(max(d, 4.0), min(smoothed.shape) / 4))


def _disk(radius: int) -> np.ndarray:
    yy, xx = np.mgrid[-radius : radius + 1, -radius : radius + 1]
    return (xx * xx + yy * yy) <= radius * radius


def prepare(plane: np.ndarray, sigma: float, radius: float) -> tuple[np.ndarray, np.ndarray]:
    """(smoothed − background, raw − background), both float32 and ≥ 0."""
    raw = np.asarray(plane, np.float32)
    smooth = ndimage.gaussian_filter(raw, sigma) if sigma > 0 else raw
    bg = estimate_background(smooth, radius)
    return np.clip(smooth - bg, 0, None), np.clip(raw - bg, 0, None)


def segment(
    img: np.ndarray,
    *,
    method: str,
    factor: float,
    manual: float,
    diameter: float,
    split: bool,
    strength: float,
    min_area: int,
    max_area: int,
    exclude_border: bool,
) -> tuple[np.ndarray, float, float]:
    """Labels (1…n, sequential), the threshold level and the median object area."""
    from skimage import measure, morphology, segmentation

    level = float(manual) if method == "manual" else _auto_level(img, method) * float(factor)
    mask = img > level
    r = max(1, int(round(diameter / 12)))
    mask = ndimage.binary_opening(mask, structure=_disk(r))
    mask = ndimage.binary_fill_holes(mask)
    if split:
        dist = ndimage.gaussian_filter(ndimage.distance_transform_edt(mask).astype(np.float32), 1.0)
        markers = measure.label(morphology.h_maxima(dist, float(strength)))
        labels = segmentation.watershed(-dist, markers, mask=mask)
        # Components without a seed (smaller than h) keep a label of their own.
        rest, n_rest = ndimage.label(mask & (labels == 0))
        if n_rest:
            labels = np.where(rest > 0, rest + labels.max(), labels)
    else:
        labels = measure.label(mask)
    n = int(labels.max())
    if n == 0:
        return labels.astype(np.int32), level, 0.0
    areas = np.bincount(labels.ravel(), minlength=n + 1)
    real = areas[1:][areas[1:] >= 10]
    median = float(np.median(real)) if real.size else 0.0
    lo = int(min_area) if min_area else int(0.25 * median)
    keep = areas >= max(lo, 1)
    if max_area:
        keep &= areas <= max_area
    keep[0] = False
    if exclude_border:
        border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
        keep[border] = False
    lut = np.zeros(n + 1, np.int32)
    lut[keep] = np.arange(1, int(keep.sum()) + 1, dtype=np.int32)
    return lut[labels], level, median


MAX_OUTLINE_POINTS = 24


def _outlines(labels: np.ndarray) -> list[list[int]]:
    """One polygon per label as a flat [x0, y0, x1, y1, …] list in whole pixels (≤ ~24
    points: thousands of nuclei are drawn and stored at once)."""
    from skimage.measure import find_contours

    out: list[list[int]] = []
    for key, sl in enumerate(ndimage.find_objects(labels), start=1):
        if sl is None:
            out.append([])
            continue
        crop = np.pad(labels[sl] == key, 1).astype(np.uint8)
        contours = find_contours(crop, 0.5)
        if not contours:
            out.append([])
            continue
        pts = max(contours, key=len)[:-1]
        step = max(1, round(len(pts) / MAX_OUTLINE_POINTS))
        pts = pts[::step]
        y0, x0 = sl[0].start, sl[1].start
        # Contour index i ↔ pixel column x0 + i - 1 (padding), whose centre is at +0.5.
        xy = np.rint(pts[:, ::-1] + np.array([x0 - 0.5, y0 - 0.5])).astype(int)
        out.append(xy.ravel().tolist())
    return out


def _objects(labels: np.ndarray, measures: dict[str, np.ndarray]) -> list[dict[str, Any]]:
    n = int(labels.max())
    if n == 0:
        return []
    index = np.arange(1, n + 1)
    areas = np.bincount(labels.ravel(), minlength=n + 1)[1:]
    centers = ndimage.center_of_mass(np.ones_like(labels, np.uint8), labels, index)
    values = {k: ndimage.mean(img, labels, index) for k, img in measures.items()}
    outlines = _outlines(labels)
    objs = []
    for i in range(n):
        cy, cx = centers[i]
        item = {"key": i + 1, "outline": outlines[i], "cx": round(float(cx) + 0.5, 1), "cy": round(float(cy) + 0.5, 1), "area": int(areas[i])}
        for k, v in values.items():
            item[k] = round(float(v[i]), 3)
        objs.append(item)
    return objs


def analyze(nucleus_plane: np.ndarray, edu_plane: np.ndarray, params: EduParams | None = None, um_per_px: float | None = None) -> dict[str, Any]:
    """Segment and measure one field. Classification happens later (`classify`)."""
    params = params or EduParams()
    nuc = np.asarray(nucleus_plane)
    edu = np.asarray(edu_plane)
    if nuc.ndim != 2 or edu.ndim != 2:
        raise ValueError("Expected two 2-D channels.")
    if nuc.shape != edu.shape:
        raise ValueError(f"The nuclear and EdU images differ in size ({nuc.shape[1]}×{nuc.shape[0]} vs {edu.shape[1]}×{edu.shape[0]}).")
    sigma = params.smooth_sigma
    smooth0 = ndimage.gaussian_filter(nuc.astype(np.float32), sigma) if sigma > 0 else nuc.astype(np.float32)
    diameter = estimate_diameter(smooth0)
    radius = params.background_radius or max(8.0, 1.2 * diameter)
    nuc_seg, nuc_meas = prepare(nuc, sigma, radius)
    edu_seg, edu_meas = prepare(edu, sigma, radius)
    common = {"diameter": diameter, "split": params.split_touching, "strength": params.split_strength, "max_area": params.max_area, "exclude_border": params.exclude_border}
    labels, nuc_level, median = segment(
        nuc_seg, method=params.nucleus_method, factor=params.nucleus_factor, manual=params.nucleus_threshold, min_area=params.min_area, **common
    )
    nuclei = _objects(labels, {"dapi": nuc_meas, "edu": edu_meas})
    if median > 0:
        diameter = 2.0 * math.sqrt(median / math.pi)
    # Independent count: EdU objects need the size of a nucleus to be counted.
    edu_labels, edu_level, _ = segment(
        edu_seg,
        method=params.edu_seg_method,
        factor=params.edu_seg_factor,
        manual=params.edu_seg_threshold,
        min_area=params.min_area or int(0.25 * median),
        **{**common, "diameter": diameter},
    )
    objects = _objects(edu_labels, {"mean": edu_meas})
    means = np.array([n["edu"] for n in nuclei], np.float64)
    return {
        "width": int(nuc.shape[1]),
        "height": int(nuc.shape[0]),
        "background_radius": round(float(radius), 1),
        "diameter": round(float(diameter), 1),
        "median_area": round(float(median), 1),
        "nucleus_level": round(float(nuc_level), 3),
        "edu_seg_level": round(float(edu_level), 3),
        "auto_thresholds": {m: auto_threshold(means, m) for m in EDU_METHODS if m != "manual"},
        "um_per_px": um_per_px or None,
        "nuclei": nuclei,
        "edu_objects": objects,
    }


# --- classification and statistics -------------------------------------------------------------


def auto_threshold(values: Any, method: str = "li") -> float | None:
    """Cut-off between EdU− and EdU+ per-nucleus means."""
    from skimage import filters

    arr = np.asarray([v for v in values if v is not None and np.isfinite(v)], np.float64)
    if arr.size < 2 or float(arr.max()) <= float(arr.min()):
        return None
    if method == "otsu":
        level = filters.threshold_otsu(arr, nbins=256)
    elif method == "li":
        level = filters.threshold_li(arr)
    else:
        level = math.expm1(filters.threshold_otsu(np.log1p(np.clip(arr, 0, None)), nbins=256))
    return round(float(level), 3)


def classify(means: list[float], threshold: float | None, marks: dict[str, str] | None = None) -> list[str]:
    """positive / negative / excluded per nucleus (index i ↔ key i + 1)."""
    marks = marks or {}
    out = []
    for i, value in enumerate(means):
        mark = marks.get(str(i + 1))
        if mark in ("positive", "negative", "excluded"):
            out.append(mark)
        else:
            out.append("positive" if threshold is not None and value > threshold else "negative")
    return out


def counts(means: list[float], threshold: float | None, marks: dict[str, str] | None, n_objects: int, deleted: list[int] | None) -> dict[str, Any]:
    flags = classify(means, threshold, marks)
    nuclei = sum(1 for f in flags if f != "excluded")
    positive = sum(1 for f in flags if f == "positive")
    independent = max(0, n_objects - len(set(deleted or [])))
    return {
        "nuclei": nuclei,
        "positive": positive,
        "independent": independent,
        "excluded": len(flags) - nuclei,
        "ratio": positive / nuclei if nuclei else None,
        "ratio_independent": independent / nuclei if nuclei else None,
    }
