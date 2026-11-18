"""Comet assay (single-cell gel electrophoresis) analysis — a re-implementation of OpenComet.

OpenComet (Gyori et al., Redox Biology 2014; ImageJ plugin OpenComet_.jar v1.3) finds comets,
locates the head and reports head/tail DNA content and tail moments. This module follows the
plugin step by step, with its constants:

1. 8-bit grey image (16-bit scaled by min/max; colour images: the brightest channel).
2. Segmentation copy only: median filter (radius 10) + rolling-ball background (radius
   0.3 × the short side), Huang threshold, opening (3 × 3×3 min, 3 × 3×3 max), particles of
   ≥ 400 px (8-connected, holes filled) that do not touch the border.
3. Shape filters on the traced outline: convexity < 0.85, symmetry > 0.5, height ≥ 2 × width,
   on the edge, centre-line offset > 0.2 → invalid; offset > 0.15 or area beyond 2 σ → outlier.
4. Each remaining comet becomes its convex hull. The head is a disc touching the hull's left
   edge, sized at the column of the brightest region (top 5 % of the comet's histogram) or
   from the smoothed intensity profile ("auto" tries brightest first).
5. Background under the comet: column means of a strip above (or below) it, 5-tap smoothed,
   subtracted in place in comet order.
6. Metrics (pixels, 8-bit intensities): comet / head / tail area, intensity, length, DNA,
   DNA %, tail moment (tail length × tail DNA fraction), Olive moment (tail DNA fraction ×
   distance between the intensity-median columns of tail and head).

Comets must lie horizontally with the head on the left; other directions are rotated first
(`tail` parameter) and coordinates are mapped back. Per-comet values keep OpenComet's quirks
(integer division in the height/width ratio, the first-column top of the bright region) so
numbers can be compared; summary statistics use a correct median (the plugin's is off for
even counts).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull, QhullError

HeadMode = Literal["auto", "profile", "brightest"]
TailDirection = Literal["right", "left", "up", "down"]

MIN_AREA = 400
MEDIAN_RADIUS = 10
ROLLING_BALL_FACTOR = 0.3

METRICS = (
    "CometArea", "CometIntensity", "CometLength", "CometDNA",
    "HeadArea", "HeadIntensity", "HeadLength", "HeadDNA", "HeadDNAPercent",
    "TailArea", "TailIntensity", "TailLength", "TailDNA", "TailDNAPercent",
    "TailMoment", "OliveMoment",
)


@dataclass
class CometParams:
    channel: int | None = None  # None: the brightest channel
    tail: TailDirection = "right"
    background_correction: bool = True
    head_mode: HeadMode = "auto"
    min_area: int = MIN_AREA

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> "CometParams":
        raw = raw or {}
        out = cls()
        if raw.get("channel") is not None:
            out.channel = int(raw["channel"])
        if raw.get("tail") in ("right", "left", "up", "down"):
            out.tail = raw["tail"]
        if "background_correction" in raw:
            out.background_correction = bool(raw["background_correction"])
        if raw.get("head_mode") in ("auto", "profile", "brightest"):
            out.head_mode = raw["head_mode"]
        if raw.get("min_area"):
            out.min_area = max(16, int(raw["min_area"]))
        return out


# --- grey conversion --------------------------------------------------------------


def to_gray8(planes: list[np.ndarray], channel: int | None = None) -> tuple[np.ndarray, int]:
    """8-bit image of one channel (the brightest one unless given), scaled like ImageJ's
    16→8-bit conversion: v8 = min(255, int((v - min) · 256 / (max - min + 1) + 0.5))."""
    if not planes:
        raise ValueError("No image data.")
    if channel is None or not 0 <= channel < len(planes):
        means = [float(np.asarray(p, dtype=np.float64).mean()) for p in planes]
        channel = int(np.argmax(means))
    plane = np.asarray(planes[channel])
    if plane.dtype == np.uint8:
        return plane.copy(), channel
    data = plane.astype(np.float64)
    lo, hi = float(data.min()), float(data.max())
    scale = 256.0 / (hi - lo + 1.0)
    out = np.minimum(255, np.floor((data - lo) * scale + 0.5))
    return out.astype(np.uint8), channel


# --- preprocessing (segmentation copy) -----------------------------------------------


def _disk(radius: float) -> np.ndarray:
    r = int(math.ceil(radius))
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    return (xx * xx + yy * yy) <= radius * radius + 1  # ImageJ RankFilters kernel


def median_filter(img: np.ndarray, radius: float = MEDIAN_RADIUS) -> np.ndarray:
    from skimage.filters.rank import median

    r = int(math.ceil(radius))
    padded = np.pad(img, r, mode="edge")  # ImageJ uses the nearest edge pixel outside
    return median(padded, _disk(radius))[r:-r, r:-r]


def subtract_background(img: np.ndarray, radius: float) -> np.ndarray:
    """Rolling-ball background subtraction like ImageJ: on a min-shrunk copy for large radii,
    background interpolated back up, result = max(0, value − background) (rounded)."""
    from skimage.restoration import rolling_ball

    shrink = 1 if radius <= 10 else 2 if radius <= 30 else 4 if radius <= 100 else 8
    h, w = img.shape
    data = img.astype(np.float32)
    if shrink > 1:
        hs, ws = math.ceil(h / shrink), math.ceil(w / shrink)
        pad = np.pad(data, ((0, hs * shrink - h), (0, ws * shrink - w)), mode="edge")
        small = pad.reshape(hs, shrink, ws, shrink).min(axis=(1, 3))
        bg_small = rolling_ball(small, radius=max(1.0, radius / shrink))
        # Bilinear enlargement back to full size (sample at pixel centres).
        ys = (np.arange(h) + 0.5) / shrink - 0.5
        xs = (np.arange(w) + 0.5) / shrink - 0.5
        yy, xx = np.meshgrid(np.clip(ys, 0, hs - 1), np.clip(xs, 0, ws - 1), indexing="ij")
        background = ndimage.map_coordinates(bg_small, [yy, xx], order=1, mode="nearest")
    else:
        background = rolling_ball(data, radius=radius)
    return np.clip(np.floor(data - background + 0.5), 0, 255).astype(np.uint8)


def huang_threshold(hist: np.ndarray) -> int:
    """ImageJ AutoThresholder "Huang" (fuzzy entropy, Huang & Wang 1995) on 256 bins."""
    data = np.asarray(hist, dtype=np.float64)
    nz = np.nonzero(data)[0]
    if nz.size == 0:
        return 0
    first, last = int(nz[0]), int(nz[-1])
    if last == first:
        return first
    term = 1.0 / (last - first)
    bins = np.arange(256, dtype=np.float64)
    mu0 = np.zeros(256)
    csum = np.cumsum((bins * data)[first:])
    cnum = np.cumsum(data[first:])
    mu0[first:] = csum / np.where(cnum > 0, cnum, 1)
    mu1 = np.zeros(256)
    rsum = np.cumsum((bins * data)[last:0:-1])
    rnum = np.cumsum(data[last:0:-1])
    # mu1[ih - 1] for ih = last … 1
    mu1[np.arange(last, 0, -1) - 1] = rsum / np.where(rnum > 0, rnum, 1)

    best_t, best = -1, math.inf
    for t in range(256):
        mu = np.concatenate([1.0 / (1.0 + term * np.abs(bins[: t + 1] - mu0[t])), 1.0 / (1.0 + term * np.abs(bins[t + 1 :] - mu1[t]))])
        with np.errstate(divide="ignore", invalid="ignore"):
            terms = data * (-mu * np.log(mu) - (1.0 - mu) * np.log(1.0 - mu))
        terms[(mu < 1e-06) | (mu > 0.999999)] = 0.0
        # Left-to-right accumulation, like the Java loop (np.sum would sum pairwise and can
        # pick a different bin when two entropies are within rounding of each other).
        ent = float(np.cumsum(terms)[-1])
        if ent < best:
            best, best_t = ent, t
    return best_t


def segment(gray: np.ndarray, background_correction: bool = True) -> np.ndarray:
    seg = gray
    if background_correction:
        seg = median_filter(seg)
        seg = subtract_background(seg, ROLLING_BALL_FACTOR * min(seg.shape))
    level = huang_threshold(np.bincount(seg.ravel(), minlength=256))
    mask = seg > level  # dark background: foreground = pixels above the Huang level
    # ImageJ binary dilate() ×3 then erode() ×3 with a normal LUT = opening of the foreground.
    opened = ndimage.minimum_filter(mask.astype(np.uint8), size=7, mode="nearest")
    opened = ndimage.maximum_filter(opened, size=7, mode="nearest")
    return opened.astype(bool)


# --- geometry helpers ------------------------------------------------------------------


@dataclass
class Shape:
    """A region as a boolean mask over its bounding box (absolute offset x, y)."""

    x: int
    y: int
    mask: np.ndarray

    @property
    def w(self) -> int:
        return int(self.mask.shape[1])

    @property
    def h(self) -> int:
        return int(self.mask.shape[0])

    @property
    def area(self) -> int:
        return int(self.mask.sum())

    def values(self, img: np.ndarray) -> np.ndarray:
        return img[self.y : self.y + self.h, self.x : self.x + self.w][self.mask]


def _tight(x: int, y: int, mask: np.ndarray) -> Shape | None:
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return None
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    return Shape(x + int(x0), y + int(y0), mask[y0 : y1 + 1, x0 : x1 + 1].copy())


def _corner_points(shape: Shape) -> np.ndarray:
    """Pixel corners (absolute, ImageJ coordinates) of the region's boundary pixels."""
    m = shape.mask
    edge = m & ~ndimage.binary_erosion(m, structure=np.ones((3, 3), bool), border_value=0)
    ys, xs = np.nonzero(edge)
    xs = xs + shape.x
    ys = ys + shape.y
    return np.concatenate(
        [np.stack([xs + dx, ys + dy], axis=1) for dx in (0, 1) for dy in (0, 1)]
    ).astype(np.float64)


