import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CornersOut, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { t } from "../i18n";
import { clientSettings } from "../lib/api";
import { detailMessage } from "../lib/format";
import { MAX_SCALE, SlideViewer, type ChannelDisplay, type Rect, type RenderMode, type ViewState } from "../lib/slide";
import { readPref } from "../lib/storage";
import type { SlideInfo } from "../lib/types";
import { useApp } from "../store";

export type SlideTool = "pan" | "select";

export interface SlideCursor {
  x: number;
  y: number;
  level: number;
  values: (number | null)[];
}

const DISPLAY_KEY = "nd2utils.slide.display.";
const MINIMAP_EDGE = 180;

export function displayKey(id: string): string {
  return DISPLAY_KEY + id;
}

/** Initial display: server auto-contrast, the file's channel colors, everything visible. */
export function defaultDisplay(info: SlideInfo): ChannelDisplay[] {
  return info.channels.map((ch, i) => {
    const auto = info.autoscale[i];
    return {
      visible: true,
      color: ch.color ?? [255, 255, 255],
      min: auto?.min ?? 0,
      max: auto?.max ?? ch.suggested_max ?? 255,
      gamma: 1,
    };
  });
}

/** The display last used for this slide (shared by the workspace and the slide viewer). */
export function loadDisplay(info: SlideInfo): ChannelDisplay[] {
  try {
    const saved = JSON.parse(readPref(displayKey(info.id)) ?? "null") as ChannelDisplay[] | null;
    if (Array.isArray(saved) && saved.length === info.channels.length) return saved;
  } catch {
    // fall back to the defaults
  }
  return defaultDisplay(info);
}

let gpuProbe: boolean | null = null;

/** WebGL2 backed by real graphics hardware (software renderers such as SwiftShader don't count). */
export function hasGpu(): boolean {
  if (gpuProbe !== null) return gpuProbe;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return (gpuProbe = false);
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gpuProbe = !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    gpuProbe = false;
  }
  return gpuProbe;
}

