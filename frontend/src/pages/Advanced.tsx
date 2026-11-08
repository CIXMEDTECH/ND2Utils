import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Crosshair,
  LineSegment,
  LockSimple,
  LockSimpleOpen,
  Rectangle,
  Circle,
  Polygon,
  Play,
  Pause,
} from "@phosphor-icons/react";
import { Shell } from "../components/Shell";
import { ExportPanel } from "../components/ExportPanel";
import { Glass } from "../components/Glass";
import { Guide } from "../components/Guide";
import { t } from "../i18n";
import { autoscale, fetchPlane, measure, projectionUrl } from "../lib/api";
import { axisSize, detailMessage, formatUm, isSlide, rgbCss } from "../lib/format";
import { histogram, histogramPath, renderComposite, unpackPlane } from "../lib/plane";
import type { LutSetting, MeasureResult, PackedPlane, Tool } from "../lib/types";
import { readPref, writePref } from "../lib/storage";
import { useApp } from "../store";

const TOUR_KEY = "nd2utils.tour.v1";

/** Line-profile values as SVG polyline points in a 200 x 48 box. */
function profilePoints(values: number[]): string {
  let peak = 1;
  for (const v of values) if (v > peak) peak = v;
  const last = values.length - 1;
  return values.map((v, i) => `${((i / last) * 200).toFixed(1)},${(48 - (v / peak) * 48).toFixed(1)}`).join(" ");
}

