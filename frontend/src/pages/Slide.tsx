import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Camera,
  CornersOut,
  Hand,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Selection,
  X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { SlideChannels } from "../components/SlideChannels";
import { SlideExport } from "../components/SlideExport";
import { t } from "../i18n";
import { slideInfo } from "../lib/api";
import { detailMessage, formatBytes, formatUm, isSlide } from "../lib/format";
import { MAX_SCALE, SlideViewer, type ChannelDisplay, type Rect, type ViewState } from "../lib/slide";
import { readPref, writePref } from "../lib/storage";
import type { SlideInfo } from "../lib/types";
import { useApp } from "../store";

type Tool = "pan" | "select";
type Tab = "info" | "export";

const DISPLAY_KEY = "nd2utils.slide.display.";
const MINIMAP_EDGE = 200;

function defaultDisplay(info: SlideInfo): ChannelDisplay[] {
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

function loadDisplay(info: SlideInfo): ChannelDisplay[] {
  try {
    const saved = JSON.parse(readPref(DISPLAY_KEY + info.id) ?? "null") as ChannelDisplay[] | null;
    if (Array.isArray(saved) && saved.length === info.channels.length) return saved;
  } catch {
    // fall through to the defaults
  }
  return defaultDisplay(info);
}

function downloadCanvas(canvas: HTMLCanvasElement, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("encode"));
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      resolve();
    }, "image/png");
  });
}

function stem(name: string): string {
  return name.replace(/(\.ome)?\.tiff?$/i, "");
}

