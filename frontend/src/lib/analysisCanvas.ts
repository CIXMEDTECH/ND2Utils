import { useEffect, useState } from "react";

/** An 8-bit analysis channel decoded in the browser, with its auto-contrast range. */
export interface GrayImage {
  data: Uint8Array;
  w: number;
  h: number;
  hist: Uint32Array;
  auto: [number, number];
}

export interface Levels {
  mode: "auto" | "manual";
  black: number;
  white: number;
  gamma: number;
}

export const DEFAULT_LEVELS: Levels = { mode: "auto", black: 0, white: 255, gamma: 1 };

/** Black/white points from the histogram (0.1 % / 99.9 %), like an auto-contrast. */
export function autoRange(hist: Uint32Array, total: number): [number, number] {
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > total * 0.001) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc > total * 0.001) {
      hi = v;
      break;
    }
  }
  return hi > lo ? [lo, hi] : [lo, Math.min(255, lo + 1)];
}

/** Decode a grey PNG (the analysed channel) into bytes. */
export function useGrayImage(url: string | null): GrayImage | null {
  const [image, setImage] = useState<{ url: string; gray: GrayImage } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scratch = document.createElement("canvas");
      scratch.width = w;
      scratch.height = h;
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const data = new Uint8Array(w * h);
      const hist = new Uint32Array(256);
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        data[i] = rgba[j];
        hist[rgba[j]] += 1;
      }
      setImage({ url, gray: { data, w, h, hist, auto: autoRange(hist, data.length) } });
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return image && image.url === url ? image.gray : null;
}

export function levelRange(gray: GrayImage, levels: Levels): [number, number] {
  return levels.mode === "auto" ? gray.auto : [levels.black, Math.max(levels.white, levels.black + 1)];
}

export interface Layer {
  gray: GrayImage;
  color: number[];
  levels: Levels;
  visible: boolean;
}

/** Draw channels additively (each through black / white / gamma, tinted by its colour). */
export function drawLayers(canvas: HTMLCanvasElement, layers: Layer[]): void {
  const shown = layers.filter((l) => l.visible);
  const base = layers[0]?.gray;
  if (!base) return;
  const { w, h } = base;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const out = ctx.createImageData(w, h);
  const px = out.data;
  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (const layer of shown) {
    if (layer.gray.w !== w || layer.gray.h !== h) continue;
    const [lo, hi] = levelRange(layer.gray, layer.levels);
    const inv = 1 / (layer.levels.gamma || 1);
    const lut = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      const level = (v - lo) / (hi - lo);
      lut[v] = level <= 0 ? 0 : level >= 1 ? 1 : Math.pow(level, inv);
    }
    const [cr, cg, cb] = layer.color;
    const data = layer.gray.data;
    for (let i = 0; i < data.length; i++) {
      const level = lut[data[i]];
      if (level === 0) continue;
      r[i] += level * cr;
      g[i] += level * cg;
      b[i] += level * cb;
    }
  }
  for (let i = 0, j = 0; i < r.length; i++, j += 4) {
    px[j] = r[i];
    px[j + 1] = g[i];
    px[j + 2] = b[i];
    px[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}
