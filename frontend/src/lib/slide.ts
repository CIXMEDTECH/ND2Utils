/**
 * Tiled, multi-resolution, multi-channel slide viewer engine (no React).
 *
 * The server sends native-value channel tiles (u8/u16/f32) for one resolution level; the browser
 * maps every channel through its own LUT (color, range, gamma) and adds them up. Changing a
 * channel's color or range therefore never re-downloads anything, and switching a channel on only
 * fetches that channel.
 *
 * Coordinates: "image" = full-resolution (level 0) pixels; the view is a center in image pixels
 * plus a scale in CSS pixels per image pixel.
 */
import type { SlideInfo } from "./types";

export interface ChannelDisplay {
  visible: boolean;
  color: number[];
  min: number;
  max: number;
  gamma: number;
}

export interface ViewState {
  cx: number;
  cy: number;
  scale: number;
  /** Resolution level the view is drawn from. */
  level: number;
  /** Visible part of the image in image pixels. */
  rect: Rect;
  width: number;
  height: number;
  loading: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Plane = Uint8Array | Uint16Array | Float32Array;

interface RawTile {
  w: number;
  h: number;
  data: Plane;
}

interface Composite {
  canvas: HTMLCanvasElement;
  version: number;
}

interface TileRef {
  level: number;
  x: number;
  y: number;
}

const RAW_LIMIT_BYTES = 384 * 1024 * 1024;
const COMPOSITE_LIMIT = 220;
const MAX_INFLIGHT = 6;
const COMPOSE_BUDGET_MS = 12;
export const MAX_SCALE = 20;
const MAX_CANVAS_PIXELS = 16_000_000;

/** Decode the server's packed planes ("ND2P"), keeping native typed arrays. */
export function unpackTile(buf: ArrayBuffer): { w: number; h: number; planes: Plane[] } {
  const view = new DataView(buf);
  const n = view.getUint16(6, true);
  const h = view.getUint32(8, true);
  const w = view.getUint32(12, true);
  const code = view.getUint8(16);
  const item = code === 0 ? 1 : code === 2 ? 4 : 2;
  const planes: Plane[] = [];
  let offset = 20;
  for (let i = 0; i < n; i++) {
    offset += 44; // name (32) + color (4) + suggested min/max (8)
    const bytes = buf.slice(offset, offset + w * h * item);
    planes.push(code === 0 ? new Uint8Array(bytes) : code === 2 ? new Float32Array(bytes) : new Uint16Array(bytes));
    offset += w * h * item;
  }
  return { w, h, planes };
}

/** Per-channel lookup tables value -> 0..255 per color component (u8 / u16 data). */
interface ChannelLut {
  index: number;
  r: Uint8Array | null;
  g: Uint8Array | null;
  b: Uint8Array | null;
  display: ChannelDisplay;
}

function mapValue(v: number, d: ChannelDisplay): number {
  const span = d.max - d.min || 1;
  let y = (v - d.min) / span;
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  if (Math.abs(d.gamma - 1) > 1e-6) y = Math.pow(y, 1 / (d.gamma || 1));
  return y;
}

function buildLut(index: number, display: ChannelDisplay, dtype: string): ChannelLut {
  const size = dtype === "uint8" ? 256 : dtype === "uint16" ? 65536 : 0;
  if (!size) return { index, r: null, g: null, b: null, display };
  const r = new Uint8Array(size);
  const g = new Uint8Array(size);
  const b = new Uint8Array(size);
  const [cr, cg, cb] = display.color;
  for (let v = 0; v < size; v++) {
    const y = mapValue(v, display);
    r[v] = y * cr + 0.5;
    g[v] = y * cg + 0.5;
    b[v] = y * cb + 0.5;
  }
  return { index, r, g, b, display };
}

/** Additive composite of channels into RGBA (Uint8ClampedArray saturates the sums at 255). */
export function composeInto(out: Uint8ClampedArray, planes: Plane[], luts: ChannelLut[]): void {
  out.fill(0);
  const count = out.length >> 2;
  for (let k = 0; k < luts.length; k++) {
    const lut = luts[k];
    const data = planes[k];
    if (lut.r && lut.g && lut.b) {
      const { r, g, b } = lut;
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        const v = data[i];
        if (v === 0 && r[0] === 0 && g[0] === 0 && b[0] === 0) continue;
        out[o] += r[v];
        out[o + 1] += g[v];
        out[o + 2] += b[v];
      }
    } else {
      const [cr, cg, cb] = lut.display.color;
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        const y = mapValue(data[i], lut.display);
        out[o] += y * cr;
        out[o + 1] += y * cg;
        out[o + 2] += y * cb;
      }
    }
  }
  for (let o = 3; o < out.length; o += 4) out[o] = 255;
}

