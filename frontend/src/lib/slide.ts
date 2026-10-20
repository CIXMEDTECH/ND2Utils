/**
 * Tiled, multi-resolution, multi-channel slide viewer engine (no React).
 *
 * The server sends native-value channel tiles (u8/u16/f32) for one resolution level; the browser
 * maps every channel through its own LUT (color, range, gamma) and adds them up — on the GPU
 * (WebGL2) when available, otherwise on the CPU. Changing a channel's color or range therefore
 * never re-downloads anything, and switching a channel on only fetches that channel.
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

const RAW_LIMIT_BYTES = 256 * 1024 * 1024;
const COMPOSITE_LIMIT = 220;
const MAX_INFLIGHT = 6;
const COMPOSE_BUDGET_MS = 12;
export const MAX_SCALE = 20;
/** "browser": channels composited on the client (GPU when available); "server": the server
 *  sends finished JPEG tiles (Settings → Performance → render mode). */
export type RenderMode = "browser" | "server";
const SERVER_TILE_LIMIT = 320;
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

/** Compact, stable number text for URLs (slider values carry float noise). */
function short(v: number): string {
  return String(Number(v.toPrecision(6)));
}

function tileKey(t: number, z: number, ref: TileRef): string {
  return `${t}/${z}/${ref.level}/${ref.x}/${ref.y}`;
}

// --- WebGL2 renderer ----------------------------------------------------------------
//
// Every channel tile is a single-channel texture. A tile is drawn once per visible channel with
// additive blending (the GPU clamps the sum at 1, like the CPU path), the LUT applied in the
// fragment shader: changing a color or range is just new uniforms, nothing is recomputed.
// Finer levels are drawn first and write depth, so the coarser fallback tiles drawn after them
// only show where the finer tiles are still missing.

