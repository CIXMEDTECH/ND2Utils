import type { ChannelInfo, NucleusParams, NucleusResult, NucleusRoi, PackedPlane, ThresholdMethod } from "./types";

export const DEFAULT_NUCLEUS_PARAMS: NucleusParams = {
  channel_index: null,
  threshold_method: "Otsu",
  smooth_um: 0.5,
  min_area_um2: 30,
  max_area_um2: 2000,
  min_circularity: 0.4,
  watershed: true,
  ws_solidity: 0.9,
  exclude_edges: true,
};

/**
 * Identify the nuclear channel (DAPI / Hoechst / Blue / Cyan) matching Foci_Counter.groovy.
 */
export function identifyNucleusChannel(
  channels: Pick<ChannelInfo, "name" | "color">[],
  overrideIndex?: number | null,
): number {
  const n = channels.length;
  if (n === 0) return 0;
  if (overrideIndex !== undefined && overrideIndex !== null && overrideIndex >= 0 && overrideIndex < n) {
    return overrideIndex;
  }
  const keywords = ["dapi", "hoechst", "blue", "405", "nuc", "hoec"];
  for (let i = 0; i < n; i++) {
    const name = (channels[i].name || "").toLowerCase();
    if (keywords.some((kw) => name.includes(kw))) return i;
  }
  // LUT color Blue: b > 150 && r < 100 && g < 100
  for (let i = 0; i < n; i++) {
    const c = channels[i].color || [255, 255, 255];
    const [r = 255, g = 255, b = 255] = c;
    if (b > 150 && r < 100 && g < 100) return i;
  }
  // Fallback Cyan: b > 150 && g > 150 && r < 100
  for (let i = 0; i < n; i++) {
    const c = channels[i].color || [255, 255, 255];
    const [r = 255, g = 255, b = 255] = c;
    if (b > 150 && g > 150 && r < 100) return i;
  }
  return 0;
}

/**
 * Separable 2D Gaussian blur matching ImageJ Blur.gaussian(sigma).
 */
function gaussianBlur2D(plane: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma <= 0.3 || width < 2 || height < 2) {
    return new Float32Array(plane);
  }
  const radius = Math.max(1, Math.min(14, Math.ceil(sigma * 3)));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let ksum = 0;
  const twoSigmaSq = 2 * sigma * sigma;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / twoSigmaSq);
    kernel[i + radius] = w;
    ksum += w;
  }
  for (let i = 0; i < size; i++) kernel[i] /= ksum || 1;

  const temp = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        acc += plane[rowOffset + sx] * kernel[k + radius];
      }
      temp[rowOffset + x] = acc;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += temp[sy * width + x] * kernel[k + radius];
      }
      out[rowOffset + x] = acc;
    }
  }
  return out;
}

/**
 * ImageJ 256-bin AutoThresholder port (Otsu, Li, Huang, Triangle, Mean, IsoData, Moments).
 */