export function Slide() {
  const { fileId = "" } = useParams();
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const select = useApp((s) => s.select);
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const file = files.find((f) => f.id === fileId) ?? null;

  const [info, setInfo] = useState<SlideInfo | null>(null);
  const [display, setDisplay] = useState<ChannelDisplay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [tool, setTool] = useState<Tool>("pan");
  const [selection, setSelection] = useState<Rect | null>(null);
  const [plane, setPlane] = useState({ t: 0, z: 0 });
  const [scaleBar, setScaleBar] = useState(true);
  const [tab, setTab] = useState<Tab>("info");
  const [cursor, setCursor] = useState<{ x: number; y: number; values: (number | null)[]; level: number } | null>(null);
  const [snapOpen, setSnapOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SlideViewer | null>(null);
  const [viewer, setViewer] = useState<SlideViewer | null>(null);

  useEffect(() => {
    void refreshFiles().catch(() => undefined);
  }, [refreshFiles]);

  useEffect(() => {
    if (fileId) select(fileId);
  }, [fileId, select]);

  // Load the slide description (the server builds missing pyramid levels first).
  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    setInfo(null);
    setError(null);
    setSelection(null);
    setPlane({ t: 0, z: 0 });
    void slideInfo(fileId)
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setDisplay(loadDisplay(next));
      })
      .catch((err) => {
        if (!cancelled) setError(detailMessage(err, lang));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, lang]);

  // One engine per opened slide.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!info || !canvas) return;
    const engine = new SlideViewer(canvas, info, loadDisplay(info));
    engine.onError = (err) => setError(detailMessage(err, lang));
    viewerRef.current = engine;
    setViewer(engine);
    let frame = 0;
    let latest: ViewState | null = null;
    const unsubscribe = engine.subscribe((state) => {
      latest = state;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setView(latest);
        });
      }
    });
    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
      engine.destroy();
      viewerRef.current = null;
      setViewer(null);
    };
    // lang only affects error text; recreating the engine for it would drop the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  useEffect(() => {
    if (!viewer || !info || display.length !== info.channels.length) return;
    viewer.setDisplay(display);
    writePref(DISPLAY_KEY + info.id, JSON.stringify(display));
  }, [display, info, viewer]);

  useEffect(() => {
    viewer?.setPlane(plane.t, plane.z);
  }, [plane, viewer]);

  useEffect(() => {
    if (!viewer) return;
    viewer.scaleBar = scaleBar;
    viewer.selection = selection;
    viewer.render();
  }, [scaleBar, selection, viewer]);

  // --- pointer, wheel, keyboard ---------------------------------------------------

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "pan"; x: number; y: number }
    | { kind: "select"; x0: number; y0: number }
    | { kind: "pinch"; dist: number; mx: number; my: number }
    | null
  >(null);

  const local = useCallback((event: { clientX: number; clientY: number }) => {
    const box = stageRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !viewer) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const speed = event.ctrlKey ? 0.01 : 0.0018;
      const factor = Math.exp(-event.deltaY * unit * speed);
      viewer.zoomBy(factor, local(event), false);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [local, viewer]);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!viewer || event.button > 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (tool === "select" || event.shiftKey) {
      const img = viewer.screenToImage(p.x, p.y);
      gesture.current = { kind: "select", x0: img.x, y0: img.y };
      setSelection(null);
    } else {
      gesture.current = { kind: "pan", x: p.x, y: p.y };
    }
  }

  function updateCursor(p: { x: number; y: number }) {
    if (!viewer) return;
    const img = viewer.screenToImage(p.x, p.y);
    const probe = viewer.probe(img.x, img.y);
    setCursor(probe ? { x: img.x, y: img.y, values: probe.values, level: probe.level } : null);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!viewer) return;
    const p = local(event);
    const g = gesture.current;
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, p);
    if (!g) {
      updateCursor(p);
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
      const x1 = Math.min(viewer.info.width, Math.max(g.x0, img.x));
      const y1 = Math.min(viewer.info.height, Math.max(g.y0, img.y));
      setSelection(x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null);
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (g?.kind === "select" && viewer) {
      // A click (or a tiny drag) clears the region instead of leaving a speck.
      const scale = viewer.state().scale;
      setSelection((sel) => (sel && sel.w * scale > 4 && sel.h * scale > 4 ? sel : null));
      setTab("export");
    }
    if (pointers.current.size === 0) gesture.current = null;
    else if (pointers.current.size === 1) {
      const [only] = [...pointers.current.values()];
      gesture.current = { kind: "pan", x: only.x, y: only.y };
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!viewer) return;
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
      Escape: () => setSelection(null),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  }

  // --- derived ------------------------------------------------------------------------

  const zoomPercent = view ? view.scale * 100 : 100;
  const mag = info?.magnification && view ? info.magnification * view.scale : null;
  const names = useMemo(() => info?.channels.map((c) => c.name) ?? [], [info]);

  if (file && !isSlide(file)) {
    return (
      <Shell dense>
        <div className="p-10 text-[13px] text-[var(--text-dim)]">{t(lang, "slideNotSlide")}</div>
      </Shell>
    );
  }

  const toolButton = (active: boolean) =>
    `flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] transition-all duration-200 ${active ? "bg-white text-black shadow-sm" : "text-white/65 hover:bg-white/10 hover:text-white"}`;
  const iconButton =
    "flex h-8 w-8 items-center justify-center rounded-lg text-white/65 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-35";

  return (
    <Shell dense>
      <div className="grid min-h-[calc(100dvh-4rem)] grid-cols-1 lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:grid-cols-[288px_minmax(0,1fr)_320px]">
        {/* Channels */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-b lg:border-b-0">
          <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2.5">
            <button
              type="button"
              onClick={() => nav("/workspace")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
              aria-label={t(lang, "slideBack")}
              title={t(lang, "slideBack")}
            >
              <ArrowLeft size={15} />
            </button>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={file?.name}>
              {file?.name ?? t(lang, "slideViewer")}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3 max-lg:max-h-[55dvh]">
            <p className="mb-2 text-[12px] font-medium">{t(lang, "channels")}</p>
            {info && display.length === info.channels.length && (
              <SlideChannels
                info={info}
                display={display}
                onChange={setDisplay}
                onAuto={() =>
                  setDisplay((prev) => {
                    const auto = defaultDisplay(info);
                    return prev.map((d, i) => ({ ...d, min: auto[i].min, max: auto[i].max, gamma: 1 }));
                  })
                }
              />
            )}
            {info && (info.sizes.T > 1 || info.sizes.Z > 1) && (
              <div className="mt-4 grid gap-2 rounded-xl bg-[var(--bg)] p-3 text-[11.5px]">
                <span className="font-medium">{t(lang, "plane")}</span>
                {(["T", "Z"] as const).map((axis) =>
                  info.sizes[axis] > 1 ? (
                    <label key={axis} className="grid grid-cols-[1.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 font-mono">
                      {axis}
                      <input
                        type="range"
                        min={0}
                        max={info.sizes[axis] - 1}
                        value={axis === "T" ? plane.t : plane.z}
                        onChange={(event) =>
                          setPlane((p) => ({ ...p, [axis === "T" ? "t" : "z"]: Number(event.target.value) }))
                        }
                      />
                      <span className="text-right tabular-nums">
                        {(axis === "T" ? plane.t : plane.z) + 1}/{info.sizes[axis]}
                      </span>
                    </label>
                  ) : null,
                )}
              </div>
            )}
          </div>
        </Glass>

        {/* Viewer */}
        <main className="relative flex min-h-[460px] flex-col bg-[var(--well)]">
          <Glass tone="dark" shape="chip" className="absolute left-2 right-2 top-2 z-20 flex flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap p-1">
            <button type="button" className={toolButton(tool === "pan")} aria-pressed={tool === "pan"} onClick={() => setTool("pan")}>
              <Hand size={14} /> {t(lang, "toolPan")}
            </button>
            <button type="button" className={toolButton(tool === "select")} aria-pressed={tool === "select"} onClick={() => setTool("select")}>
              <Selection size={14} /> {t(lang, "toolSelect")}
            </button>
            <span className="mx-1 h-4 w-px shrink-0 bg-white/10" aria-hidden />
            <button type="button" className={iconButton} onClick={() => viewer?.fit()} aria-label={t(lang, "fit")} title={`${t(lang, "fit")} (0)`}>
              <CornersOut size={15} />
            </button>
            <button type="button" className={toolButton(false)} onClick={() => viewer?.zoomTo(1)} title={`${t(lang, "oneToOne")} (1)`}>
              {t(lang, "oneToOne")}
            </button>
            <button type="button" className={iconButton} onClick={() => viewer?.zoomBy(1 / 1.6)} aria-label={t(lang, "zoomOut")} disabled={!viewer || (view?.scale ?? 1) <= viewer.minScale * 1.001}>
              <MagnifyingGlassMinus size={15} />
            </button>
            <span className="min-w-14 text-center font-mono text-[11px] tabular-nums text-white/75" title={t(lang, "zoomLevel")}>
              {zoomPercent >= 10 ? Math.round(zoomPercent) : zoomPercent.toFixed(1)}%
            </span>
            <button type="button" className={iconButton} onClick={() => viewer?.zoomBy(1.6)} aria-label={t(lang, "zoomIn")} disabled={!viewer || (view?.scale ?? 1) >= MAX_SCALE * 0.999}>
              <MagnifyingGlassPlus size={15} />
            </button>
            {mag !== null && (
              <span className="ml-1 rounded-md bg-white/8 px-2 py-1 font-mono text-[10.5px] tabular-nums text-white/70" title={t(lang, "equivalentMag")}>
                ≈ {mag >= 10 ? mag.toFixed(0) : mag.toFixed(1)}×
              </span>
            )}
            <span className="mx-1 h-4 w-px shrink-0 bg-white/10" aria-hidden />
            <button type="button" className={toolButton(scaleBar)} aria-pressed={scaleBar} onClick={() => setScaleBar((v) => !v)}>
              {t(lang, "scaleBar")}
            </button>
            <button type="button" className={`${toolButton(snapOpen)} ml-auto`} aria-expanded={snapOpen} onClick={() => setSnapOpen((v) => !v)} disabled={!viewer}>
              <Camera size={14} /> {t(lang, "screenshot")}
            </button>
          </Glass>

          <div
            ref={stageRef}
            tabIndex={0}
            role="application"
            aria-label={file?.name ?? t(lang, "slideViewer")}
            className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden outline-none ${tool === "select" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setCursor(null)}
            onDoubleClick={(event) => viewer?.zoomBy(event.shiftKey ? 0.5 : 2, local(event))}
            onKeyDown={onKeyDown}
          >
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

            {!info && !error && (
              <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
                <motion.span
                  animate={reduce ? undefined : { rotate: 360 }}
                  transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
                  className="h-5 w-5 rounded-full border border-white/25 border-t-[var(--accent)]"
                />
                <p className="font-mono text-[11px] text-white/65">{t(lang, "slideOpening")}</p>
                <p className="max-w-[42ch] text-[12px] leading-5 text-white/40">{t(lang, "slidePreparing")}</p>
              </div>
            )}
            {error && (
              <p role="alert" className="absolute bottom-14 left-3 z-20 max-w-[calc(100%-1.5rem)] rounded-lg border border-red-300/15 bg-black/70 px-3 py-2 text-[12px] leading-5 text-red-100 backdrop-blur-md">
                {error}
              </p>
            )}

            {viewer && info && view && !snapOpen && <Minimap viewer={viewer} info={info} view={view} display={display} />}

            {selection && (
              <Glass tone="dark" shape="chip" className="absolute bottom-14 right-3 z-20 flex items-center gap-1 p-1" >
                <span className="px-2 font-mono text-[10.5px] tabular-nums text-white/70">
                  {Math.round(selection.w)} × {Math.round(selection.h)} px
                  {info?.um_per_px ? ` · ${formatUm(selection.w * info.um_per_px)} × ${formatUm(selection.h * info.um_per_px)}` : ""}
                </span>
                <button type="button" className={toolButton(false)} onClick={() => viewer?.showRect(selection)}>
                  {t(lang, "zoomToRegion")}
                </button>
                <button type="button" className={iconButton} onClick={() => setSelection(null)} aria-label={t(lang, "clearRegion")} title={t(lang, "clearRegion")}>
                  <X size={14} />
                </button>
              </Glass>
            )}

            <AnimatePresence>
              {snapOpen && viewer && info && (
                <SnapshotPopover
                  viewer={viewer}
                  names={names}
                  fileName={file?.name ?? "slide"}
                  scaleBar={scaleBar}
                  onClose={() => setSnapOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>

          <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.06] bg-black/30 px-3 py-1.5 font-mono text-[10.5px] tabular-nums text-white/55">
            {cursor && info ? (
              <>
                <span>
                  x {Math.floor(cursor.x)} · y {Math.floor(cursor.y)}
                  {info.um_per_px ? `  (${(cursor.x * info.um_per_px).toFixed(1)}, ${(cursor.y * info.um_per_px).toFixed(1)} µm)` : ""}
                </span>
                <span className="flex flex-wrap gap-x-2.5" title={t(lang, "cursorValue")}>
                  {cursor.values.map((v, i) =>
                    display[i]?.visible && v !== null ? (
                      <span key={i} style={{ color: `rgb(${display[i].color.join(" ")})` }}>
                        {info.channels[i]?.name}: {Number.isInteger(v) ? v : v.toPrecision(4)}
                      </span>
                    ) : null,
                  )}
                </span>
              </>
            ) : (
              <span className="text-white/40">{t(lang, "slideShortcuts")}</span>
            )}
            {view && info && (
              <span className="ml-auto">
                L{view.level}/{info.levels.length - 1}
                {view.loading > 0 ? " · …" : ""}
              </span>
            )}
          </div>
        </main>

        {/* Info / export */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-t lg:border-l lg:border-t-0">
          <div className="flex gap-1 border-b border-[var(--line)] p-2 text-[12px]" role="tablist">
            {(["info", "export"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`relative flex-1 rounded-lg px-2 py-2 transition-colors ${tab === key ? "text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
              >
                {tab === key && (
                  <motion.span layoutId="slide-tab" className="absolute inset-0 rounded-lg bg-[var(--text)]" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
                )}
                <span className="relative z-[1]">{t(lang, key === "info" ? "slideTabInfo" : "slideTabExport")}</span>
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {info && tab === "info" && (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[12.5px]">
                <dt className="text-[var(--text-dim)]">{t(lang, "format")}</dt>
                <dd className="font-mono">{file?.format === "tiff" ? "TIFF" : "OME-TIFF"}</dd>
                <dt className="text-[var(--text-dim)]">{t(lang, "dimensions")}</dt>
                <dd className="font-mono tabular-nums">
                  {info.width} × {info.height} px
                </dd>
                {info.um_per_px ? (
                  <>
                    <dt className="text-[var(--text-dim)]">{t(lang, "pixelSize")}</dt>
                    <dd className="font-mono tabular-nums">
                      {formatUm(info.um_per_px)}/px
                      <span className="block text-[11px] text-[var(--text-dim)]">
                        {formatUm(info.width * info.um_per_px)} × {formatUm(info.height * info.um_per_px)}
                      </span>
                    </dd>
                  </>
                ) : null}
                <dt className="text-[var(--text-dim)]">{t(lang, "dtype")}</dt>
                <dd className="font-mono">{info.dtype}</dd>
                <dt className="text-[var(--text-dim)]">{t(lang, "channels")}</dt>
                <dd className="font-mono tabular-nums">{info.channels.length}</dd>
                {(file?.objective || info.magnification) && (
                  <>
                    <dt className="text-[var(--text-dim)]">{t(lang, "objective")}</dt>
                    <dd>
                      {file?.objective ?? ""}
                      {info.magnification ? ` ${info.magnification}×` : ""}
                      {file?.na ? ` · NA ${file.na}` : ""}
                    </dd>
                  </>
                )}
                {file && (
                  <>
                    <dt className="text-[var(--text-dim)]">{t(lang, "fileSize")}</dt>
                    <dd className="font-mono tabular-nums">{formatBytes(file.size_bytes, lang)}</dd>
                  </>
                )}
                {file?.software && (
                  <>
                    <dt className="text-[var(--text-dim)]">{t(lang, "software")}</dt>
                    <dd className="break-words">{file.software}</dd>
                  </>
                )}
                <dt className="text-[var(--text-dim)]">{t(lang, "pyramidLevels")}</dt>
                <dd>
                  <ol className="grid gap-0.5 font-mono text-[11px] tabular-nums">
                    {info.levels.map((lv, i) => (
                      <li key={i} className={view?.level === i ? "text-[var(--accent)]" : ""}>
                        L{i} · {lv.width}×{lv.height}
                        {lv.virtual ? <span className="text-[var(--text-dim)]"> · {t(lang, "virtualLevel")}</span> : null}
                      </li>
                    ))}
                  </ol>
                </dd>
              </dl>
            )}
            {info && tab === "export" && (
              <SlideExport info={info} display={display} view={view?.rect ?? null} selection={selection} plane={plane} />
            )}
          </div>
        </Glass>
      </div>
    </Shell>
  );
}

function Minimap({
  viewer,
  info,
  view,
  display,
}: {
  viewer: SlideViewer;
  info: SlideInfo;
  view: ViewState;
  display: ChannelDisplay[];
}) {
  const lang = useApp((s) => s.lang);
  const ref = useRef<HTMLCanvasElement>(null);
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
          const canvas = ref.current;
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

  const k = w / info.width;
  const r = view.rect;
  const box = {
    left: Math.max(0, r.x * k),
    top: Math.max(0, r.y * k),
    right: Math.min(w, (r.x + r.w) * k),
    bottom: Math.min(h, (r.y + r.h) * k),
  };
  const zoomedIn = r.w < info.width * 0.98 || r.h < info.height * 0.98;

  function jump(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    viewer.centerOn(((event.clientX - rect.left) / w) * info.width, ((event.clientY - rect.top) / h) * info.height, event.type === "pointerdown");
  }

  return (
    <div
      data-no-pan
      className="absolute right-3 top-14 z-10 overflow-hidden rounded-lg border border-white/12 bg-black/70 shadow-lg backdrop-blur-md"
      style={{ width: w, height: h }}
      aria-label={t(lang, "minimap")}
      title={t(lang, "minimap")}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        jump(event);
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
        if (event.buttons & 1) jump(event);
      }}
      onPointerUp={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <canvas ref={ref} className={`h-full w-full transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`} />
      {zoomedIn && (
        <span
          className="pointer-events-none absolute border border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]"
          style={{
            left: box.left,
            top: box.top,
            width: Math.max(3, box.right - box.left),
            height: Math.max(3, box.bottom - box.top),
          }}
        />
      )}
    </div>
  );
}

function SnapshotPopover({
  viewer,
  names,
  fileName,
  scaleBar: initialScaleBar,
  onClose,
}: {
  viewer: SlideViewer;
  names: string[];
  fileName: string;
  scaleBar: boolean;
  onClose: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const reduce = useReducedMotion();
  const [k, setK] = useState(2);
  const [scaleBar, setScaleBar] = useState(initialScaleBar);
  const [legend, setLegend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canCopy = typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);

  async function render() {
    return viewer.capture({ k, scaleBar, legend, names });
  }

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const canvas = await render();
      const r = viewer.viewRect();
      await downloadCanvas(canvas, `${stem(fileName)}_view_x${Math.max(0, Math.round(r.x))}-y${Math.max(0, Math.round(r.y))}.png`);
    } catch (err) {
      setNote(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setBusy(true);
    setNote(null);
    try {
      // Safari needs the ClipboardItem created synchronously with a promise for the blob.
      const blob = render().then(
        (canvas) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/png")),
      );
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setNote(t(lang, "copiedImage"));
    } catch (err) {
      setNote(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      data-no-pan
      initial={reduce ? false : { opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, y: -4 }}
      transition={{ duration: 0.16 }}
      className="absolute right-3 top-14 z-30 w-72"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Glass shape="island" className="p-4 text-[12px]">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium">{t(lang, "screenshot")}</span>
          <button type="button" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] hover:bg-[var(--bg)]" aria-label={t(lang, "close")}>
            <X size={13} />
          </button>
        </div>
        <p className="mb-3 leading-5 text-[var(--text-dim)]">{t(lang, "screenshotHint")}</p>
        <div className="mb-3 grid gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-dim)]">{t(lang, "screenshotScale")}</span>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--bg)] p-1">
            {[1, 2, 4].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setK(value)}
                aria-pressed={k === value}
                className={`rounded-lg py-1.5 font-mono text-[11px] transition-colors ${k === value ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
              >
                {value}×
              </button>
            ))}
          </div>
        </div>
        <label className="mb-1.5 flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={scaleBar} onChange={(event) => setScaleBar(event.target.checked)} />
          {t(lang, "scaleBar")}
        </label>
        <label className="mb-3 flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={legend} onChange={(event) => setLegend(event.target.checked)} />
          {t(lang, "screenshotLegend")}
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-50"
          >
            {busy ? t(lang, "rendering") : t(lang, "savePng")}
          </button>
          {canCopy && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void copy()}
              className="inline-flex h-9 items-center rounded-xl px-3 text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
            >
              {t(lang, "copyImage")}
            </button>
          )}
        </div>
        {note && <p className="mt-2 text-[11.5px] leading-5 text-[var(--text-dim)]" aria-live="polite">{note}</p>}
      </Glass>
    </motion.div>
  );
}