const VERT = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;
uniform float u_depth;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(mix(u_rect.xy, u_rect.zw, a_pos), u_depth, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_solid;
uniform float u_scale;
uniform float u_min;
uniform float u_span;
uniform float u_invGamma;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  if (u_solid == 1) {
    outColor = vec4(u_color, 1.0);
    return;
  }
  float v = texture(u_tex, v_uv).r * u_scale;
  float y = clamp((v - u_min) / u_span, 0.0, 1.0);
  outColor = vec4(u_color * pow(y, u_invGamma), 1.0);
}`;

const R16_EXT = 0x822a;
const TEXTURE_LIMIT_BYTES = 320 * 1024 * 1024;
const UPLOADS_PER_FRAME = 48;

interface GpuTexture {
  tex: WebGLTexture;
  bytes: number;
  /** Texture value -> native pixel value. */
  scale: number;
  /** Float texture (linear filtering needs an extension). */
  float: boolean;
}

class GlRenderer {
  readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private samplerLinear!: WebGLSampler;
  private samplerNearest!: WebGLSampler;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private textures = new Map<string, GpuTexture>();
  private textureBytes = 0;
  private norm16 = false;
  private floatLinear = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.init();
  }

  init(): void {
    const { gl } = this;
    this.textures.clear();
    this.textureBytes = 0;
    this.norm16 = Boolean(gl.getExtension("EXT_texture_norm16"));
    this.floatLinear = Boolean(gl.getExtension("OES_texture_float_linear"));
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("WebGL shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL program");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
    this.program = program;
    for (const name of ["u_rect", "u_depth", "u_tex", "u_solid", "u_scale", "u_min", "u_span", "u_invGamma", "u_color"]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error("WebGL buffers");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
    const sampler = (filter: number) => {
      const s = gl.createSampler();
      if (!s) throw new Error("WebGL sampler");
      gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, filter);
      gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, filter);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return s;
    };
    this.samplerLinear = sampler(gl.LINEAR);
    this.samplerNearest = sampler(gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  dispose(): void {
    for (const { tex } of this.textures.values()) this.gl.deleteTexture(tex);
    this.textures.clear();
    this.textureBytes = 0;
  }

  has(key: string): boolean {
    return this.textures.has(key);
  }

  texture(key: string): GpuTexture | null {
    const hit = this.textures.get(key);
    if (!hit) return null;
    this.textures.delete(key);
    this.textures.set(key, hit);
    return hit;
  }

  upload(key: string, tile: RawTile): GpuTexture | null {
    const { gl } = this;
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const { data } = tile;
    let entry: GpuTexture;
    if (data instanceof Uint8Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, tile.w, tile.h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      entry = { tex, bytes: tile.w * tile.h, scale: 255, float: false };
    } else if (data instanceof Uint16Array && this.norm16) {
      gl.texImage2D(gl.TEXTURE_2D, 0, R16_EXT, tile.w, tile.h, 0, gl.RED, gl.UNSIGNED_SHORT, data);
      entry = { tex, bytes: tile.w * tile.h * 2, scale: 65535, float: false };
    } else {
      const floats = data instanceof Float32Array ? data : Float32Array.from(data);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, tile.w, tile.h, 0, gl.RED, gl.FLOAT, floats);
      entry = { tex, bytes: tile.w * tile.h * 4, scale: 1, float: true };
    }
    const bytes = entry.bytes;
    this.textures.set(key, entry);
    this.textureBytes += bytes;
    for (const [k, value] of this.textures) {
      if (this.textureBytes <= TEXTURE_LIMIT_BYTES) break;
      gl.deleteTexture(value.tex);
      this.textures.delete(k);
      this.textureBytes -= value.bytes;
    }
    return entry;
  }

  begin(width: number, height: number, backdrop: [number, number, number, number]): void {
    const { gl } = this;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.02, 0.024, 0.027, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    // The image area is drawn black (furthest back) so its outline stays visible.
    gl.disable(gl.BLEND);
    gl.uniform1i(this.uniforms.u_solid, 1);
    gl.uniform3f(this.uniforms.u_color, 0, 0, 0);
    gl.uniform4f(this.uniforms.u_rect, ...backdrop);
    gl.uniform1f(this.uniforms.u_depth, 0.95);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1i(this.uniforms.u_solid, 0);
    gl.uniform1i(this.uniforms.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  drawTile(
    rect: [number, number, number, number],
    depth: number,
    nearest: boolean,
    layers: { gpu: GpuTexture; display: ChannelDisplay }[],
  ): void {
    const { gl, uniforms } = this;
    gl.uniform4f(uniforms.u_rect, ...rect);
    gl.uniform1f(uniforms.u_depth, depth);
    for (const layer of layers) {
      const linear = !nearest && (!layer.gpu.float || this.floatLinear);
      gl.bindSampler(0, linear ? this.samplerLinear : this.samplerNearest);
      gl.bindTexture(gl.TEXTURE_2D, layer.gpu.tex);
      const d = layer.display;
      gl.uniform1f(uniforms.u_scale, layer.gpu.scale);
      gl.uniform1f(uniforms.u_min, d.min);
      gl.uniform1f(uniforms.u_span, Math.max(d.max - d.min, 1e-6));
      gl.uniform1f(uniforms.u_invGamma, 1 / (d.gamma || 1));
      gl.uniform3f(uniforms.u_color, d.color[0] / 255, d.color[1] / 255, d.color[2] / 255);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}

// --- viewer -------------------------------------------------------------------------

export class SlideViewer {
  readonly info: SlideInfo;
  private readonly container: HTMLElement;
  private base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D;
  private gl: GlRenderer | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private readonly fileId: string;
  /** Cache version of the file: part of tile URLs, so browsers may keep tiles until a rebuild. */
  private readonly cacheVersion: string;
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
  /** Set once the user pans or zooms; until then the view keeps fitting the window. */
  private userMoved = false;
  private raw = new Map<string, RawTile>();
  private rawBytes = 0;
  private composites = new Map<string, Composite>();
  private inflight = new Map<string, AbortController>();
  /** Raw keys (tile + channel) currently being downloaded. */
  private loading = new Set<string>();
  private wanted: { key: string; ref: TileRef; channels: number[]; priority: number }[] = [];
  private frame = 0;
  private destroyed = false;
  private animation: { from: [number, number, number]; to: [number, number, number]; start: number } | null = null;
  private listeners = new Set<(state: ViewState) => void>();
  private notifyTimer = 0;
  private lastNotify = 0;
  private resizeObserver: ResizeObserver;
  scaleBar = true;
  selection: Rect | null = null;
  onError: ((err: unknown) => void) | null = null;
  readonly mode: RenderMode;
  /** Server-rendered tiles by `${tile}|${display}`; `latest` remembers each tile's newest one,
   *  shown while the tile for new display settings is on its way. */
  private served = new Map<string, ImageBitmap>();
  private latest = new Map<string, string>();
  private displayKey = "";

  constructor(container: HTMLElement, info: SlideInfo, display: ChannelDisplay[], options: { mode?: RenderMode } = {}) {
    this.mode = options.mode ?? "browser";
    this.container = container;
    this.info = info;
    this.fileId = info.id;
    this.cacheVersion = String(info.version ?? "");
    this.cx = info.width / 2;
    this.cy = info.height / 2;
    const layer = () => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
      container.appendChild(canvas);
      return canvas;
    };
    this.base = layer();
    this.overlay = layer();
    const octx = this.overlay.getContext("2d");
    if (!octx) throw new Error("Canvas 2D is not available");
    this.octx = octx;
    const gl =
      this.mode === "browser"
        ? this.base.getContext("webgl2", { alpha: false, antialias: false, depth: true, premultipliedAlpha: false })
        : null;
    if (gl) {
      try {
        this.gl = new GlRenderer(gl);
      } catch {
        this.gl = null;
      }
    }
    if (!this.gl) {
      // Server tiles, or no WebGL2 (or it failed to initialise): a plain 2D canvas.
      const fallback = document.createElement("canvas");
      fallback.style.cssText = this.base.style.cssText;
      container.replaceChild(fallback, this.base);
      this.base = fallback;
      this.ctx = fallback.getContext("2d", { alpha: false });
    } else {
      this.base.addEventListener("webglcontextlost", this.onContextLost);
      this.base.addEventListener("webglcontextrestored", this.onContextRestored);
    }
    this.setDisplay(display);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get renderer(): "webgl" | "canvas" | "server" {
    return this.mode === "server" ? "server" : this.gl ? "webgl" : "canvas";
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  };

  private onContextRestored = () => {
    try {
      this.gl?.init();
    } catch (err) {
      this.onError?.(err);
    }
    this.render();
  };

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.notifyTimer);
    this.resizeObserver.disconnect();
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    this.loading.clear();
    this.raw.clear();
    this.composites.clear();
    for (const bitmap of this.served.values()) bitmap.close();
    this.served.clear();
    this.latest.clear();
    this.listeners.clear();
    this.gl?.dispose();
    this.base.removeEventListener("webglcontextlost", this.onContextLost);
    this.base.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.base.remove();
    this.overlay.remove();
  }

  subscribe(listener: (state: ViewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  /** Listeners (React state) are told about view changes at most ~12 times per second. */
  private notify(): void {
    if (!this.listeners.size || this.notifyTimer) return;
    const wait = Math.max(0, 80 - (performance.now() - this.lastNotify));
    this.notifyTimer = window.setTimeout(() => {
      this.notifyTimer = 0;
      this.lastNotify = performance.now();
      if (this.destroyed) return;
      const state = this.state();
      for (const listener of this.listeners) listener(state);
    }, wait);
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
      loading: this.loading.size + this.wanted.length,
    };
  }

  viewRect(): Rect {
    const w = this.cssW / this.scale;
    const h = this.cssH / this.scale;
    return { x: this.cx - w / 2, y: this.cy - h / 2, w, h };
  }

  resize(): void {
    if (this.destroyed) return;
    const box = this.container.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return; // not laid out yet (hidden / collapsing)
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssW = box.width;
    this.cssH = box.height;
    for (const canvas of [this.base, this.overlay]) {
      const w = Math.round(this.cssW * this.dpr);
      const h = Math.round(this.cssH * this.dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    if (!this.userMoved) {
      this.animation = null;
      this.cx = this.info.width / 2;
      this.cy = this.info.height / 2;
      this.scale = this.fitScale();
    } else {
      this.scale = this.clampScale(this.scale);
      this.clampCenter();
    }
    this.render();
  }

  private clampScale(scale: number): number {
    return Math.min(MAX_SCALE, Math.max(this.minScale, scale));
  }

  private clampCenter(): void {
    // Keep at least part of the image on screen.
    const margin = (Math.min(this.cssW, this.cssH) * 0.25) / this.scale;
    this.cx = Math.min(this.info.width + this.cssW / 2 / this.scale - margin, Math.max(-this.cssW / 2 / this.scale + margin, this.cx));
    this.cy = Math.min(this.info.height + this.cssH / 2 / this.scale - margin, Math.max(-this.cssH / 2 / this.scale + margin, this.cy));
  }

  private setView(cx: number, cy: number, scale: number, animate: boolean): void {
    this.userMoved = true;
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
    this.userMoved = false;
  }

  zoomTo(scale: number, anchor?: { x: number; y: number }, animate = true): void {
    const target = this.clampScale(scale);
    if (!anchor) {
      const [cx, cy] = this.animation ? [this.animation.to[0], this.animation.to[1]] : [this.cx, this.cy];
      this.setView(cx, cy, target, animate);
      return;
    }
    // Keep the image point under the anchor (CSS px in the stage) fixed.
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
    this.userMoved = true;
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

  /** The coarsest level that still has about one pixel per device pixel. */
  levelFor(scale: number, dpr = this.dpr): number {
    const needed = 1 / (scale * dpr);
    let best = 0;
    this.info.levels.forEach((level, index) => {
      if (level.downsample <= needed * 1.3) best = index;
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
    this.displayKey = this.display
      .map((d, i) => (d.visible ? `${i},${short(d.min)},${short(d.max)},${short(d.gamma)},${d.color.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}` : ""))
      .filter(Boolean)
      .join(";");
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
      v: this.cacheVersion,
    });
    const res = await fetch(`/api/files/${this.fileId}/slide/tile?${q}`, { signal });
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const { w, h, planes } = unpackTile(await res.arrayBuffer());
    const tiles = planes.map((data) => ({ w, h, data }));
    channels.forEach((c, i) => this.storeRaw(this.rawKey(t, z, ref, c), tiles[i]));
    return tiles;
  }

  private servedKey(ref: TileRef, display = this.displayKey, t = this.t, z = this.z): string {
    return `${tileKey(t, z, ref)}|${display}`;
  }

  /** A tile composited by the server for the given display settings. */
  async fetchRendered(
    ref: TileRef,
    display = this.displayKey,
    t = this.t,
    z = this.z,
    signal?: AbortSignal,
    keep = true,
  ): Promise<ImageBitmap> {
    const q = new URLSearchParams({ level: String(ref.level), x: String(ref.x), y: String(ref.y), d: display, t: String(t), z: String(z), v: this.cacheVersion });
    const res = await fetch(`/api/files/${this.fileId}/slide/render?${q}`, { signal });
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    if (!keep) return bitmap;
    const key = this.servedKey(ref, display, t, z);
    if (this.destroyed) {
      bitmap.close();
      return bitmap;
    }
    this.served.get(key)?.close();
    this.served.delete(key);
    this.served.set(key, bitmap);
    // Keep only the newest bitmap per tile (+ LRU across tiles).
    const tile = tileKey(t, z, ref);
    const previous = this.latest.get(tile);
    if (previous && previous !== key) {
      this.served.get(previous)?.close();
      this.served.delete(previous);
    }
    this.latest.set(tile, key);
    while (this.served.size > SERVER_TILE_LIMIT) {
      const [oldest, old] = this.served.entries().next().value as [string, ImageBitmap];
      old.close();
      this.served.delete(oldest);
      const owner = oldest.slice(0, oldest.indexOf("|"));
      if (this.latest.get(owner) === oldest) this.latest.delete(owner);
    }
    return bitmap;
  }

  /** Start queued downloads. In-flight downloads are never cancelled by panning or zooming:
   *  they finish into the cache and serve as fallback (cancelling made fast zooming load nothing). */
  private pump(): void {
    while (this.inflight.size < MAX_INFLIGHT && this.wanted.length) {
      const job = this.wanted.shift();
      if (!job) break;
      if (this.mode === "server") {
        if (this.loading.has(job.key)) continue;
        const controller = new AbortController();
        const id = `${job.key}#${performance.now()}`;
        this.inflight.set(id, controller);
        this.loading.add(job.key);
        const { t, z, displayKey } = this;
        void this.fetchRendered(job.ref, displayKey, t, z, controller.signal)
          .catch((err) => {
            if (!(err instanceof DOMException && err.name === "AbortError")) this.onError?.(err);
          })
          .finally(() => {
            this.inflight.delete(id);
            this.loading.delete(job.key);
            if (!this.destroyed) this.render();
          });
        continue;
      }
      const keys = job.channels.map((c) => this.rawKey(this.t, this.z, job.ref, c));
      if (keys.some((k) => this.loading.has(k))) continue;
      const controller = new AbortController();
      const id = `${job.key}#${performance.now()}`;
      this.inflight.set(id, controller);
      keys.forEach((k) => this.loading.add(k));
      const { t, z } = this;
      void this.fetchTile(job.ref, job.channels, t, z, controller.signal)
        .catch((err) => {
          if (!(err instanceof DOMException && err.name === "AbortError")) this.onError?.(err);
        })
        .finally(() => {
          this.inflight.delete(id);
          keys.forEach((k) => this.loading.delete(k));
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
    this.scale = anim.from[2] * Math.pow(anim.to[2] / anim.from[2], e);
    this.cx = anim.from[0] + (anim.to[0] - anim.from[0]) * e;
    this.cy = anim.from[1] + (anim.to[1] - anim.from[1]) * e;
    if (p >= 1) {
      this.animation = null;
      this.clampCenter();
    }
    return p < 1;
  }

  /** Decide what to download: coarsest level first (instant overview), then a level two steps
   *  coarser than needed (quick fill while zooming), then the needed level, nearest the center first. */
  private plan(rect: Rect, target: number, channels: number[]): void {
    const coarsest = this.info.levels.length - 1;
    const steps = [coarsest, Math.min(target + 2, coarsest), target].filter((v, i, all) => all.indexOf(v) === i);
    const wanted: typeof this.wanted = [];
    if (channels.length && this.mode === "server") {
      steps.forEach((level, rank) => {
        for (const ref of this.tilesFor(level, rect)) {
          const key = this.servedKey(ref);
          if (this.served.has(key) || this.loading.has(key)) continue;
          const r = this.tileRect(ref);
          const dist = Math.hypot(r.x + r.w / 2 - this.cx, r.y + r.h / 2 - this.cy);
          wanted.push({ key, ref, channels, priority: rank * 1e12 + dist });
        }
      });
    } else if (channels.length) {
      steps.forEach((level, rank) => {
        for (const ref of this.tilesFor(level, rect)) {
          const missing = channels.filter((c) => {
            const key = this.rawKey(this.t, this.z, ref, c);
            return !this.raw.has(key) && !this.loading.has(key) && !this.gl?.has(key);
          });
          if (!missing.length) continue;
          const r = this.tileRect(ref);
          const dist = Math.hypot(r.x + r.w / 2 - this.cx, r.y + r.h / 2 - this.cy);
          wanted.push({ key: tileKey(this.t, this.z, ref), ref, channels: missing, priority: rank * 1e12 + dist });
        }
      });
    }
    wanted.sort((a, b) => a.priority - b.priority);
    this.wanted = wanted;
    this.pump();
  }

  private draw(): void {
    const now = performance.now();
    const animating = this.stepAnimation(now);
    const rect = this.viewRect();
    const target = this.levelFor(this.scale);
    const channels = this.visibleChannels();
    this.plan(rect, target, channels);
    const pending =
      this.mode === "server"
        ? this.drawServed(rect, target, channels)
        : this.gl
          ? this.drawGl(rect, target, channels)
          : this.draw2d(rect, target, channels, now);
    this.drawOverlays();
    this.notify();
    if (animating || pending) this.render();
  }

  /** Device-pixel transform of an image rectangle: [x0, y0, x1, y1]. */
  private toDevice(r: Rect): [number, number, number, number] {
    const k = this.dpr * this.scale;
    const ox = this.dpr * (this.cssW / 2 - this.cx * this.scale);
    const oy = this.dpr * (this.cssH / 2 - this.cy * this.scale);
    return [r.x * k + ox, r.y * k + oy, (r.x + r.w) * k + ox, (r.y + r.h) * k + oy];
  }

  private toClip(r: Rect): [number, number, number, number] {
    const [x0, y0, x1, y1] = this.toDevice(r);
    const W = this.base.width;
    const H = this.base.height;
    return [(x0 / W) * 2 - 1, 1 - (y0 / H) * 2, (x1 / W) * 2 - 1, 1 - (y1 / H) * 2];
  }

  private drawGl(rect: Rect, target: number, channels: number[]): boolean {
    const gl = this.gl;
    if (!gl || gl.gl.isContextLost()) return false;
    gl.begin(this.base.width, this.base.height, this.toClip({ x: 0, y: 0, w: this.info.width, h: this.info.height }));
    const coarsest = this.info.levels.length - 1;
    let uploads = 0;
    let pending = false;
    if (!channels.length) return false;
    for (let level = target; level <= coarsest; level++) {
      // Finer levels are nearer: coarser tiles only fill the gaps.
      const depth = -0.9 + (1.7 * level) / Math.max(coarsest, 1);
      const lv = this.info.levels[level];
      const nearest = (this.dpr * this.scale * this.info.width) / lv.width > 2.5;
      for (const ref of this.tilesFor(level, rect)) {
        const layers: { gpu: GpuTexture; display: ChannelDisplay }[] = [];
        for (const c of channels) {
          const key = this.rawKey(this.t, this.z, ref, c);
          let gpu = gl.texture(key);
          if (!gpu) {
            const raw = this.raw.get(key);
            if (raw && uploads < UPLOADS_PER_FRAME) {
              gpu = gl.upload(key, raw);
              uploads += 1;
            } else if (raw) {
              pending = true;
            }
          }
          if (!gpu) break;
          layers.push({ gpu, display: this.display[c] });
        }
        if (layers.length === channels.length) gl.drawTile(this.toClip(this.tileRect(ref)), depth, nearest, layers);
      }
    }
    return pending;
  }

  /** Server mode: finished tiles, coarse first and finer ones painted over them. */
  private drawServed(rect: Rect, target: number, channels: number[]): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#050607";
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const [bx0, by0, bx1, by1] = this.toDevice({ x: 0, y: 0, w: this.info.width, h: this.info.height });
    ctx.fillStyle = "#000";
    ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
    if (!channels.length) return false;
    const coarsest = this.info.levels.length - 1;
    for (let level = coarsest; level >= target; level--) {
      const lv = this.info.levels[level];
      ctx.imageSmoothingEnabled = (this.dpr * this.scale * this.info.width) / lv.width < 2.5;
      for (const ref of this.tilesFor(level, rect)) {
        const current = this.served.get(this.servedKey(ref));
        const fallback = current ?? (level === target || level === coarsest ? this.served.get(this.latest.get(tileKey(this.t, this.z, ref)) ?? "") : undefined);
        if (!fallback) continue;
        const [x0, y0, x1, y1] = this.toDevice(this.tileRect(ref)).map(Math.round);
        ctx.drawImage(fallback, x0, y0, x1 - x0, y1 - y0);
      }
    }
    return false;
  }

  private draw2d(rect: Rect, target: number, channels: number[], now: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const { dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#050607";
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const [bx0, by0, bx1, by1] = this.toDevice({ x: 0, y: 0, w: this.info.width, h: this.info.height });
    ctx.fillStyle = "#000";
    ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
    if (!channels.length) return false;
    const deadline = now + COMPOSE_BUDGET_MS;
    let pending = false;
    const coarsest = this.info.levels.length - 1;
    for (let level = coarsest; level >= target; level--) {
      const lv = this.info.levels[level];
      ctx.imageSmoothingEnabled = (dpr * this.scale * this.info.width) / lv.width < 2.5;
      for (const ref of this.tilesFor(level, rect)) {
        let comp = this.composites.get(tileKey(this.t, this.z, ref)) ?? null;
        if (!comp || comp.version !== this.version) {
          const ready = channels.every((c) => this.raw.has(this.rawKey(this.t, this.z, ref, c)));
          if (ready) {
            if (performance.now() < deadline) comp = this.composite(ref) ?? comp;
            else pending = true;
          }
          // A stale composite would show the old channel set: only draw up-to-date ones.
          if (comp && comp.version !== this.version) comp = null;
        }
        if (!comp) continue;
        const [x0, y0, x1, y1] = this.toDevice(this.tileRect(ref)).map(Math.round);
        ctx.drawImage(comp.canvas, x0, y0, x1 - x0, y1 - y0);
      }
    }
    return pending;
  }

  private drawOverlays(): void {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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
    if (this.mode === "server") return null; // only finished RGB tiles reach the browser
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
    const display = this.displayKey;
    const place = (ref: TileRef, image: CanvasImageSource) => {
      const r = this.tileRect(ref);
      const x0 = Math.round((r.x - clip.x) * outScale);
      const y0 = Math.round((r.y - clip.y) * outScale);
      const x1 = Math.round((r.x + r.w - clip.x) * outScale);
      const y1 = Math.round((r.y + r.h - clip.y) * outScale);
      ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
    };
    const serverWorker = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        if (!channels.length) continue;
        const cached = this.served.get(this.servedKey(ref, display, t, z));
        const bitmap = cached ?? (await this.fetchRendered(ref, display, t, z, undefined, false));
        place(ref, bitmap);
        if (!cached) bitmap.close();
      }
    };
    const worker = async () => {
      if (this.mode === "server") return serverWorker();
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