export function niceScaleBar(umPerPx: number, targetPx: number): { um: number; px: number } {
  const targetUm = targetPx * umPerPx;
  const exponent = Math.floor(Math.log10(targetUm));
  const fraction = targetUm / 10 ** exponent;
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  const um = nice * 10 ** exponent;
  return { um, px: um / umPerPx };
}

export function formatLength(um: number): string {
  if (um >= 1000) return `${Number((um / 1000).toPrecision(4))} mm`;
  return `${Number(um.toPrecision(4))} µm`;
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, width: number, height: number, umPerScreenPx: number, k = 1): void {
  if (!(umPerScreenPx > 0)) return;
  const { um, px } = niceScaleBar(umPerScreenPx, Math.min(180 * k, width / 4));
  const pad = 16 * k;
  const x1 = width - pad;
  const x0 = x1 - px;
  const y = height - pad;
  ctx.save();
  ctx.font = `${12 * k}px "Geist Mono Variable", ui-monospace, monospace`;
  ctx.textBaseline = "bottom";
  const label = formatLength(um);
  const textW = ctx.measureText(label).width;
  ctx.fillStyle = "rgb(8 8 10 / 0.78)";
  ctx.fillRect(Math.min(x0, x1 - textW) - 8 * k, y - 26 * k, Math.max(px, textW) + 16 * k, 32 * k);
  ctx.fillStyle = "rgb(240 244 248)";
  ctx.fillRect(x0, y - 4 * k, px, 3 * k);
  ctx.textAlign = "right";
  ctx.fillText(label, x1, y - 8 * k);
  ctx.restore();
}

function tileKey(t: number, z: number, ref: TileRef): string {
  return `${t}/${z}/${ref.level}/${ref.x}/${ref.y}`;
}