def convex_hull(shape: Shape) -> tuple[Shape, np.ndarray, float]:
    """Convex hull of the traced outline: (pixels whose centres lie inside, polygon vertices,
    polygon perimeter) — like ImageJ's PolygonRoi(roi.getConvexHull())."""
    pts = _corner_points(shape)
    try:
        hull = ConvexHull(pts)
    except (QhullError, ValueError):
        return shape, pts[:4], 4.0
    poly = pts[hull.vertices]
    x0, y0 = int(math.floor(poly[:, 0].min())), int(math.floor(poly[:, 1].min()))
    x1, y1 = int(math.ceil(poly[:, 0].max())), int(math.ceil(poly[:, 1].max()))
    yy, xx = np.mgrid[y0:y1, x0:x1]
    cx = xx + 0.5
    cy = yy + 0.5
    inside = np.ones(cx.shape, bool)
    n = len(poly)
    for i in range(n):  # convex, counter-clockwise from qhull: inside = left of every edge
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        inside &= (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) >= -1e-9
    tight = _tight(x0, y0, inside) or shape
    return tight, poly, float(hull.area)  # 2-D ConvexHull.area is the perimeter


def front_centroid(shape: Shape) -> int:
    """Mean y of the pixels in the first 10 % of columns (absolute, truncated)."""
    cols = max(1, min(shape.w, math.ceil(0.1 * shape.w)))  # columns c with c < 0.1·w
    ys, _ = np.nonzero(shape.mask[:, :cols])
    if ys.size == 0:
        return shape.y + shape.h // 2
    return int(shape.y + ys.mean())