export function autoThreshold256(hist: Int32Array | number[], method: ThresholdMethod = "Otsu"): number {
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sumAll += i * hist[i];
  }
  if (total <= 0) return 128;

  const m = (method || "Otsu").toLowerCase();

  if (m === "mean") {
    return Math.min(254, Math.max(1, Math.floor(sumAll / total)));
  }

  if (m === "isodata") {
    let t = 128;
    for (let iter = 0; iter < 64; iter++) {
      let sLo = 0;
      let wLo = 0;
      for (let i = 0; i <= t; i++) {
        wLo += hist[i];
        sLo += i * hist[i];
      }
      const wHi = total - wLo;
      const sHi = sumAll - sLo;
      if (wLo <= 0 || wHi <= 0) break;
      const nt = Math.round(0.5 * (sLo / wLo + sHi / wHi));
      if (nt === t) break;
      t = nt;
    }
    return Math.min(254, Math.max(1, t));
  }

  if (m === "triangle") {
    let first = 0;
    let last = 255;
    while (first < 255 && hist[first] === 0) first++;
    while (last > first && hist[last] === 0) last--;
    let peak = first;
    for (let i = first; i <= last; i++) {
      if (hist[i] > hist[peak]) peak = i;
    }
    const flip = peak - first < last - peak;
    const start = flip ? peak : first;
    const end = flip ? last : peak;
    if (end <= start) return Math.min(254, Math.max(1, peak));
    const x1 = start;
    const y1 = hist[start];
    const x2 = end;
    const y2 = hist[end];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const denom = Math.hypot(dx, dy) || 1;
    let bestT = peak;
    let bestDist = -1;
    for (let b = start; b <= end; b++) {
      const dist = Math.abs(dy * b - dx * hist[b] + x2 * y1 - y2 * x1) / denom;
      if (dist > bestDist) {
        bestDist = dist;
        bestT = b;
      }
    }
    return Math.min(254, Math.max(1, bestT));
  }

  if (m === "li") {
    const meanAll = Math.max(sumAll / total, 1e-6);
    let bestT = 128;
    let minEnt = Infinity;
    let wB = 0;
    let sumB = 0;
    for (let t = 1; t < 254; t++) {
      wB += hist[t];
      sumB += t * hist[t];
      const wF = total - wB;
      if (wB <= 0 || wF <= 0) continue;
      const muB = Math.max(sumB / wB, 1e-6);
      const muF = Math.max((sumAll - sumB) / wF, 1e-6);
      const ent = -sumB * Math.log(muB / meanAll) - (sumAll - sumB) * Math.log(muF / meanAll);
      if (ent < minEnt) {
        minEnt = ent;
        bestT = t;
      }
    }
    return Math.min(254, Math.max(1, bestT));
  }

  if (m === "huang") {
    let first = 0;
    let last = 255;
    while (first < 255 && hist[first] === 0) first++;
    while (last > first && hist[last] === 0) last--;
    const cVal = Math.max(1, last - first);
    let bestT = 128;
    let minEnt = Infinity;
    let wB = 0;
    let sumB = 0;
    for (let t = first; t < last; t++) {
      wB += hist[t];
      sumB += t * hist[t];
      const wF = total - wB;
      if (wB <= 0 || wF <= 0) continue;
      const muB = sumB / wB;
      const muF = (sumAll - sumB) / wF;
      let ent = 0;
      for (let i = first; i <= last; i++) {
        if (hist[i] <= 0) continue;
        const mu = 1 / (1 + Math.abs(i - (i <= t ? muB : muF)) / cVal);
        if (mu > 1e-6 && mu < 1 - 1e-6) {
          ent += hist[i] * (-mu * Math.log(mu) - (1 - mu) * Math.log(1 - mu));
        }
      }
      if (ent < minEnt) {
        minEnt = ent;
        bestT = t;
      }
    }
    return Math.min(254, Math.max(1, bestT));
  }

  if (m === "moments") {
    let m1 = 0;
    let m2 = 0;
    let m3 = 0;
    for (let i = 0; i < 256; i++) {
      const p = hist[i] / total;
      m1 += p * i;
      m2 += p * i * i;
      m3 += p * i * i * i;
    }
    const cd = m2 - m1 * m1;
    if (Math.abs(cd) > 1e-6) {
      const c0 = (m1 * m3 - m2 * m2) / cd;
      const c1 = (m1 * m2 - m3) / cd;
      const disc = Math.max(0, c1 * c1 - 4 * c0);
      const z0 = 0.5 * (-c1 - Math.sqrt(disc));
      const z1 = 0.5 * (-c1 + Math.sqrt(disc));
      const pd = z1 - z0;
      if (Math.abs(pd) > 1e-6) {
        const target = Math.min(0.95, Math.max(0.05, (z1 - m1) / pd));
        let cum = 0;
        for (let i = 0; i < 256; i++) {
          cum += hist[i] / total;
          if (cum >= target) return Math.min(254, Math.max(1, i));
        }
      }
    }
  }

  // Default: Otsu
  let wB = 0;
  let sumB = 0;
  let bestVar = -1;
  let bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB <= 0) continue;
    const wF = total - wB;
    if (wF <= 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      bestT = t;
    }
  }
  return Math.min(254, Math.max(1, bestT));
}

