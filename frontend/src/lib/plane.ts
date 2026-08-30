import type { PackedPlane } from "./types";

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

export function renderComposite(
  packed: PackedPlane,
  luts: { min: number; max: number; gamma: number; visible: boolean; color: number[] }[],
  target: ImageData,
): void {
  const { channels } = packed;
  const out = target.data;
  out.fill(0);
  for (let c = 0; c < channels.length; c++) {
    const lut = luts[c];
    if (!lut?.visible) continue;
    const plane = channels[c].data;
    const [cr, cg, cb] = lut.color;
    const min = lut.min;
    const max = lut.max;
    const gamma = lut.gamma || 1;
    for (let i = 0; i < plane.length; i++) {
      const y = mapLut(plane[i], min, max, gamma);
      const o = i * 4;
      out[o] = Math.min(255, out[o] + y * cr);
      out[o + 1] = Math.min(255, out[o + 1] + y * cg);
      out[o + 2] = Math.min(255, out[o + 2] + y * cb);
      out[o + 3] = 255;
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
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