def symmetry(shape: Shape, fc: int) -> float:
    rel = fc - shape.y
    up = shape.mask[: max(rel, 0), :].sum(axis=0)
    down = shape.mask[max(rel, 0) :, :].sum(axis=0)
    total = up + down
    with np.errstate(divide="ignore", invalid="ignore"):
        per = np.where(total > 0, np.abs(down - up) / np.maximum(total, 1), 0.0)
    return float(per.sum() / shape.w)


def x_intensity_centroid(shape: Shape, img: np.ndarray) -> int:
    """First absolute column where the running sum of the region's intensity passes half."""
    sub = img[shape.y : shape.y + shape.h, shape.x : shape.x + shape.w].astype(np.float64) * shape.mask
    cols = sub.sum(axis=0)
    half = cols.sum() / 2.0
    run = np.cumsum(cols)
    idx = np.nonzero(run > half)[0]
    return int(shape.x + idx[0]) if idx.size else shape.x + shape.w


# --- head finding -----------------------------------------------------------------------


def _same(a: np.ndarray, ker: np.ndarray) -> np.ndarray:
    half = len(ker) // 2
    padded = np.pad(a, (half, len(ker) - 1 - half))
    return np.correlate(padded, ker, mode="valid")


def head_edge(hull: Shape, img: np.ndarray, circularity: float) -> int:
    fc = front_centroid(hull)
    if circularity < 0.9:
        band_y0, band_h = fc - 5, 10
    else:
        band_y0, band_h = hull.y, hull.h
    sub = np.zeros((band_h, hull.w), np.float64)
    for r in range(band_h):
        yy = band_y0 + r
        ry = yy - hull.y
        if 0 <= yy < img.shape[0] and 0 <= ry < hull.h:
            sub[r] = img[yy, hull.x : hull.x + hull.w] * hull.mask[ry]
    prof = sub.sum(axis=0) / band_h
    k = max(1, hull.w // 10)
    box = np.full(k, 1.0 / k)
    s3 = _same(np.diff(_same(np.diff(_same(prof, box)), box)), box)
    t = 0
    for i in range(0, len(s3) - 1):
        if s3[i] < 0 < s3[i + 1]:
            t = i
            break
    for i in range(max(1, t), len(s3) - 1):
        if s3[i - 1] <= s3[i] >= s3[i + 1]:
            return i
    return hull.w


def _disc_head(hull: Shape, r: int) -> Shape | None:
    """OvalRoi(hull.x, fc − r, 2r, 2r) ∩ hull."""
    if r <= 0:
        return None
    fc = front_centroid(hull)
    cx, cy = hull.x + r, fc
    yy, xx = np.mgrid[hull.y : hull.y + hull.h, hull.x : hull.x + hull.w]
    disc = ((xx + 0.5 - cx) ** 2 + (yy + 0.5 - cy) ** 2) <= r * r
    return _tight(hull.x, hull.y, disc & hull.mask)


def brightest_head(hull: Shape, img: np.ndarray, hist: np.ndarray, circularity: float) -> tuple[Shape | None, int, bool]:
    valid = True
    total = hist[:255].sum()
    cum = np.cumsum(hist[:255])
    idx = np.nonzero(cum > 0.95 * total)[0]
    t = int(idx[0]) - 1 if idx.size else 0
    crop = img[hull.y : hull.y + hull.h, hull.x : hull.x + hull.w] >= t
    cols = np.nonzero(crop.any(axis=0))[0]
    if cols.size == 0:
        return None, 0, False
    min_x, max_x = int(cols[0]), int(cols[-1])
    min_y = int(np.nonzero(crop[:, min_x])[0][0])  # OpenComet takes the first column's top
    max_y = int(np.nonzero(crop.any(axis=1))[0][-1])
    if circularity < 0.9 and (max_x - min_x) > 2 * (max_y - min_y):
        valid = False  # head is too long
    ys, xs = np.nonzero(crop)
    cx = int(xs.mean() + 0.5)
    r = int(hull.mask[:, min(cx, hull.w - 1)].sum()) // 2
    if cx - r > 0:
        valid = False  # head is at the wrong place
    head = _disc_head(hull, r)
    if head is None:
        valid = False
    return head, r, valid


# --- per-comet processing ------------------------------------------------------------------


def _correct_background(img: np.ndarray, hull: Shape) -> None:
    bg_h = int(max(hull.h / 5.0, 10.0))
    y0 = hull.y - bg_h if hull.y - bg_h >= 0 else hull.y + hull.h
    strip = np.zeros((bg_h, hull.w), np.float64)
    for r in range(bg_h):
        yy = y0 + r
        if 0 <= yy < img.shape[0]:
            strip[r] = img[yy, hull.x : hull.x + hull.w]
    bg = strip.mean(axis=0)
    smooth = np.array([bg[max(0, i - 2) : min(hull.w, i + 3)].mean() for i in range(hull.w)])
    region = img[hull.y : hull.y + hull.h, hull.x : hull.x + hull.w]
    corrected = np.maximum(0, np.trunc(region.astype(np.float64) - smooth[None, :]))
    region[hull.mask] = corrected[hull.mask].astype(img.dtype)


@dataclass
class Particle:
    key: int
    shape: Shape
    status: str = "valid"
    reasons: list[str] = field(default_factory=list)


def analyze(planes: list[np.ndarray], params: CometParams | None = None, um_per_px: float | None = None) -> dict[str, Any]:
    """Find and measure the comets of one image. Returns channel, image size and per-comet
    results (contours in original image coordinates)."""
    params = params or CometParams()
    gray0, channel = to_gray8(planes, params.channel)
    oh, ow = gray0.shape
    gray = _orient(gray0, params.tail)
    h, w = gray.shape
    mask = segment(gray, params.background_correction)

    labels, n = ndimage.label(mask, structure=np.ones((3, 3), bool))
    particles: list[Particle] = []
    for key, sl in enumerate(ndimage.find_objects(labels) if n else [], start=1):
        if sl is None:
            continue
        comp = ndimage.binary_fill_holes(labels[sl] == key)
        if int(comp.sum()) < params.min_area:
            continue
        x0, y0 = sl[1].start, sl[0].start
        if x0 == 0 or y0 == 0 or sl[1].stop >= w or sl[0].stop >= h:
            continue  # ImageJ EXCLUDE_EDGE_PARTICLES
        particles.append(Particle(key=len(particles) + 1, shape=Shape(x0, y0, comp)))

    meas = gray.copy()
    # Shape filters on the traced outline.
    for part in particles:
        s = part.shape
        hull, _, _ = convex_hull(s)
        fc = front_centroid(s)
        convexity = s.area / max(hull.area, 1)
        sym = symmetry(s, fc)
        hratio = float(s.h // s.w)
        centerline = abs(fc - (s.y + s.h // 2)) / s.h
        if convexity < 0.85:
            part.reasons.append("convexity")
        if sym > 0.5:
            part.reasons.append("symmetry")
        if hratio > 1.05:
            part.reasons.append("height")
        if s.x <= 1 or s.y <= 1 or s.x + s.w >= w - 1 or s.y + s.h >= h - 1:
            part.reasons.append("edge")
        if centerline > 0.2:
            part.reasons.append("centerline")
        if part.reasons:
            part.status = "invalid"
        elif centerline > 0.15:
            part.status = "outlier"
            part.reasons.append("centerline")
    valid = [p for p in particles if p.status == "valid"]
    if valid:
        areas = np.array([p.shape.area for p in valid], np.float64)
        mean_a, std_a = areas.mean(), areas.std()
        for p in valid:
            if abs(p.shape.area - mean_a) > 2.0 * std_a:
                p.status = "outlier"
                p.reasons.append("area")

    comets: list[dict[str, Any]] = []
    num = 0
    for part in particles:
        outline = _outline(part.shape)
        entry: dict[str, Any] = {
            "key": part.key,
            "status": part.status,
            "reasons": part.reasons,
            "outline": _map_points(outline, params.tail, ow, oh),
        }
        if part.status == "invalid":
            comets.append(entry)
            continue
        num += 1
        entry["num"] = num
        hull, poly, perimeter = convex_hull(part.shape)
        hist = np.bincount(hull.values(meas), minlength=256)
        circ = 4.0 * math.pi * hull.area / (perimeter * perimeter) if perimeter > 0 else 0.0
        head: Shape | None = None
        r = 0
        ok = False
        if params.head_mode in ("auto", "brightest"):
            head, r, ok = brightest_head(hull, meas, hist, circ)
        if (params.head_mode == "auto" and not ok) or params.head_mode == "profile":
            r = head_edge(hull, meas, circ) // 2
            head = _disc_head(hull, r)
        fc = front_centroid(hull)
        _correct_background(meas, hull)

        comet_vals = hull.values(meas).astype(np.float64)
        comet_area = float(hull.area)
        comet_int = float(comet_vals.mean()) if comet_vals.size else 0.0
        comet_dna = comet_area * comet_int
        head_area = float(head.area) if head else 0.0
        head_vals = head.values(meas).astype(np.float64) if head else np.zeros(0)
        head_int = float(head_vals.mean()) if head_vals.size else 0.0
        head_dna = head_area * head_int
        head_len = float(head.w) if head else 0.0
        tail_area = comet_area - head_area
        tail_dna = comet_dna - head_dna
        frac = tail_dna / comet_dna if comet_dna > 0 else 0.0
        tail_len = max(float(hull.w) - head_len, 0.0)
        head_cx = x_intensity_centroid(head, meas) if head else hull.x
        tail_mask = hull.mask.copy()
        if head:
            tail_mask[head.y - hull.y : head.y - hull.y + head.h, head.x - hull.x : head.x - hull.x + head.w] &= ~head.mask
        tail = _tight(hull.x, hull.y, tail_mask)
        tail_cx = x_intensity_centroid(tail, meas) if tail else head_cx
        metrics = {
            "CometArea": comet_area,
            "CometIntensity": comet_int,
            "CometLength": float(hull.w),
            "CometDNA": comet_dna,
            "HeadArea": head_area,
            "HeadIntensity": head_int,
            "HeadLength": head_len,
            "HeadDNA": head_dna,
            "HeadDNAPercent": 100.0 * head_dna / comet_dna if comet_dna > 0 else 0.0,
            "TailArea": tail_area,
            "TailIntensity": tail_dna / tail_area if tail_area > 0 else 0.0,
            "TailLength": tail_len,
            "TailDNA": tail_dna,
            "TailDNAPercent": 100.0 * frac,
            "TailMoment": tail_len * frac,
            "OliveMoment": frac * abs(tail_cx - head_cx),
        }
        if um_per_px and um_per_px > 0:
            metrics.update(
                {
                    "CometLength_um": metrics["CometLength"] * um_per_px,
                    "HeadLength_um": head_len * um_per_px,
                    "TailLength_um": tail_len * um_per_px,
                    "CometArea_um2": comet_area * um_per_px * um_per_px,
                    "TailMoment_um": metrics["TailMoment"] * um_per_px,
                    "OliveMoment_um": metrics["OliveMoment"] * um_per_px,
                }
            )
        # Column profiles (per bounding-box column, divided by the hull height as OpenComet).
        region = meas[hull.y : hull.y + hull.h, hull.x : hull.x + hull.w].astype(np.float64)
        comet_prof = (region * hull.mask).sum(axis=0) / hull.h
        head_prof = np.zeros(hull.w)
        if head:
            hm = np.zeros(hull.mask.shape, bool)
            hm[head.y - hull.y : head.y - hull.y + head.h, head.x - hull.x : head.x - hull.x + head.w] = head.mask
            head_prof = (region * hm).sum(axis=0) / hull.h
        entry.update(
            {
                "hull": _map_points(poly, params.tail, ow, oh),
                "head": {**_map_circle(hull.x + r, fc, params.tail, ow, oh), "r": r} if r > 0 else None,
                "metrics": {k: round(v, 4) for k, v in metrics.items()},
                "profiles": {
                    "comet": [round(float(v), 2) for v in comet_prof],
                    "head": [round(float(v), 2) for v in head_prof],
                    "tail": [round(float(v), 2) for v in comet_prof - head_prof],
                },
            }
        )
        comets.append(entry)
    return {"channel": channel, "width": ow, "height": oh, "comets": comets}


# --- orientation ---------------------------------------------------------------------------


def _orient(img: np.ndarray, tail: str) -> np.ndarray:
    """Rotate/flip so the tail points right (head on the left), as OpenComet expects."""
    if tail == "left":
        return img[:, ::-1].copy()
    if tail == "up":
        return np.rot90(img, k=-1).copy()
    if tail == "down":
        return np.rot90(img, k=1).copy()
    return img


def _map_xy(x: float, y: float, tail: str, ow: int, oh: int) -> tuple[float, float]:
    """Continuous (corner) coordinates in the oriented image → original image."""
    if tail == "left":
        return ow - x, y
    if tail == "up":
        return y, oh - x
    if tail == "down":
        return ow - y, x
    return x, y


def _map_points(points: np.ndarray, tail: str, ow: int, oh: int) -> list[list[float]]:
    return [[round(a, 1), round(b, 1)] for a, b in (_map_xy(float(x), float(y), tail, ow, oh) for x, y in points)]


def _map_circle(cx: float, cy: float, tail: str, ow: int, oh: int) -> dict[str, float]:
    x, y = _map_xy(cx, cy, tail, ow, oh)
    return {"cx": round(x, 1), "cy": round(y, 1)}


def _outline(shape: Shape) -> np.ndarray:
    """Boundary polygon of a region (for drawing), in absolute corner coordinates."""
    from skimage.measure import find_contours

    padded = np.pad(shape.mask.astype(np.float32), 1)
    contours = find_contours(padded, 0.5)
    if not contours:
        return np.zeros((0, 2))
    longest = max(contours, key=len)
    step = max(1, len(longest) // 160)
    pts = longest[::step]
    # find_contours gives (row, col) at pixel centres of the padded mask.
    return np.stack([pts[:, 1] - 1 + 0.5 + shape.x, pts[:, 0] - 1 + 0.5 + shape.y], axis=1)


# --- statistics ------------------------------------------------------------------------------


def describe(values: list[float]) -> dict[str, float | int | None]:
    """n, mean, SD (sample), SEM, median (proper), min, max."""
    arr = np.asarray([v for v in values if v is not None and np.isfinite(v)], np.float64)
    n = int(arr.size)
    if n == 0:
        return {"n": 0, "mean": None, "sd": None, "sem": None, "median": None, "min": None, "max": None}
    sd = float(arr.std(ddof=1)) if n > 1 else 0.0
    return {
        "n": n,
        "mean": float(arr.mean()),
        "sd": sd,
        "sem": sd / math.sqrt(n) if n > 1 else 0.0,
        "median": float(np.median(arr)),
        "min": float(arr.min()),
        "max": float(arr.max()),
    }