/**
 * Fill interior holes in a binary mask (1 = foreground, 0 = background) by flood-filling exterior background.
 */
function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const extBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  const pushIfBg = (idx: number) => {
    if (mask[idx] === 0 && extBg[idx] === 0) {
      extBg[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    pushIfBg(x);
    pushIfBg((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    pushIfBg(y * width);
    pushIfBg(y * width + (width - 1));
  }

  while (head < tail) {
    const idx = queue[head++];
    const y = Math.floor(idx / width);
    const x = idx - y * width;
    if (y > 0) pushIfBg(idx - width);
    if (y + 1 < height) pushIfBg(idx + width);
    if (x > 0) pushIfBg(idx - 1);
    if (x + 1 < width) pushIfBg(idx + 1);
  }

  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    filled[i] = extBg[i] === 0 ? 1 : 0;
  }
  return filled;
}

/**
 * Monotone chain convex hull area (including lattice boundary thickness) for Solidity = Area / HullArea.
 */
function convexHullArea(points: [number, number][]): number {
  if (points.length < 3) return points.length;
  const sorted = [...points].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  let area2 = 0;
  let perim = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % hull.length];
    area2 += x0 * y1 - x1 * y0;
    perim += Math.hypot(x1 - x0, y1 - y0);
  }
  return Math.abs(area2) * 0.5 + perim * 0.5 + 1;
}

/**
 * Chamfer distance transform + peak watershed for splitting touching concave nuclei (Solidity < wsSolidity).
 */
function splitTouchingComponent(
  pixels: [number, number][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minRadiusPx: number,
): [number, number][][] {
  const sw = x1 - x0 + 3;
  const sh = y1 - y0 + 3;
  const sub = new Uint8Array(sw * sh);
  const dist = new Float32Array(sw * sh);
  for (const [px, py] of pixels) {
    const idx = (py - y0 + 1) * sw + (px - x0 + 1);
    sub[idx] = 1;
    dist[idx] = 1e6;
  }

  // Forward pass
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const idx = y * sw + x;
      if (!sub[idx]) continue;
      let d = dist[idx];
      d = Math.min(d, dist[(y - 1) * sw + x] + 1);
      d = Math.min(d, dist[y * sw + (x - 1)] + 1);
      d = Math.min(d, dist[(y - 1) * sw + (x - 1)] + 1.4142);
      d = Math.min(d, dist[(y - 1) * sw + (x + 1)] + 1.4142);
      dist[idx] = d;
    }
  }
  // Backward pass
  for (let y = sh - 2; y >= 1; y--) {
    for (let x = sw - 2; x >= 1; x--) {
      const idx = y * sw + x;
      if (!sub[idx]) continue;
      let d = dist[idx];
      d = Math.min(d, dist[(y + 1) * sw + x] + 1);
      d = Math.min(d, dist[y * sw + (x + 1)] + 1);
      d = Math.min(d, dist[(y + 1) * sw + (x + 1)] + 1.4142);
      d = Math.min(d, dist[(y + 1) * sw + (x - 1)] + 1.4142);
      dist[idx] = d;
    }
  }

  const smooth = gaussianBlur2D(dist, sw, sh, 1.2);
  const minSep = Math.max(5, minRadiusPx * 1.15);
  const candidates: { val: number; sx: number; sy: number }[] = [];

  for (let sy = 1; sy < sh - 1; sy++) {
    for (let sx = 1; sx < sw - 1; sx++) {
      const idx = sy * sw + sx;
      if (!sub[idx]) continue;
      const val = smooth[idx];
      if (val < Math.max(2.5, minRadiusPx * 0.45)) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++) {
        const ny = sy + dy;
        if (ny < 0 || ny >= sh) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = sx + dx;
          if (nx >= 0 && nx < sw && smooth[ny * sw + nx] > val + 1e-5) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) candidates.push({ val, sx, sy });
    }
  }

  candidates.sort((a, b) => b.val - a.val);
  const peaks: { sx: number; sy: number; val: number }[] = [];
  for (const c of candidates) {
    if (peaks.every((p) => Math.hypot(c.sx - p.sx, c.sy - p.sy) >= minSep)) {
      peaks.push(c);
      if (peaks.length >= 8) break;
    }
  }

  if (peaks.length < 2) return [pixels];

  const groups: [number, number][][] = peaks.map(() => []);
  for (const [px, py] of pixels) {
    const sx = px - x0 + 1;
    const sy = py - y0 + 1;
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < peaks.length; i++) {
      const pk = peaks[i];
      const d = Math.hypot(sx - pk.sx, sy - pk.sy) / Math.max(pk.val, 1);
      if (d < bestScore) {
        bestScore = d;
        bestIdx = i;
      }
    }
    groups[bestIdx].push([px, py]);
  }
  const valid = groups.filter((g) => g.length >= 8);
  return valid.length >= 2 ? valid : [pixels];
}