export class SlideViewer {
  readonly info: SlideInfo;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly fileId: string;
  private display: ChannelDisplay[] = [];
  private luts: ChannelLut[] = [];
  private version = 0;
  private t = 0;
  private z = 0;
  private cx: number;
  private cy: number;
  private scale = 1;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private raw = new Map<string, RawTile>();
  private rawBytes = 0;
  private composites = new Map<string, Composite>();
  private inflight = new Map<string, AbortController>();
  private wanted: { key: string; ref: TileRef; channels: number[]; priority: number }[] = [];
  private frame = 0;
  private destroyed = false;
  private animation: { from: [number, number, number]; to: [number, number, number]; start: number } | null = null;
  private listeners = new Set<(state: ViewState) => void>();
  scaleBar = true;
  selection: Rect | null = null;
  onError: ((err: unknown) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, info: SlideInfo, display: ChannelDisplay[]) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.info = info;
    this.fileId = info.id;
    this.cx = info.width / 2;
    this.cy = info.height / 2;
    this.setDisplay(display);
    this.resize();
    this.fit(false);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    this.raw.clear();
    this.composites.clear();
    this.listeners.clear();
  }

  subscribe(listener: (state: ViewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  // --- view -------------------------------------------------------------------

  get minScale(): number {
    return this.fitScale() * 0.5;
  }

  fitScale(): number {
    return Math.min(this.cssW / this.info.width, this.cssH / this.info.height) * 0.96;
  }

  state(): ViewState {
    return {
      cx: this.cx,
      cy: this.cy,
      scale: this.scale,
      level: this.levelFor(this.scale),
      rect: this.viewRect(),
      width: this.cssW,
      height: this.cssH,
      loading: this.inflight.size + this.wanted.length,
    };
  }

  viewRect(): Rect {
    const w = this.cssW / this.scale;
    const h = this.cssH / this.scale;
    return { x: this.cx - w / 2, y: this.cy - h / 2, w, h };
  }

  resize(): void {
    const box = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssW = Math.max(1, box.width);
    this.cssH = Math.max(1, box.height);
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.render();
  }

  private clampScale(scale: number): number {
    return Math.min(MAX_SCALE, Math.max(this.minScale, scale));
  }

  private clampCenter(): void {
    // Keep at least part of the image on screen.
    const margin = Math.min(this.cssW, this.cssH) * 0.25 / this.scale;
    this.cx = Math.min(this.info.width + this.cssW / 2 / this.scale - margin, Math.max(-this.cssW / 2 / this.scale + margin, this.cx));
    this.cy = Math.min(this.info.height + this.cssH / 2 / this.scale - margin, Math.max(-this.cssH / 2 / this.scale + margin, this.cy));
  }

  private setView(cx: number, cy: number, scale: number, animate: boolean): void {
    scale = this.clampScale(scale);
    if (animate && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.animation = { from: [this.cx, this.cy, this.scale], to: [cx, cy, scale], start: performance.now() };
    } else {
      this.animation = null;
      this.cx = cx;
      this.cy = cy;
      this.scale = scale;
      this.clampCenter();
    }
    this.render();
  }

  fit(animate = true): void {
    this.setView(this.info.width / 2, this.info.height / 2, this.fitScale(), animate);
  }

  zoomTo(scale: number, anchor?: { x: number; y: number }, animate = true): void {
    const target = this.clampScale(scale);
    if (!anchor) {
      this.setView(this.cx, this.cy, target, animate);
      return;
    }
    // Keep the image point under the anchor (CSS px in the canvas) fixed.
    const ix = this.cx + (anchor.x - this.cssW / 2) / this.scale;
    const iy = this.cy + (anchor.y - this.cssH / 2) / this.scale;
    const cx = ix - (anchor.x - this.cssW / 2) / target;
    const cy = iy - (anchor.y - this.cssH / 2) / target;
    this.setView(cx, cy, target, animate);
  }

  zoomBy(factor: number, anchor?: { x: number; y: number }, animate = true): void {
    const base = this.animation ? this.animation.to[2] : this.scale;
    this.zoomTo(base * factor, anchor, animate);
  }

  panBy(dx: number, dy: number): void {
    this.animation = null;
    this.cx -= dx / this.scale;
    this.cy -= dy / this.scale;
    this.clampCenter();
    this.render();
  }

  centerOn(x: number, y: number, animate = true): void {
    this.setView(x, y, this.scale, animate);
  }

  /** Zoom so that a rectangle (image px) fills the view. */
  showRect(rect: Rect, animate = true): void {
    const scale = Math.min(this.cssW / rect.w, this.cssH / rect.h) * 0.92;
    this.setView(rect.x + rect.w / 2, rect.y + rect.h / 2, scale, animate);
  }

  screenToImage(x: number, y: number): { x: number; y: number } {
    return { x: this.cx + (x - this.cssW / 2) / this.scale, y: this.cy + (y - this.cssH / 2) / this.scale };
  }

  imageToScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.cx) * this.scale + this.cssW / 2, y: (y - this.cy) * this.scale + this.cssH / 2 };
  }

  /** The coarsest level that still has at least one pixel per device pixel. */
  levelFor(scale: number, dpr = this.dpr): number {
    const needed = 1 / (scale * dpr);
    let best = 0;
    this.info.levels.forEach((level, index) => {
      if (level.downsample <= needed * 1.15) best = index;
    });
    return best;
  }

  // --- display ----------------------------------------------------------------

  setDisplay(display: ChannelDisplay[]): void {
    const before = this.display;
    this.display = display.map((d) => ({ ...d, color: [...d.color] }));
    this.luts = this.display
      .map((d, index) => (d.visible ? buildLut(index, d, this.info.dtype) : null))
      .filter((lut): lut is ChannelLut => lut !== null);
    const same =
      before.length === this.display.length &&
      before.every((d, i) => {
        const n = this.display[i];
        return d.visible === n.visible && d.min === n.min && d.max === n.max && d.gamma === n.gamma && d.color.join() === n.color.join();
      });
    if (!same) {
      this.version += 1;
      this.render();
    }
  }

  setPlane(t: number, z: number): void {
    if (t === this.t && z === this.z) return;
    this.t = t;
    this.z = z;
    this.composites.clear();
    this.render();
  }

  private visibleChannels(): number[] {
    return this.luts.map((lut) => lut.index);
  }

  // --- tiles ------------------------------------------------------------------

  private tilesFor(level: number, rect: Rect): TileRef[] {
    const lv = this.info.levels[level];
    const size = this.info.tile_size;
    const ds = lv.downsample;
    const dsY = this.info.height / lv.height;
    const x0 = Math.max(0, Math.floor(rect.x / ds / size));
    const y0 = Math.max(0, Math.floor(rect.y / dsY / size));
    const x1 = Math.min(Math.ceil(lv.width / size) - 1, Math.floor((rect.x + rect.w) / ds / size));
    const y1 = Math.min(Math.ceil(lv.height / size) - 1, Math.floor((rect.y + rect.h) / dsY / size));
    const out: TileRef[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ level, x, y });
    return out;
  }

  private tileRect(ref: TileRef): Rect {
    const lv = this.info.levels[ref.level];
    const size = this.info.tile_size;
    const sx = this.info.width / lv.width;
    const sy = this.info.height / lv.height;
    const w = Math.min(size, lv.width - ref.x * size);
    const h = Math.min(size, lv.height - ref.y * size);
    return { x: ref.x * size * sx, y: ref.y * size * sy, w: w * sx, h: h * sy };
  }

  private rawKey(t: number, z: number, ref: TileRef, channel: number): string {
    return `${tileKey(t, z, ref)}/${channel}`;
  }

  private missingChannels(ref: TileRef, channels: number[]): number[] {
    return channels.filter((c) => !this.raw.has(this.rawKey(this.t, this.z, ref, c)));
  }

  private storeRaw(key: string, tile: RawTile): void {
    const old = this.raw.get(key);
    if (old) {
      this.rawBytes -= old.data.byteLength;
      this.raw.delete(key);
    }
    this.raw.set(key, tile);
    this.rawBytes += tile.data.byteLength;
    for (const [k, value] of this.raw) {
      if (this.rawBytes <= RAW_LIMIT_BYTES) break;
      this.raw.delete(k);
      this.rawBytes -= value.data.byteLength;
    }
  }

  private touchRaw(key: string): RawTile | undefined {
    const hit = this.raw.get(key);
    if (hit) {
      this.raw.delete(key);
      this.raw.set(key, hit);
    }
    return hit;
  }

  async fetchTile(ref: TileRef, channels: number[], t = this.t, z = this.z, signal?: AbortSignal): Promise<RawTile[]> {
    const q = new URLSearchParams({
      level: String(ref.level),
      x: String(ref.x),
      y: String(ref.y),
      c: channels.join(","),
      t: String(t),
      z: String(z),
    });
    const res = await fetch(`/api/files/${this.fileId}/slide/tile?${q}`, { signal });
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const { w, h, planes } = unpackTile(await res.arrayBuffer());
    const tiles = planes.map((data) => ({ w, h, data }));
    channels.forEach((c, i) => this.storeRaw(this.rawKey(t, z, ref, c), tiles[i]));
    return tiles;
  }

  private pump(): void {
    while (this.inflight.size < MAX_INFLIGHT && this.wanted.length) {
      const job = this.wanted.shift();
      if (!job || this.inflight.has(job.key)) continue;
      const controller = new AbortController();
      this.inflight.set(job.key, controller);
      const { t, z } = this;
      void this.fetchTile(job.ref, job.channels, t, z, controller.signal)
        .catch((err) => {
          if (!(err instanceof DOMException && err.name === "AbortError")) this.onError?.(err);
        })
        .finally(() => {
          if (this.inflight.get(job.key) === controller) this.inflight.delete(job.key);
          if (!this.destroyed) this.render();
        });
    }
  }

  private composite(ref: TileRef): Composite | null {
    const key = tileKey(this.t, this.z, ref);
    const channels = this.visibleChannels();
    const planes: Plane[] = [];
    let w = 0;
    let h = 0;
    for (const c of channels) {
      const tile = this.touchRaw(this.rawKey(this.t, this.z, ref, c));
      if (!tile) return null;
      planes.push(tile.data);
      w = tile.w;
      h = tile.h;
    }
    let entry = this.composites.get(key);
    if (!entry) {
      const rect = this.tileRect(ref);
      const lv = this.info.levels[ref.level];
      w = w || Math.round(rect.w / (this.info.width / lv.width));
      h = h || Math.round(rect.h / (this.info.height / lv.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      entry = { canvas, version: -1 };
    }
    const ctx = entry.canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(entry.canvas.width, entry.canvas.height);
    composeInto(image.data, planes, this.luts);
    ctx.putImageData(image, 0, 0);
    entry.version = this.version;
    this.composites.delete(key);
    this.composites.set(key, entry);
    while (this.composites.size > COMPOSITE_LIMIT) {
      this.composites.delete(this.composites.keys().next().value as string);
    }
    return entry;
  }

  // --- rendering ----------------------------------------------------------------

  render(): void {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private stepAnimation(now: number): boolean {
    const anim = this.animation;
    if (!anim) return false;
    const p = Math.min(1, (now - anim.start) / 220);
    const e = 1 - Math.pow(1 - p, 3);
    // Interpolate zoom geometrically so it feels uniform.
    const scale = anim.from[2] * Math.pow(anim.to[2] / anim.from[2], e);
    this.cx = anim.from[0] + (anim.to[0] - anim.from[0]) * e;
    this.cy = anim.from[1] + (anim.to[1] - anim.from[1]) * e;
    this.scale = scale;
    if (p >= 1) {
      this.animation = null;
      this.clampCenter();
    }
    return p < 1;
  }

  private draw(): void {
    const now = performance.now();
    const animating = this.stepAnimation(now);
    const { ctx, dpr } = this;
    const rect = this.viewRect();
    const target = this.levelFor(this.scale);
    const coarsest = this.info.levels.length - 1;
    const channels = this.visibleChannels();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#050607";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * (this.cssW / 2 - this.cx * this.scale), dpr * (this.cssH / 2 - this.cy * this.scale));

    // Image backdrop so empty (zero) regions and the image bounds stay readable.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.info.width, this.info.height);

    const wanted: typeof this.wanted = [];
    const stale: TileRef[] = [];
    const deadline = now + COMPOSE_BUDGET_MS;
    const centerX = this.cx;
    const centerY = this.cy;

    // Coarse levels first as fallback, then the target level on top.
    const levels: number[] = [];
    for (let level = coarsest; level >= target; level--) levels.push(level);
    for (const level of levels) {
      const refs = this.tilesFor(level, rect);
      // Intermediate levels are only drawn where something is cached; never fetched.
      const fetchHere = level === target || level === coarsest;
      for (const ref of refs) {
        const key = tileKey(this.t, this.z, ref);
        let comp = this.composites.get(key) ?? null;
        if (channels.length && (!comp || comp.version !== this.version)) {
          const missing = this.missingChannels(ref, channels);
          if (missing.length === 0) {
            // A bounded amount of compositing per frame keeps panning smooth; the rest follows.
            if (performance.now() < deadline) comp = this.composite(ref) ?? comp;
            else stale.push(ref);
          } else if (fetchHere) {
            const r = this.tileRect(ref);
            const dist = Math.hypot(r.x + r.w / 2 - centerX, r.y + r.h / 2 - centerY);
            wanted.push({ key: `${key}/${missing.join(",")}`, ref, channels: missing, priority: (level === target ? 0 : -1e12) + dist });
          }
        }
        if (comp) {
          const r = this.tileRect(ref);
          // Snap tile edges to device pixels so neighbouring tiles do not show hairline seams.
          const k = dpr * this.scale;
          const ox = dpr * (this.cssW / 2 - this.cx * this.scale);
          const oy = dpr * (this.cssH / 2 - this.cy * this.scale);
          const x0 = Math.round(r.x * k + ox);
          const y0 = Math.round(r.y * k + oy);
          const x1 = Math.round((r.x + r.w) * k + ox);
          const y1 = Math.round((r.y + r.h) * k + oy);
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const lv = this.info.levels[ref.level];
          const pixelsPerTexel = (k * this.info.width) / lv.width;
          ctx.imageSmoothingEnabled = pixelsPerTexel < 2.5;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(comp.canvas, x0, y0, x1 - x0, y1 - y0);
          ctx.restore();
        }
      }
    }
    if (!channels.length) {
      wanted.length = 0;
    }

    // Requests that are no longer needed (panned away) are dropped from the queue;
    // in-flight ones whose tile left the screen are aborted.
    wanted.sort((a, b) => a.priority - b.priority);
    this.wanted = wanted.filter((job) => !this.inflight.has(job.key));
    const keep = new Set(wanted.map((job) => job.key));
    for (const [key, controller] of this.inflight) {
      if (!keep.has(key) && !animating) {
        controller.abort();
        this.inflight.delete(key);
      }
    }
    this.pump();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawOverlays();

    for (const listener of this.listeners) listener(this.state());
    if (animating || stale.length) this.render();
  }

  private drawOverlays(): void {
    const { ctx } = this;
    if (this.selection) {
      const a = this.imageToScreen(this.selection.x, this.selection.y);
      const b = this.imageToScreen(this.selection.x + this.selection.w, this.selection.y + this.selection.h);
      ctx.save();
      ctx.fillStyle = "rgb(0 0 0 / 0.35)";
      ctx.beginPath();
      ctx.rect(0, 0, this.cssW, this.cssH);
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.fill("evenodd");
      ctx.strokeStyle = "rgb(255 255 255 / 0.95)";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    }
    if (this.scaleBar && this.info.um_per_px) {
      drawScaleBar(ctx, this.cssW, this.cssH, this.info.um_per_px / this.scale);
    }
  }

  /** Native values of the visible channels at an image point, from the best loaded level. */
  probe(x: number, y: number): { level: number; values: (number | null)[] } | null {
    if (x < 0 || y < 0 || x >= this.info.width || y >= this.info.height) return null;
    const size = this.info.tile_size;
    for (let level = this.levelFor(this.scale); level < this.info.levels.length; level++) {
      const lv = this.info.levels[level];
      const lx = Math.floor((x * lv.width) / this.info.width);
      const ly = Math.floor((y * lv.height) / this.info.height);
      const ref = { level, x: Math.floor(lx / size), y: Math.floor(ly / size) };
      const values = this.display.map((_, c) => {
        const tile = this.raw.get(this.rawKey(this.t, this.z, ref, c));
        return tile ? tile.data[(ly - ref.y * size) * tile.w + (lx - ref.x * size)] : null;
      });
      if (values.some((v) => v !== null)) return { level, values };
    }
    return null;
  }

  // --- capture ------------------------------------------------------------------

  /** The current view at `k` x screen resolution (capped at `maxEdge` px per side). */
  capture(opts: { k: number; scaleBar: boolean; legend: boolean; names: string[]; maxEdge?: number }): Promise<HTMLCanvasElement> {
    const view = this.viewRect();
    const clip = this.clipToImage(view);
    let outScale = this.scale * opts.k;
    const maxEdge = opts.maxEdge ?? 8192;
    if (Math.max(clip.w, clip.h) * outScale > maxEdge) outScale = maxEdge / Math.max(clip.w, clip.h);
    // Browsers refuse canvases above ~16.7 megapixels (Safari).
    const area = clip.w * clip.h * outScale * outScale;
    if (area > MAX_CANVAS_PIXELS) outScale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    // Legend and scale bar keep their on-screen size relative to the view.
    return this.renderRegion(clip, outScale, { ...opts, uiScale: Math.max(1, outScale / this.scale) });
  }

  /** The whole image within `edge` px (navigator thumbnail). */
  thumbnail(edge: number): Promise<HTMLCanvasElement> {
    const outScale = edge / Math.max(this.info.width, this.info.height);
    return this.renderRegion({ x: 0, y: 0, w: this.info.width, h: this.info.height }, outScale, { scaleBar: false, legend: false, names: [] });
  }

  private clipToImage(region: Rect): Rect {
    const x = Math.max(0, region.x);
    const y = Math.max(0, region.y);
    return {
      x,
      y,
      w: Math.min(this.info.width, region.x + region.w) - x,
      h: Math.min(this.info.height, region.y + region.h) - y,
    };
  }

  /** Render an image region at `outScale` output px per image px, waiting for the needed tiles. */
  async renderRegion(
    clip: Rect,
    outScale: number,
    opts: { scaleBar: boolean; legend: boolean; names: string[]; uiScale?: number },
  ): Promise<HTMLCanvasElement> {
    if (clip.w <= 0 || clip.h <= 0) throw new Error("empty_region");
    const outW = Math.max(1, Math.round(clip.w * outScale));
    const outH = Math.max(1, Math.round(clip.h * outScale));
    const level = this.levelFor(outScale, 1);
    const refs = this.tilesFor(level, clip);
    const channels = this.visibleChannels();
    const luts = this.luts;
    const t = this.t;
    const z = this.z;
    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = (outScale * this.info.width) / this.info.levels[level].width < 2.5;
    ctx.imageSmoothingQuality = "high";

    // Each tile is composited as soon as its channels are there, so a large render never
    // depends on everything fitting in the tile cache at once.
    const queue = [...refs];
    const worker = async () => {
      const scratch = document.createElement("canvas");
      const sctx = scratch.getContext("2d");
      if (!sctx) throw new Error("Canvas 2D is not available");
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        const have = new Map<number, RawTile>();
        for (const c of channels) {
          const hit = this.raw.get(this.rawKey(t, z, ref, c));
          if (hit) have.set(c, hit);
        }
        const missing = channels.filter((c) => !have.has(c));
        if (missing.length) {
          const fetched = await this.fetchTile(ref, missing, t, z);
          missing.forEach((c, i) => have.set(c, fetched[i]));
        }
        const r = this.tileRect(ref);
        const x0 = Math.round((r.x - clip.x) * outScale);
        const y0 = Math.round((r.y - clip.y) * outScale);
        const x1 = Math.round((r.x + r.w - clip.x) * outScale);
        const y1 = Math.round((r.y + r.h - clip.y) * outScale);
        if (!channels.length) continue;
        const first = have.get(channels[0]);
        if (!first) continue;
        scratch.width = first.w;
        scratch.height = first.h;
        const image = sctx.createImageData(first.w, first.h);
        composeInto(
          image.data,
          channels.map((c) => (have.get(c) as RawTile).data),
          luts,
        );
        sctx.putImageData(image, 0, 0);
        ctx.drawImage(scratch, x0, y0, x1 - x0, y1 - y0);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_INFLIGHT, refs.length) }, worker));

    const k = opts.uiScale ?? Math.max(1, Math.min(outW, outH) / 700);
    if (opts.legend && channels.length) {
      ctx.save();
      ctx.font = `${12 * k}px "Geist Variable", system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      const row = 20 * k;
      const width = Math.max(...channels.map((c) => ctx.measureText(opts.names[c] ?? `C${c + 1}`).width)) + 34 * k;
      ctx.fillStyle = "rgb(8 8 10 / 0.78)";
      ctx.fillRect(12 * k, 12 * k, width, row * channels.length + 10 * k);
      channels.forEach((c, i) => {
        const y = 17 * k + row * i + row / 2;
        const [r, g, b] = this.display[c].color;
        ctx.fillStyle = `rgb(${r} ${g} ${b})`;
        ctx.beginPath();
        ctx.arc(26 * k, y, 5 * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgb(240 244 248)";
        ctx.fillText(opts.names[c] ?? `C${c + 1}`, 38 * k, y);
      });
      ctx.restore();
    }
    if (opts.scaleBar && this.info.um_per_px) drawScaleBar(ctx, outW, outH, this.info.um_per_px / outScale, k);
    return out;
  }
}