export function Advanced() {
  const { fileId } = useParams();
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const selectedId = useApp((s) => s.selectedId);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const select = useApp((s) => s.select);
  const channelLocked = useApp((s) => s.channelLocked);
  const resolveVisibleChannels = useApp((s) => s.resolveVisibleChannels);
  const toggleChannelLock = useApp((s) => s.toggleChannelLock);
  const updateLockedChannels = useApp((s) => s.updateLockedChannels);
  const nav = useNavigate();
  const id = fileId || selectedId || files[0]?.id || null;

  const [tIdx, setT] = useState(0);
  const [zIdx, setZ] = useState(0);
  const [pIdx, setP] = useState(0);
  const [packed, setPacked] = useState<PackedPlane | null>(null);
  const [luts, setLuts] = useState<LutSetting[]>([]);
  /** Histogram range per channel: a bit beyond the auto-contrast white point of the plane. */
  const [histMax, setHistMax] = useState<number[]>([]);
  const [tool, setTool] = useState<Tool>("probe");
  const [points, setPoints] = useState<number[][]>([]);
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [probe, setProbe] = useState<{ x: number; y: number; vals: number[] } | null>(null);
  const [histLog, setHistLog] = useState(false);
  const [view, setView] = useState<"overlay" | "mip">("overlay");
  const [projSrc, setProjSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [tour, setTour] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgDataRef = useRef<ImageData | null>(null);

  const file = files.find((f) => f.id === id) ?? null;
  const nT = file ? axisSize(file.axes, "T") : 1;
  const nZ = file ? axisSize(file.axes, "Z") : 1;
  const nP = file ? axisSize(file.axes, "P") : 1;

  useEffect(() => {
    void refreshFiles();
    if (!readPref(TOUR_KEY)) setTour(0);
  }, [refreshFiles]);

  useEffect(() => {
    if (fileId) select(fileId);
  }, [fileId, select]);

  // OME-TIFF slides are far too large for whole-plane tools: they open in the slide viewer.
  useEffect(() => {
    if (file && isSlide(file)) nav(`/slide/${file.id}`, { replace: true });
  }, [file, nav]);

  // LUTs belong to one file: carrying them over to another file can render it (and its export) black.
  useEffect(() => {
    setLuts([]);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancel = false;
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const [buf, scaled] = await Promise.all([
          fetchPlane(id, tIdx, zIdx, pIdx),
          autoscale(id, tIdx, zIdx, pIdx),
        ]);
        if (cancel) return;
        const plane = unpackPlane(buf);
        setPacked(plane);
        setHistMax(plane.channels.map((ch, i) => Math.max(1, (scaled.channels[i]?.max ?? ch.suggestedMax) * 1.5)));
        const lockedVis = resolveVisibleChannels(
          plane.channels.map((ch, i) => ({ index: i, name: ch.name, color: ch.color })),
        );
        setLuts((prev) =>
          plane.channels.map((ch, i) => {
            const old = prev[i];
            const s = scaled.channels[i];
            return {
              min: old?.min ?? s?.min ?? ch.suggestedMin,
              max: old?.max ?? s?.max ?? ch.suggestedMax,
              gamma: old?.gamma ?? 1,
              visible: old?.visible ?? lockedVis[i] ?? true,
              color: old?.color ?? ch.color,
            };
          }),
        );
      } catch (e) {
        if (!cancel) setError(detailMessage(e, lang));
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [id, lang, resolveVisibleChannels, tIdx, zIdx, pIdx]);

  useEffect(() => {
    return () => {
      if (projSrc) URL.revokeObjectURL(projSrc);
    };
  }, [projSrc]);

  useEffect(() => {
    if (!packed || !canvasRef.current || view === "mip") return;
    const raf = window.requestAnimationFrame(() => {
      const cvs = canvasRef.current;
      if (!cvs) return;
      if (cvs.width !== packed.width || cvs.height !== packed.height) {
        cvs.width = packed.width;
        cvs.height = packed.height;
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      let img = imgDataRef.current;
      if (!img || img.width !== packed.width || img.height !== packed.height) {
        img = ctx.createImageData(packed.width, packed.height);
        imgDataRef.current = img;
      }
      renderComposite(packed, luts, img);
      ctx.putImageData(img, 0, 0);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [packed, luts, view]);

  useEffect(() => {
    if (!playing || nT <= 1) return;
    const h = window.setInterval(() => setT((v) => (v + 1) % nT), 250);
    return () => window.clearInterval(h);
  }, [playing, nT]);

  // Computed once per plane, not on every LUT change (that meant a pass over all pixels per slider step).
  const hist = useMemo(
    () => (packed ? packed.channels.map((ch, i) => histogram(ch.data, 96, histMax[i])) : []),
    [packed, histMax],
  );
  const histPaths = useMemo(() => hist.map((counts) => histogramPath(counts, 28, histLog)), [hist, histLog]);

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>): number[] {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * (packed?.width ?? 1);
    const y = ((e.clientY - r.top) / r.height) * (packed?.height ?? 1);
    return [x, y];
  }

  async function runMeasure(activeTool: Tool, next: number[][]) {
    if (!id) return;
    try {
      setError(null);
      setResult(await measure(id, { tool: activeTool, points: next, t: tIdx, z: zIdx, p: pIdx }));
    } catch (err) {
      setError(detailMessage(err, lang));
    }
  }

  async function onCanvasClick(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!packed || !id) return;
    const [x, y] = canvasPoint(e);
    const xi = Math.max(0, Math.min(packed.width - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(packed.height - 1, Math.round(y)));
    if (tool === "probe") {
      const vals = packed.channels.map((ch) => ch.data[yi * packed.width + xi]);
      setProbe({ x: xi, y: yi, vals });
      return;
    }
    if (tool === "line") {
      if (points.length === 0) setPoints([[x, y]]);
      else {
        const next = [points[0], [x, y]];
        setPoints(next);
        await runMeasure("line", next);
      }
      return;
    }
    if (tool === "rect" || tool === "ellipse") {
      if (points.length === 0) setPoints([[x, y]]);
      else {
        const next = [points[0], [x, y]];
        setPoints(next);
        await runMeasure(tool, next);
      }
      return;
    }
    if (tool === "polygon") {
      const next = [...points, [x, y]];
      setPoints(next);
      if (next.length >= 3 && e.detail === 2) {
        await runMeasure("polygon", next);
      }
    }
  }

  async function runMip(mode: "max" | "min") {
    if (!id) return;
    if (nZ <= 1 && nT <= 1) {
      setError(t(lang, "noProjection"));
      return;
    }
    const axis = nZ > 1 ? "Z" : "T";
    try {
      const url = await projectionUrl(id, axis, mode, tIdx, zIdx, pIdx);
      setProjSrc(url);
      setView("mip");
    } catch (e) {
      setError(detailMessage(e, lang));
    }
  }

  const tourCopy = [t(lang, "tour1"), t(lang, "tour2"), t(lang, "tour3"), t(lang, "tour4"), t(lang, "tour5")];

  if (!id) {
    return (
      <Shell dense>
        <div className="p-10 text-[13px] text-[var(--text-dim)]">{t(lang, "emptyFiles")}</div>
      </Shell>
    );
  }

  return (
    <Shell dense>
      <div className="flex min-h-[calc(100dvh-4rem)] flex-col">
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
          <Glass as="aside" shape="panel" className="overflow-auto border-b p-3 lg:border-b-0 lg:border-r" data-tour="lut">
            <div className="mb-2 flex items-center justify-between text-[12px] font-medium">
              <span>{t(lang, "lutTitle")}</span>
              <div className="flex items-center gap-1">
                {packed && packed.channels.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      toggleChannelLock(
                        packed.channels.map((ch, idx) => ({ index: idx, name: ch.name, color: ch.color })),
                        luts.map((x) => x.visible),
                      )
                    }
                    aria-pressed={channelLocked}
                    title={t(lang, "lockChannelsHint")}
                    className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
                      channelLocked
                        ? "bg-amber-400/20 text-amber-500 ring-1 ring-inset ring-amber-400/40"
                        : "text-[var(--text-dim)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
                    }`}
                  >
                    {channelLocked ? <LockSimple size={12} weight="fill" /> : <LockSimpleOpen size={12} />}
                    {t(lang, channelLocked ? "channelsLocked" : "lockChannels")}
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-lg px-2 py-1 text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
                  onClick={async () => {
                    if (!id) return;
                    try {
                      const scaled = await autoscale(id, tIdx, zIdx, pIdx);
                      setLuts((prev) =>
                        prev.map((lut, i) => ({
                          ...lut,
                          min: scaled.channels[i]?.min ?? lut.min,
                          max: scaled.channels[i]?.max ?? lut.max,
                        })),
                      );
                    } catch (err) {
                      setError(detailMessage(err, lang));
                    }
                  }}
                >
                  {t(lang, "auto")}
                </button>
              </div>
            </div>
            <Guide title="lutTitle" body="lutGuide" />
            <div className="mt-3 flex flex-col gap-3" data-tour="channels">
              {luts.map((lut, i) => (
                <div key={i} className="liquid-glass liquid-glass--chip p-2.5">
                  <label className="flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={lut.visible}
                      onChange={(e) =>
                        setLuts((prev) => {
                          const next = prev.map((x, j) => (j === i ? { ...x, visible: e.target.checked } : x));
                          if (packed) {
                            updateLockedChannels(
                              packed.channels.map((ch, idx) => ({ index: idx, name: ch.name, color: ch.color })),
                              next.map((x) => x.visible),
                            );
                          }
                          return next;
                        })
                      }
                    />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: rgbCss(lut.color) }} />
                    <span className="font-mono">{packed?.channels[i]?.name ?? i}</span>
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-[var(--text-dim)]">
                    <label>
                      {t(lang, "min")}
                      <input
                        type="range"
                        min={0}
                        max={lut.max}
                        value={lut.min}
                        onChange={(e) =>
                          setLuts((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) } : x)),
                          )
                        }
                        className="w-full"
                      />
                    </label>
                    <label>
                      {t(lang, "max")}
                      <input
                        type="range"
                        min={lut.min}
                        max={Math.max(lut.max, packed?.channels[i]?.suggestedMax ?? 4095)}
                        value={lut.max}
                        onChange={(e) =>
                          setLuts((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, max: Number(e.target.value) } : x)),
                          )
                        }
                        className="w-full"
                      />
                    </label>
                  </div>
                  <label className="mt-1 block text-[11px] text-[var(--text-dim)]">
                    γ {lut.gamma.toFixed(2)}
                    <input
                      type="range"
                      min={0.4}
                      max={2.5}
                      step={0.05}
                      value={lut.gamma}
                      onChange={(e) =>
                        setLuts((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, gamma: Number(e.target.value) } : x)),
                        )
                      }
                      className="w-full"
                    />
                  </label>
                  <svg viewBox="0 0 96 28" preserveAspectRatio="none" className="mt-1 h-8 w-full" aria-hidden>
                    <path d={histPaths[i] ?? ""} fill={rgbCss(lut.color, lut.visible ? 0.85 : 0.25)} />
                  </svg>
                </div>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={histLog} onChange={(e) => setHistLog(e.target.checked)} />
              {t(lang, "log")}
            </label>
          </Glass>

          <main className="relative flex min-h-[360px] flex-col bg-[var(--well)]" data-tour="canvas">
            <Glass tone="dark" shape="chip" className="mx-2 mt-2 flex flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap p-1.5">
              {(
                [
                  ["probe", Crosshair],
                  ["line", LineSegment],
                  ["rect", Rectangle],
                  ["ellipse", Circle],
                  ["polygon", Polygon],
                ] as const
              ).map(([k, Icon]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setTool(k);
                    setPoints([]);
                    setResult(null);
                  }}
                  aria-pressed={tool === k}
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
                    tool === k ? "bg-white text-black shadow-sm" : "text-white/65 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <Icon size={13} /> {t(lang, k)}
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
              <button
                type="button"
                onClick={() => void runMip("max")}
                aria-pressed={view === "mip"}
                className="rounded-lg px-2.5 py-1.5 text-[11px] text-white/65 transition-colors hover:bg-white/10 hover:text-white"
              >
                {t(lang, "mip")}
              </button>
              <button
                type="button"
                onClick={() => void runMip("min")}
                className="rounded-lg px-2.5 py-1.5 text-[11px] text-white/65 transition-colors hover:bg-white/10 hover:text-white"
              >
                {t(lang, "minip")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setView("overlay");
                  setProjSrc(null);
                  setError(null);
                }}
                aria-pressed={view === "overlay"}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${view === "overlay" ? "bg-white text-black" : "text-white/65 hover:bg-white/10 hover:text-white"}`}
              >
                {t(lang, "overlay")}
              </button>
              <button
                type="button"
                onClick={() => setTour(0)}
                className="ml-auto rounded-lg px-2.5 py-1.5 text-[11px] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                {t(lang, "help")}
              </button>
              <button
                type="button"
                onClick={() => nav("/workspace")}
                className="rounded-lg px-2.5 py-1.5 text-[11px] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                {t(lang, "back")}
              </button>
            </Glass>
            <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
              {view === "mip" && projSrc ? (
                <img src={projSrc} alt={t(lang, "projectionAlt")} className="max-h-full max-w-full object-contain" />
              ) : (
                <canvas
                  ref={canvasRef}
                  onPointerDown={onCanvasClick}
                  className="max-h-full max-w-full cursor-crosshair"
                  role="img"
                  aria-label={t(lang, "previewAlt")}
                  style={{ imageRendering: "pixelated", width: "auto", height: "auto" }}
                />
              )}
            </div>
            {loading && (
              <div role="status" className="pointer-events-none absolute right-3 top-14 flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-2 font-mono text-[11px] text-white/65">
                <span className="spinner h-3 w-3 border-white/25 border-t-[var(--accent)]" />
                {t(lang, "previewLoading")}
              </div>
            )}
            {error && (
              <p
                role="alert"
                className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] rounded-lg border border-red-300/15 bg-black/80 px-3 py-2 text-[12px] leading-5 text-red-100 shadow-lg"
              >
                {error}
              </p>
            )}
            {file && (
              <p className="absolute right-3 top-12 font-mono text-[11px] text-white/70">
                {file.name}{file.objective ? ` · ${file.objective}` : ""}
              </p>
            )}
          </main>

          <Glass as="aside" shape="panel" className="overflow-auto border-t p-3 lg:border-l lg:border-t-0">
            <Guide title="probe" body="probeGuide" />
            <div className="mt-3">
              <Guide title="mip" body="mipGuide" />
            </div>
            {nZ <= 1 && (
              <p className="mt-3 rounded-lg bg-[var(--bg)] px-3 py-2 text-[12px] leading-5 text-[var(--text-dim)]">
                {t(lang, nT <= 1 ? "noProjection" : "noZ")}
              </p>
            )}
            {probe && packed && (
              <div className="mt-3 font-mono text-[12px]">
                <p>
                  {t(lang, "probe")} ({probe.x}, {probe.y})
                </p>
                {packed.channels.map((ch, i) => (
                  <p key={ch.name}>
                    {ch.name}: {probe.vals[i]?.toFixed(1)}
                  </p>
                ))}
              </div>
            )}
            {result && (
              <div className="mt-4 text-[12px]">
                <p className="font-medium">{t(lang, "measure")}</p>
                {result.length_um != null && (
                  <p>
                    {t(lang, "length")}: {formatUm(result.length_um)}
                  </p>
                )}
                {result.area_um2 != null && (
                  <p>
                    {t(lang, "area")}: {result.area_um2.toFixed(2)} µm²
                  </p>
                )}
                {result.channels.map((c) => (
                  <p key={c.name} className="font-mono">
                    {c.name} {t(lang, "mean")} {c.mean?.toFixed(1)} {t(lang, "max")} {c.max?.toFixed(0)}
                  </p>
                ))}
                {result.profiles?.[0] && result.profiles[0].values.length > 1 && (
                  <svg viewBox="0 0 200 48" preserveAspectRatio="none" className="mt-2 h-12 w-full" aria-hidden>
                    <polyline points={profilePoints(result.profiles[0].values)} fill="none" stroke="var(--accent)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
                  </svg>
                )}
                <button
                  type="button"
                  className="mt-2 text-[var(--accent)]"
                  onClick={() => {
                    setPoints([]);
                    setResult(null);
                  }}
                >
                  {t(lang, "clearRoi")}
                </button>
              </div>
            )}
            <div className="mt-6">
              <ExportPanel fileIds={[id]} coords={{ t: tIdx, z: zIdx, p: pIdx }} luts={luts} />
            </div>
          </Glass>
        </div>

        <div className="px-3 pb-3 pt-2" data-tour="nd">
          <Glass shape="island" className="flex flex-wrap items-center gap-4 px-4 py-2">
          {nT > 1 && (
            <div className="flex items-center gap-2 font-mono text-[12px]">
              <label className="flex items-center gap-2">
                T {tIdx + 1}/{nT}
                <input type="range" min={0} max={nT - 1} value={tIdx} onChange={(e) => setT(Number(e.target.value))} />
              </label>
              <button
                type="button"
                onClick={() => setPlaying((v) => !v)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
                aria-label={t(lang, playing ? "pause" : "play")}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}
              </button>
            </div>
          )}
          {nZ > 1 && (
            <label className="flex items-center gap-2 font-mono text-[12px]">
              Z {zIdx + 1}/{nZ}
              <input type="range" min={0} max={nZ - 1} value={zIdx} onChange={(e) => setZ(Number(e.target.value))} />
            </label>
          )}
          {nP > 1 && (
            <label className="flex items-center gap-2 font-mono text-[12px]">
              XY {pIdx + 1}/{nP}
              <input type="range" min={0} max={nP - 1} value={pIdx} onChange={(e) => setP(Number(e.target.value))} />
            </label>
          )}
          {nT <= 1 && nZ <= 1 && nP <= 1 && (
            <span className="text-[12px] text-[var(--text-dim)]">{t(lang, "ndBar")}: XY · C</span>
          )}
          </Glass>
        </div>
      </div>

      {tour != null && (
        <div
          className="fade-in fixed inset-0 z-30 flex items-end justify-center bg-black/48 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t(lang, "help")}
        >
          <div className="w-full max-w-md">
            <Glass shape="island" className="p-5">
            <div className="mb-4 flex gap-1.5" aria-hidden>
              {tourCopy.map((_, index) => (
                <span
                  key={index}
                  className="h-1.5 rounded-full bg-[var(--accent)] transition-[width,opacity] duration-200"
                  style={{ width: index === tour ? 22 : 6, opacity: index <= tour ? 1 : 0.35 }}
                />
              ))}
            </div>
            <p className="min-h-14 text-[14px] leading-6">{tourCopy[tour]}</p>
            <div className="mt-5 flex items-center justify-between text-[13px]">
              <button
                type="button"
                className="rounded-lg px-2 py-1.5 text-[var(--text-dim)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
                onClick={() => {
                  writePref(TOUR_KEY, "1");
                  setTour(null);
                }}
              >
                {t(lang, "skipTour")}
              </button>
              <button
                type="button"
                className="rounded-xl bg-[var(--accent)] px-4 py-2 font-medium text-white transition-colors hover:bg-[var(--accent-strong)]"
                onClick={() => {
                  if (tour >= tourCopy.length - 1) {
                    writePref(TOUR_KEY, "1");
                    setTour(null);
                  } else setTour(tour + 1);
                }}
              >
                {tour >= tourCopy.length - 1 ? t(lang, "done") : t(lang, "next")}
              </button>
            </div>
            </Glass>
          </div>
        </div>
      )}
    </Shell>
  );
}
