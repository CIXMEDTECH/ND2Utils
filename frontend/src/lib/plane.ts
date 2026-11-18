import type { LutSetting, PackedPlane } from "./types";

export interface PreviewLayer {
  canvas: HTMLCanvasElement;
  name: string;
}

const MAX_PREVIEW_EDGE = 2048;

export function unpackPlane(buf: ArrayBuffer): PackedPlane {
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "ND2P") throw new Error("bad plane magic");
  const nchan = view.getUint16(6, true);
  const height = view.getUint32(8, true);
  const width = view.getUint32(12, true);
  const dtypeCode = view.getUint8(16);
  const dtype = dtypeCode === 0 ? "u8" : dtypeCode === 2 ? "f32" : "u16";
  const item = dtype === "u8" ? 1 : dtype === "f32" ? 4 : 2;
  let offset = 20;
  const channels: PackedPlane["channels"] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < nchan; i++) {
    const nameBytes = new Uint8Array(buf, offset, 32);
    const z = nameBytes.indexOf(0);
    const name = decoder.decode(nameBytes.subarray(0, z < 0 ? 32 : z));
    offset += 32;
    const r = view.getUint8(offset);
    const g = view.getUint8(offset + 1);
    const b = view.getUint8(offset + 2);
    offset += 4;
    const suggestedMin = view.getFloat32(offset, true);
    const suggestedMax = view.getFloat32(offset + 4, true);
    offset += 8;
    const count = width * height;
    const data = new Float32Array(count);
    if (dtype === "u8") {
      const src = new Uint8Array(buf, offset, count);
      for (let p = 0; p < count; p++) data[p] = src[p];
    } else if (dtype === "f32") {
      data.set(new Float32Array(buf, offset, count));
    } else {
      const src = new Uint16Array(buf, offset, count);
      for (let p = 0; p < count; p++) data[p] = src[p];
    }
    offset += count * item;
    channels.push({
      name,
      color: [r, g, b],
      suggestedMin,
      suggestedMax,
      data,
    });
  }
  return { width, height, dtype, channels };
}

export function mapLut(v: number, min: number, max: number, gamma: number): number {
  const y = Math.min(1, Math.max(0, (v - min) / (max - min || 1)));
  return Math.abs(gamma - 1) < 1e-6 ? y : Math.pow(y, 1 / (gamma || 1));
}

const lutCache = new Map<string, Float32Array>();

/** mapLut for every integer value 0..size-1 (u8/u16 planes hold integers), cached by parameters. */
function lutTable(size: number, min: number, max: number, gamma: number): Float32Array {
  const key = `${size}:${min}:${max}:${gamma}`;
  const hit = lutCache.get(key);
  if (hit) return hit;
  if (lutCache.size > 24) {
    const oldest = lutCache.keys().next().value;
    if (oldest !== undefined) lutCache.delete(oldest);
  }
  const table = new Float32Array(size);
  for (let v = 0; v < size; v++) table[v] = mapLut(v, min, max, gamma);
  lutCache.set(key, table);
  return table;
}