/**
 * Segment nuclei on a PackedPlane using the Foci_Counter.groovy algorithm.
 */
export function segmentNucleiFromPacked(
  packed: PackedPlane,
  channelsMeta: Pick<ChannelInfo, "name" | "color">[],
  umPerPx: number,
  partialParams?: Partial<NucleusParams>,
  fullDimensions?: { width: number; height: number },
): NucleusResult {
  const cfg: NucleusParams = { ...DEFAULT_NUCLEUS_PARAMS, ...partialParams };
  const fullW = fullDimensions?.width || packed.width;
  const fullH = fullDimensions?.height || packed.height;

  if (!packed.channels.length || packed.width < 4 || packed.height < 4) {
    return {
      channel_index: 0,
      threshold: 0,
      nuclei: [],
      recommended_center: { x: Math.round(fullW / 2), y: Math.round(fullH / 2) },
      width: fullW,
      height: fullH,
    };
  }

  const chIdx = identifyNucleusChannel(
    channelsMeta.length ? channelsMeta : packed.channels,
    cfg.channel_index,
  );
  const srcChannel = packed.channels[Math.min(Math.max(0, chIdx), packed.channels.length - 1)];

  // Downsample to <= 512px on the long edge for sub-15ms interactive response
  const maxEdge = 512;
  const ds = Math.max(1, Math.ceil(Math.max(packed.width, packed.height) / maxEdge));
  const ww = Math.max(2, Math.floor(packed.width / ds));
  const wh = Math.max(2, Math.floor(packed.height / ds));
  const work = new Float32Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    const sy = Math.min(packed.height - 1, y * ds);
    for (let x = 0; x < ww; x++) {
      const sx = Math.min(packed.width - 1, x * ds);
      work[y * ww + x] = srcChannel.data[sy * packed.width + sx];
    }
  }

  // Scale factor from work grid to full image coordinates
  const scaleX = fullW / ww;
  const scaleY = fullH / wh;
  const scaleAvg = 0.5 * (scaleX + scaleY);
  const psRaw = umPerPx > 0 ? umPerPx : 0.25;
  const ps = psRaw * scaleAvg;

  const sigma = cfg.smooth_um / Math.max(ps, 1e-4);
  const blurred = sigma > 0.3 ? gaussianBlur2D(work, ww, wh, sigma) : work;

  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < blurred.length; i++) {
    const v = blurred[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!(mx > mn)) {
    return {
      channel_index: chIdx,
      threshold: mn,
      nuclei: [],
      recommended_center: { x: Math.round(fullW / 2), y: Math.round(fullH / 2) },
      width: fullW,
      height: fullH,
    };
  }

  const hist = new Int32Array(256);
  const scale = 255 / (mx - mn);
  for (let i = 0; i < blurred.length; i++) {
    const b = Math.min(255, Math.max(0, Math.floor((blurred[i] - mn) * scale)));
    hist[b]++;
  }
  const tBin = autoThreshold256(hist, cfg.threshold_method);
  const thr = mn + (tBin + 0.5) / scale;

  const rawMask = new Uint8Array(ww * wh);
  for (let i = 0; i < blurred.length; i++) {
    rawMask[i] = blurred[i] > thr ? 1 : 0;
  }
  const mask = fillHoles(rawMask, ww, wh);

  // Connected components (8-connectivity)
  const visited = new Uint8Array(ww * wh);
  const queue = new Int32Array(ww * wh);
  const rawComponents: [number, number][][] = [];

  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const startIdx = y * ww + x;
      if (!mask[startIdx] || visited[startIdx]) continue;
      visited[startIdx] = 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = startIdx;
      const comp: [number, number][] = [];
      while (head < tail) {
        const curr = queue[head++];
        const cy = Math.floor(curr / ww);
        const cx = curr - cy * ww;
        comp.push([cx, cy]);
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= wh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= ww) continue;
            const nIdx = ny * ww + nx;
            if (!visited[nIdx] && mask[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }
      if (comp.length >= 6) rawComponents.push(comp);
    }
  }

  const imgArea = ww * wh;
  const minAreaPx =
    umPerPx > 0 ? Math.max(6, cfg.min_area_um2 / (ps * ps)) : Math.max(12, imgArea * 0.0004);
  const maxAreaPx =
    umPerPx > 0
      ? Math.max(minAreaPx * 2, cfg.max_area_um2 / (ps * ps))
      : Math.max(minAreaPx * 4, imgArea * 0.55);
  const minRadiusPx = Math.sqrt(Math.max(minAreaPx, 9) / Math.PI);

  // Solidity-guarded watershed
  const finalComponents: [number, number][][] = [];
  for (const comp of rawComponents) {
    if (comp.length < minAreaPx * 0.4) continue;
    let x0 = ww;
    let y0 = wh;
    let x1 = 0;
    let y1 = 0;
    const keySet = new Set<number>();
    for (const [px, py] of comp) {
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      keySet.add(py * ww + px);
    }
    const boundary: [number, number][] = [];
    for (const [px, py] of comp) {
      if (
        px === 0 ||
        py === 0 ||
        px === ww - 1 ||
        py === wh - 1 ||
        !keySet.has((py - 1) * ww + px) ||
        !keySet.has((py + 1) * ww + px) ||
        !keySet.has(py * ww + (px - 1)) ||
        !keySet.has(py * ww + (px + 1))
      ) {
        boundary.push([px, py]);
      }
    }
    const hullA = convexHullArea(boundary.length ? boundary : comp);
    const solidity = Math.min(1, comp.length / Math.max(hullA, 1));
    if (cfg.watershed && solidity < cfg.ws_solidity && comp.length >= minAreaPx * 1.3) {
      finalComponents.push(...splitTouchingComponent(comp, x0, y0, x1, y1, minRadiusPx));
    } else {
      finalComponents.push(comp);
    }
  }

  const imgCx = fullW * 0.5;
  const imgCy = fullH * 0.5;
  const maxDist = Math.hypot(imgCx, imgCy) || 1;
  const candidates: (Omit<NucleusRoi, "id"> & { _score: number })[] = [];

  for (const comp of finalComponents) {
    const areaPxWork = comp.length;
    if (areaPxWork < minAreaPx || areaPxWork > maxAreaPx) continue;
    let x0 = ww;
    let y0 = wh;
    let x1 = 0;
    let y1 = 0;
    let sumX = 0;
    let sumY = 0;
    let sumInt = 0;
    const keySet = new Set<number>();
    for (const [px, py] of comp) {
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      sumX += px;
      sumY += py;
      sumInt += work[py * ww + px];
      keySet.add(py * ww + px);
    }
    const touchesEdge = x0 <= 0 || y0 <= 0 || x1 >= ww - 1 || y1 >= wh - 1;
    const boundary: [number, number][] = [];
    let exposedEdges = 0;
    for (const [px, py] of comp) {
      let out = 0;
      if (py === 0 || !keySet.has((py - 1) * ww + px)) out++;
      if (py === wh - 1 || !keySet.has((py + 1) * ww + px)) out++;
      if (px === 0 || !keySet.has(py * ww + (px - 1))) out++;
      if (px === ww - 1 || !keySet.has(py * ww + (px + 1))) out++;
      if (out > 0) {
        boundary.push([px, py]);
        exposedEdges += out;
      }
    }

    const perim = Math.max(exposedEdges * 0.785, 1);
    const circularity = Math.min(1, (4 * Math.PI * areaPxWork) / (perim * perim));
    if (circularity < cfg.min_circularity) continue;

    const hullA = convexHullArea(boundary);
    const solidity = Math.min(1, areaPxWork / Math.max(hullA, 1));

    const cxWork = sumX / areaPxWork;
    const cyWork = sumY / areaPxWork;
    const cxFull = (cxWork + 0.5) * scaleX;
    const cyFull = (cyWork + 0.5) * scaleY;
    const meanInt = sumInt / areaPxWork;

    // Order contour points by angle around centroid
    boundary.sort(
      (a, b) => Math.atan2(a[1] - cyWork, a[0] - cxWork) - Math.atan2(b[1] - cyWork, b[0] - cxWork),
    );
    const step = Math.max(1, Math.floor(boundary.length / 36));
    const contour: [number, number][] = [];
    for (let i = 0; i < boundary.length; i += step) {
      const [bx, by] = boundary[i];
      contour.push([Number(((bx + 0.5) * scaleX).toFixed(1)), Number(((by + 0.5) * scaleY).toFixed(1))]);
    }

    const distCenter = Math.hypot(cxFull - imgCx, cyFull - imgCy) / maxDist;
    const score = (1 - 0.45 * distCenter) * (0.5 + 0.5 * circularity) * Math.sqrt(Math.max(meanInt - mn, 1));

    candidates.push({
      cx: Number(cxFull.toFixed(1)),
      cy: Number(cyFull.toFixed(1)),
      area_px: Math.round(areaPxWork * scaleX * scaleY),
      area_um2: Number((areaPxWork * ps * ps).toFixed(2)),
      circularity: Number(circularity.toFixed(3)),
      solidity: Number(solidity.toFixed(3)),
      mean_intensity: Number(meanInt.toFixed(2)),
      sum_intensity: Number((sumInt * scaleX * scaleY).toFixed(1)),
      touches_edge: touchesEdge,
      bounds: {
        x: Math.round(x0 * scaleX),
        y: Math.round(y0 * scaleY),
        w: Math.max(2, Math.round((x1 - x0 + 1) * scaleX)),
        h: Math.max(2, Math.round((y1 - y0 + 1) * scaleY)),
      },
      contour,
      _score: score,
    });
  }

  let filtered = candidates;
  if (cfg.exclude_edges) {
    const interior = candidates.filter((c) => !c.touches_edge);
    if (interior.length > 0) filtered = interior;
  }

  filtered.sort((a, b) => b._score - a._score);
  const nuclei: NucleusRoi[] = filtered.map(({ _score: _, ...rest }, index) => ({
    ...rest,
    id: index + 1,
  }));

  const best = nuclei[0];
  return {
    channel_index: chIdx,
    threshold: Number(thr.toFixed(2)),
    nuclei,
    recommended_center: best
      ? { x: Math.round(best.cx), y: Math.round(best.cy) }
      : { x: Math.round(fullW / 2), y: Math.round(fullH / 2) },
    width: fullW,
    height: fullH,
  };
}