/** The render mode for this browser: the administrator's setting, "auto" = GPU if present. */
export function useRenderMode(): RenderMode | null {
  const [mode, setMode] = useState<RenderMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    void clientSettings()
      .then((s) => s.render_mode)
      .catch(() => "auto" as const)
      .then((setting) => {
        if (cancelled) return;
        setMode(setting === "server" ? "server" : setting === "browser" ? "browser" : hasGpu() ? "browser" : "server");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return mode;
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, label, [data-no-pan]"));
}

/**
 * The tiled slide canvas with pan / zoom (mouse, wheel, trackpad, touch, keyboard), an overview
 * map and optional rectangle selection. Overlays (toolbars, channel chips) go in `children`.
 */
export function SlideStage({
  info,
  display,
  plane,
  scaleBar = true,
  tool = "pan",
  selection = null,
  onSelection,
  onViewer,
  onView,
  onCursor,
  minimap = true,
  children,
}: {
  info: SlideInfo;
  display: ChannelDisplay[];
  plane?: { t: number; z: number };
  scaleBar?: boolean;
  tool?: SlideTool;
  selection?: Rect | null;
  /** `done` is true when the drag ends. */
  onSelection?: (rect: Rect | null, done: boolean) => void;
  onViewer?: (viewer: SlideViewer | null) => void;
  onView?: (state: ViewState) => void;
  onCursor?: (cursor: SlideCursor | null) => void;
  minimap?: boolean;
  children?: ReactNode;
}) {
  const lang = useApp((s) => s.lang);
  const mode = useRenderMode();
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<SlideViewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const callbacks = useRef({ onSelection, onViewer, onView, onCursor });
  callbacks.current = { onSelection, onViewer, onView, onCursor };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !mode) return;
    const engine = new SlideViewer(host, info, display, { mode });
    engine.onError = (err) => setError(detailMessage(err, useApp.getState().lang));
    setViewer(engine);
    setError(null);
    callbacks.current.onViewer?.(engine);
    const unsubscribe = engine.subscribe((state) => callbacks.current.onView?.(state));
    return () => {
      unsubscribe();
      engine.destroy();
      callbacks.current.onViewer?.(null);
      setViewer(null);
    };
    // A new engine only for a new slide (or render mode); display/plane changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, mode]);

  useEffect(() => {
    viewer?.setDisplay(display);
  }, [display, viewer]);

  useEffect(() => {
    if (plane) viewer?.setPlane(plane.t, plane.z);
  }, [plane, viewer]);

  useEffect(() => {
    if (!viewer) return;
    viewer.scaleBar = scaleBar;
    viewer.selection = selection;
    viewer.render();
  }, [scaleBar, selection, viewer]);

  // --- input -----------------------------------------------------------------------

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "pan"; x: number; y: number }
    | { kind: "select"; x0: number; y0: number; rect: Rect | null }
    | { kind: "pinch"; dist: number; mx: number; my: number }
    | null
  >(null);
  const cursorFrame = useRef(0);

  function local(event: { clientX: number; clientY: number }) {
    const box = stageRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !viewer) return;
    const onWheel = (event: WheelEvent) => {
      if (isControl(event.target)) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const speed = event.ctrlKey ? 0.012 : 0.002;
      const box = stage.getBoundingClientRect();
      viewer.zoomBy(Math.exp(-event.deltaY * unit * speed), { x: event.clientX - box.left, y: event.clientY - box.top }, false);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [viewer]);

  useEffect(() => () => cancelAnimationFrame(cursorFrame.current), []);

  function reportCursor(p: { x: number; y: number }) {
    const report = callbacks.current.onCursor;
    if (!viewer || !report || cursorFrame.current) return;
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = 0;
      const img = viewer.screenToImage(p.x, p.y);
      const probe = viewer.probe(img.x, img.y);
      report(probe ? { x: img.x, y: img.y, level: probe.level, values: probe.values } : null);
    });
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!viewer || event.button > 0 || isControl(event.target)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if ((tool === "select" || event.shiftKey) && callbacks.current.onSelection) {
      const img = viewer.screenToImage(p.x, p.y);
      gesture.current = { kind: "select", x0: img.x, y0: img.y, rect: null };
      callbacks.current.onSelection(null, false);
    } else {
      gesture.current = { kind: "pan", x: p.x, y: p.y };
      setPanning(true);
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!viewer) return;
    const p = local(event);
    const g = gesture.current;
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, p);
    if (!g) {
      reportCursor(p);
      return;
    }
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      viewer.panBy(mx - g.mx, my - g.my);
      if (g.dist > 0) viewer.zoomBy(dist / g.dist, { x: mx, y: my }, false);
      gesture.current = { kind: "pinch", dist, mx, my };
    } else if (g.kind === "pan") {
      viewer.panBy(p.x - g.x, p.y - g.y);
      gesture.current = { kind: "pan", x: p.x, y: p.y };
    } else if (g.kind === "select") {
      const img = viewer.screenToImage(p.x, p.y);
      const x = Math.max(0, Math.min(g.x0, img.x));
      const y = Math.max(0, Math.min(g.y0, img.y));
      const x1 = Math.min(info.width, Math.max(g.x0, img.x));
      const y1 = Math.min(info.height, Math.max(g.y0, img.y));
      g.rect = x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
      callbacks.current.onSelection?.(g.rect, false);
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (g?.kind === "select" && viewer) {
      // A click (or a tiny drag) clears the region instead of leaving a speck.
      const scale = viewer.state().scale;
      const rect = g.rect && g.rect.w * scale > 4 && g.rect.h * scale > 4 ? g.rect : null;
      callbacks.current.onSelection?.(rect, true);
    }
    if (pointers.current.size === 0) {
      gesture.current = null;
      setPanning(false);
    } else if (pointers.current.size === 1) {
      const [only] = [...pointers.current.values()];
      gesture.current = { kind: "pan", x: only.x, y: only.y };
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!viewer || isControl(event.target)) return;
    const step = 80;
    const actions: Record<string, () => void> = {
      "+": () => viewer.zoomBy(1.6),
      "=": () => viewer.zoomBy(1.6),
      "-": () => viewer.zoomBy(1 / 1.6),
      "0": () => viewer.fit(),
      "1": () => viewer.zoomTo(1),
      ArrowLeft: () => viewer.panBy(step, 0),
      ArrowRight: () => viewer.panBy(-step, 0),
      ArrowUp: () => viewer.panBy(0, step),
      ArrowDown: () => viewer.panBy(0, -step),
      Escape: () => callbacks.current.onSelection?.(null, true),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  }

  return (
    <div
      ref={stageRef}
      tabIndex={0}
      role="application"
      aria-label={t(lang, "slideShortcuts")}
      className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-[#050607] outline-none ${
        tool === "select" ? "cursor-crosshair" : panning ? "cursor-grabbing" : "cursor-grab"
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => callbacks.current.onCursor?.(null)}
      onDoubleClick={(event) => {
        if (!isControl(event.target)) viewer?.zoomBy(event.shiftKey ? 0.5 : 2, local(event));
      }}
      onKeyDown={onKeyDown}
    >
      <div ref={hostRef} className="absolute inset-0" />
      {viewer && minimap && <Minimap viewer={viewer} info={info} display={display} />}
      {error && (
        <p role="alert" className="absolute bottom-14 left-3 z-20 max-w-[calc(100%-1.5rem)] rounded-lg border border-red-300/15 bg-black/70 px-3 py-2 text-[12px] leading-5 text-red-100 backdrop-blur-md">
          {error}
        </p>
      )}
      {children}
    </div>
  );
}

