/**
 * Scale bar length from the optics — the same table as backend/nd2utils/scalebar.py, so the
 * preview, the crop box, Studio and the exported files all show the same bar.
 *
 *   ≤5x 500 µm · ≤12x 200 · ≤25x 100 · ≤45x 50 · ≤70x 20 · ≤150x 10 · ≤350x 5 · above 2 µm
 *
 * (effective magnification = objective × confocal zoom), moved along the 1-2-5 ladder only when
 * the bar would cover more than 40 % of the width or less than 8 % of it (at least 24 px).
 */
const PRESETS: [number, number][] = [
  [5, 500],
  [12, 200],
  [25, 100],
  [45, 50],
  [70, 20],
  [150, 10],
  [350, 5],
];
const FALLBACK_UM = 2;
const MIN_PX = 24;
const MIN_FRACTION = 0.08;
const MAX_FRACTION = 0.4;
const LADDER: number[] = [];
for (let e = -1; e <= 3; e++) for (const m of [1, 2, 5]) LADDER.push(m * 10 ** e);

export interface Optics {
  magnification?: number | null;
  zoom?: number | null;
}

export function effectiveMagnification(optics: Optics | undefined): number | null {
  const mag = Number(optics?.magnification || 0);
  if (!(mag > 0)) return null;
  const zoom = Number(optics?.zoom || 0);
  return mag * (zoom > 0 ? zoom : 1);
}

export function presetUm(optics: Optics | undefined): number | null {
  const eff = effectiveMagnification(optics);
  if (eff === null) return null;
  for (const [limit, um] of PRESETS) if (eff <= limit) return um;
  return FALLBACK_UM;
}

function widthRule(umPerPx: number, width: number): number {
  const targetPx = Math.min(Math.max(width / 6, MIN_PX), Math.max(width * MAX_FRACTION, 8));
  const targetUm = targetPx * umPerPx;
  const exp = Math.floor(Math.log10(targetUm));
  const frac = targetUm / 10 ** exp;
  const nice = frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10;
  return nice * 10 ** exp;
}

function fit(um: number, umPerPx: number, width: number): number {
  let idx = 0;
  let best = Infinity;
  LADDER.forEach((v, i) => {
    const d = Math.abs(Math.log(v / um));
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  while (idx > 0 && LADDER[idx] / umPerPx > width * MAX_FRACTION) idx -= 1;
  const floor = Math.max(MIN_PX, width * MIN_FRACTION);
  while (idx < LADDER.length - 1 && LADDER[idx] / umPerPx < floor && LADDER[idx + 1] / umPerPx <= width * MAX_FRACTION) idx += 1;
  return LADDER[idx];
}

/** [µm, px] of the bar for an image `width` px wide, or null when not calibrated. */
export function autoScaleUm(umPerPx: number, width: number, optics?: Optics, lengthUm?: number | null): [number, number] | null {
  if (!(umPerPx > 0) || !(width > 0)) return null;
  let um: number;
  if (lengthUm && lengthUm > 0) um = lengthUm;
  else {
    const preset = presetUm(optics);
    um = preset ? fit(preset, umPerPx, width) : widthRule(umPerPx, width);
  }
  let px = Math.max(Math.round(um / umPerPx), 1);
  if (width > 24 && px > width - 24) px = Math.max(8, width - 24);
  return [um, px];
}

/** One length for a set of images (a Studio project): only when they share a magnification. */
export function unifiedScaleUm(items: { umPerPx: number; width: number; optics: Optics }[]): number | null {
  const usable = items.filter((it) => it.umPerPx > 0 && it.width > 0);
  if (usable.length < 2) return null;
  const presets = new Set(usable.map((it) => presetUm(it.optics)));
  if (presets.size !== 1 || presets.has(null)) return null;
  const lengths = usable.map((it) => autoScaleUm(it.umPerPx, it.width, it.optics)?.[0] ?? Infinity);
  const min = Math.min(...lengths);
  return Number.isFinite(min) ? min : null;
}