export function renderComposite(
  packed: PackedPlane,
  luts: { min: number; max: number; gamma: number; brightness?: number; visible: boolean; color: number[] }[],
  target: ImageData,
): void {
  const { channels } = packed;
  const out = target.data;
  out.fill(0);
  // Integer planes: one table lookup per pixel instead of a division and a pow.
  const tableSize = packed.dtype === "u8" ? 256 : packed.dtype === "u16" ? 65536 : 0;
  for (let c = 0; c < channels.length; c++) {
    const lut = luts[c];
    if (!lut?.visible) continue;
    const plane = channels[c].data;
    const [cr, cg, cb] = lut.color;
    const gamma = lut.gamma || 1;
    const brightness = lut.brightness !== undefined ? Math.max(0, lut.brightness) : 1;
    const table = tableSize ? lutTable(tableSize, lut.min, lut.max, gamma) : null;
    for (let i = 0; i < plane.length; i++) {
      let y = table ? table[plane[i]] : mapLut(plane[i], lut.min, lut.max, gamma);
      if (y === 0) continue;
      if (brightness !== 1) y = Math.min(1, y * brightness);
      const o = i * 4;
      out[o] = Math.min(255, out[o] + y * cr);
      out[o + 1] = Math.min(255, out[o + 1] + y * cg);
      out[o + 2] = Math.min(255, out[o + 2] + y * cb);
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
}

/** Per-value RGB for one channel (integer planes): one lookup per pixel instead of a pow. */
function colorTables(size: number, min: number, max: number, gamma: number, brightness: number, color: number[]) {
  const [red, green, blue] = color;
  const span = Math.max(max - min, 1e-6);
  const linear = Math.abs(gamma - 1) < 1e-6;
  const inverseGamma = 1 / gamma;
  const r = new Uint8ClampedArray(size);
  const g = new Uint8ClampedArray(size);
  const b = new Uint8ClampedArray(size);
  for (let v = 0; v < size; v++) {
    let level = (v - min) / span;
    if (level <= 0) level = 0;
    else if (level >= 1) level = 1;
    else if (!linear) level = Math.pow(level, inverseGamma);
    if (brightness !== 1 && level > 0) level = Math.min(1, level * brightness);
    r[v] = level * red;
    g[v] = level * green;
    b[v] = level * blue;
  }
  return { r, g, b };
}

export function createPreviewLayers(packed: PackedPlane, luts: LutSetting[]): PreviewLayer[] {
  const previewScale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(packed.width, packed.height));
  const previewWidth = Math.max(1, Math.round(packed.width * previewScale));
  const previewHeight = Math.max(1, Math.round(packed.height * previewScale));
  const tableSize = packed.dtype === "u8" ? 256 : packed.dtype === "u16" ? 65536 : 0;
  // Source column/row for every preview column/row (nearest neighbour), computed once.
  const sourceX = new Uint32Array(previewWidth);
  for (let x = 0; x < previewWidth; x++) sourceX[x] = Math.min(packed.width - 1, Math.floor(x / previewScale));
  return packed.channels.map((channel, index) => {
    const canvas = document.createElement("canvas");
    canvas.width = previewWidth;
    canvas.height = previewHeight;
    const context = canvas.getContext("2d");
    if (!context) return { canvas, name: channel.name };
    const image = context.createImageData(previewWidth, previewHeight);
    const output = image.data;
    const lut = luts[index];
    const min = lut?.min ?? channel.suggestedMin;
    const max = lut?.max ?? channel.suggestedMax;
    const gamma = lut?.gamma && lut.gamma > 0 ? lut.gamma : 1;
    const brightness = lut?.brightness !== undefined ? Math.max(0, lut.brightness) : 1;
    const color = lut?.color ?? channel.color;
    const data = channel.data;
    if (tableSize) {
      const { r, g, b } = colorTables(tableSize, min, max, gamma, brightness, color);
      const same = previewWidth === packed.width && previewHeight === packed.height;
      for (let y = 0; y < previewHeight; y++) {
        const rowStart = (same ? y : Math.min(packed.height - 1, Math.floor(y / previewScale))) * packed.width;
        let offset = y * previewWidth * 4;
        for (let x = 0; x < previewWidth; x++) {
          const v = data[rowStart + (same ? x : sourceX[x])];
          output[offset] = r[v];
          output[offset + 1] = g[v];
          output[offset + 2] = b[v];
          output[offset + 3] = 255;
          offset += 4;
        }
      }
      context.putImageData(image, 0, 0);
      return { canvas, name: channel.name };
    }
    const linear = Math.abs(gamma - 1) < 1e-6;
    const unitBrightness = Math.abs(brightness - 1) < 1e-6;
    const inverseGamma = 1 / gamma;
    const span = Math.max(max - min, 1e-6);
    const [red, green, blue] = color;
    for (let y = 0; y < previewHeight; y++) {
      const sourceY = Math.min(packed.height - 1, Math.floor(y / previewScale));
      for (let x = 0; x < previewWidth; x++) {
        const pixel = y * previewWidth + x;
        let level = (data[sourceY * packed.width + sourceX[x]] - min) / span;
        if (level <= 0) level = 0;
        else if (level >= 1) level = 1;
        else if (!linear) level = Math.pow(level, inverseGamma);
        if (!unitBrightness && level > 0) level = Math.min(1, level * brightness);
        const offset = pixel * 4;
        output[offset] = level * red;
        output[offset + 1] = level * green;
        output[offset + 2] = level * blue;
        output[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return { canvas, name: channel.name };
  });
}

function drawLabel(context: CanvasRenderingContext2D, name: string, x: number, y: number): void {
  context.save();
  context.font = '13px "Geist Mono Variable", ui-monospace, monospace';
  context.textBaseline = "top";
  const width = context.measureText(name).width;
  context.fillStyle = "rgb(8 8 10 / 0.92)";
  context.fillRect(x + 3, y + 3, width + 10, 21);
  context.fillStyle = "rgb(240 244 248)";
  context.fillText(name, x + 8, y + 6);
  context.restore();
}

export function niceScaleUm(umPerPixel: number, width: number): [number, number] {
  const targetPixels = Math.min(Math.max(width / 6, 24), Math.max(width * 0.4, 8));
  const targetUm = targetPixels * umPerPixel;
  if (targetUm <= 0) return [10, umPerPixel ? Math.round(10 / umPerPixel) : 50];
  const exponent = Math.floor(Math.log10(targetUm));
  const fraction = targetUm / 10 ** exponent;
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  const um = nice * 10 ** exponent;
  const px = Math.max(Math.round(um / umPerPixel), 8);
  return [um, width > 24 ? Math.min(px, Math.max(8, width - 24)) : px];
}

function drawScaleBar(context: CanvasRenderingContext2D, width: number, height: number, umPerPixel: number): void {
  if (!(umPerPixel > 0)) return;
  const [um, pixels] = niceScaleUm(umPerPixel, width);
  const padding = Math.max(8, Math.min(16, Math.round(Math.min(width, height) * 0.04)));
  const x1 = width - padding;
  const x0 = x1 - pixels;
  const y = height - padding;
  const barY = y - 4;
  context.save();
  context.fillStyle = "rgb(8 10 14 / 0.88)";
  context.fillRect(x0 - 6, barY - 18, pixels + 12, 25);
  context.fillStyle = "rgb(240 244 248)";
  context.fillRect(x0, barY, pixels, 3);
  context.font = '12px "Geist Mono Variable", ui-monospace, monospace';
  context.textBaseline = "top";
  context.fillText(`${Number(um.toPrecision(6))} µm`, x0, barY - 16);
  context.restore();
}

export function drawPreview(
  target: HTMLCanvasElement,
  source: Pick<PackedPlane, "width" | "height">,
  layers: PreviewLayer[],
  options: {
    composite: boolean;
    scaleBar: boolean;
    visible: boolean[];
    umPerPixel: number;
  },
): void {
  const active = layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ index }) => options.visible[index] ?? true);
  const previewWidth = layers[0]?.canvas.width ?? source.width;
  const previewHeight = layers[0]?.canvas.height ?? source.height;
  const gap = active.length > 1 ? 2 : 0;
  const columns = options.composite || active.length === 0 ? 1 : Math.ceil(Math.sqrt(active.length));
  const rows = options.composite || active.length === 0 ? 1 : Math.ceil(active.length / columns);
  const width = columns * previewWidth + (columns - 1) * gap;
  const height = rows * previewHeight + (rows - 1) * gap;
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
  const context = target.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "black";
  context.fillRect(0, 0, width, height);

  if (options.composite) {
    context.globalCompositeOperation = "lighter";
    for (const { layer } of active) context.drawImage(layer.canvas, 0, 0);
    context.globalCompositeOperation = "source-over";
  } else {
    active.forEach(({ layer }, tile) => {
      const row = Math.floor(tile / columns);
      const column = tile % columns;
      const x = column * (previewWidth + gap);
      const y = row * (previewHeight + gap);
      context.drawImage(layer.canvas, x, y);
      drawLabel(context, layer.name, x, y);
    });
  }
  if (options.scaleBar) {
    const scaledUmPerPixel = options.umPerPixel * (source.width / previewWidth);
    drawScaleBar(context, width, height, scaledUmPerPixel);
  }
}

export function drawCroppedPreview(
  target: HTMLCanvasElement,
  source: Pick<PackedPlane, "width" | "height">,
  layers: PreviewLayer[],
  crop: { x: number; y: number; w: number; h: number },
  options: {
    scaleBar: boolean;
    visible: boolean[];
    umPerPixel: number;
  },
): void {
  const active = layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ index }) => options.visible[index] ?? true);
  const layerW = layers[0]?.canvas.width ?? source.width;
  const layerH = layers[0]?.canvas.height ?? source.height;
  const scaleX = layerW / Math.max(1, source.width);
  const scaleY = layerH / Math.max(1, source.height);

  const sx = Math.max(0, Math.min(layerW - 1, Math.round(crop.x * scaleX)));
  const sy = Math.max(0, Math.min(layerH - 1, Math.round(crop.y * scaleY)));
  const sw = Math.max(2, Math.min(layerW - sx, Math.round(crop.w * scaleX)));
  const sh = Math.max(2, Math.min(layerH - sy, Math.round(crop.h * scaleY)));

  if (target.width !== sw) target.width = sw;
  if (target.height !== sh) target.height = sh;
  const context = target.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "black";
  context.fillRect(0, 0, sw, sh);

  context.globalCompositeOperation = "lighter";
  for (const { layer } of active) {
    context.drawImage(layer.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  }
  context.globalCompositeOperation = "source-over";

  if (options.scaleBar && options.umPerPixel > 0) {
    const croppedUmPerPx = options.umPerPixel * (crop.w / sw);
    drawScaleBar(context, sw, sh, croppedUmPerPx);
  }
}

export function histogram(data: Float32Array, bins = 128, hi?: number): number[] {
  const max = hi ?? Math.max(1, data.reduce((a, b) => (b > a ? b : a), 0));
  const counts = new Array(bins).fill(0);
  const scale = (bins - 1) / max;
  for (let i = 0; i < data.length; i++) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(data[i] * scale)));
    counts[idx] += 1;
  }
  return counts;
}

/** Histogram counts as a filled SVG step path in a `counts.length` x `height` box. */
export function histogramPath(counts: number[], height: number, log = false): string {
  let peak = 1;
  for (const c of counts) if (c > peak) peak = c;
  const scale = (c: number) => (log ? Math.log10(c + 1) / Math.log10(peak + 1) : c / peak);
  let d = `M0 ${height}`;
  counts.forEach((c, x) => {
    const y = (height - scale(c) * height).toFixed(2);
    d += `V${y}H${x + 1}`;
  });
  return `${d}V${height}Z`;
}