/** Spinner shown while the slide description loads (the server may build overview levels). */
export function SlideLoading({ preparing = true }: { preparing?: boolean }) {
  const lang = useApp((s) => s.lang);
  const reduce = useReducedMotion();
  return (
    <div role="status" className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-[#050607] px-8 text-center">
      <motion.span
        animate={reduce ? undefined : { rotate: 360 }}
        transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
        className="h-5 w-5 rounded-full border border-white/25 border-t-[var(--accent)]"
      />
      <p className="font-mono text-[11px] text-white/65">{t(lang, "slideOpening")}</p>
      {preparing && <p className="max-w-[42ch] text-[12px] leading-5 text-white/40">{t(lang, "slidePreparing")}</p>}
    </div>
  );
}

/** Fit / 1:1 / zoom out / zoom level / zoom in. */
export function SlideZoomControls({ viewer, view, dark = true }: { viewer: SlideViewer | null; view: ViewState | null; dark?: boolean }) {
  const lang = useApp((s) => s.lang);
  const percent = view ? view.scale * 100 : 100;
  const button = `flex h-7 items-center justify-center rounded-lg px-2 transition-colors disabled:opacity-35 ${
    dark ? "text-white/65 hover:bg-white/10 hover:text-white" : "text-[var(--text-dim)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
  }`;
  return (
    <>
      <button type="button" className={button} onClick={() => viewer?.fit()} aria-label={t(lang, "fit")} title={`${t(lang, "fit")} (0)`}>
        <CornersOut size={15} />
      </button>
      <button type="button" className={`${button} text-[11px]`} onClick={() => viewer?.zoomTo(1)} title={`${t(lang, "oneToOne")} (1)`}>
        {t(lang, "oneToOne")}
      </button>
      <button
        type="button"
        className={`${button} w-7 px-0`}
        onClick={() => viewer?.zoomBy(1 / 1.6)}
        aria-label={t(lang, "zoomOut")}
        disabled={!viewer || (view?.scale ?? 1) <= viewer.minScale * 1.001}
      >
        <MagnifyingGlassMinus size={15} />
      </button>
      <span className={`min-w-12 text-center font-mono text-[11px] tabular-nums ${dark ? "text-white/75" : ""}`} title={t(lang, "zoomLevel")}>
        {percent >= 10 ? Math.round(percent) : percent >= 1 ? percent.toFixed(1) : percent.toFixed(2)}%
      </span>
      <button
        type="button"
        className={`${button} w-7 px-0`}
        onClick={() => viewer?.zoomBy(1.6)}
        aria-label={t(lang, "zoomIn")}
        disabled={!viewer || (view?.scale ?? 1) >= MAX_SCALE * 0.999}
      >
        <MagnifyingGlassPlus size={15} />
      </button>
    </>
  );
}

function Minimap({ viewer, info, display }: { viewer: SlideViewer; info: SlideInfo; display: ChannelDisplay[] }) {
  const lang = useApp((s) => s.lang);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const aspect = info.width / info.height;
  const w = aspect >= 1 ? MINIMAP_EDGE : Math.round(MINIMAP_EDGE * aspect);
  const h = aspect >= 1 ? Math.round(MINIMAP_EDGE / aspect) : MINIMAP_EDGE;
  const [ready, setReady] = useState(false);

  // Redraw the thumbnail when the channel display changes (debounced: sliders fire often).
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      void viewer
        .thumbnail(MINIMAP_EDGE * dpr)
        .then((thumb) => {
          const canvas = canvasRef.current;
          if (cancelled || !canvas) return;
          canvas.width = thumb.width;
          canvas.height = thumb.height;
          canvas.getContext("2d")?.drawImage(thumb, 0, 0);
          setReady(true);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [viewer, display]);

  // The viewport box follows the view directly (no React render per frame).
  useEffect(
    () =>
      viewer.subscribe((state) => {
        const box = boxRef.current;
        if (!box) return;
        const k = w / info.width;
        const r = state.rect;
        const left = Math.max(0, r.x * k);
        const top = Math.max(0, r.y * k);
        const right = Math.min(w, (r.x + r.w) * k);
        const bottom = Math.min(h, (r.y + r.h) * k);
        const zoomedIn = r.w < info.width * 0.98 || r.h < info.height * 0.98;
        box.style.display = zoomedIn ? "block" : "none";
        box.style.transform = `translate(${left}px, ${top}px)`;
        box.style.width = `${Math.max(3, right - left)}px`;
        box.style.height = `${Math.max(3, bottom - top)}px`;
      }),
    [viewer, info, w, h],
  );

  function jump(event: React.PointerEvent<HTMLDivElement>, animate: boolean) {
    const rect = event.currentTarget.getBoundingClientRect();
    viewer.centerOn(((event.clientX - rect.left) / w) * info.width, ((event.clientY - rect.top) / h) * info.height, animate);
  }

  return (
    <div
      data-no-pan
      className="absolute right-3 top-14 z-10 overflow-hidden rounded-lg border border-white/12 bg-black/70 shadow-lg"
      style={{ width: w, height: h }}
      title={t(lang, "minimap")}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        jump(event, true);
      }}
      onPointerMove={(event) => {
        if (event.buttons & 1) jump(event, false);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <canvas ref={canvasRef} className={`h-full w-full transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`} />
      <span ref={boxRef} className="pointer-events-none absolute left-0 top-0 hidden border border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" />
    </div>
  );
}
