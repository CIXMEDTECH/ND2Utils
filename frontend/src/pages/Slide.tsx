import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Camera, Hand, Selection, X } from "@phosphor-icons/react";
import { ChannelToggles } from "../components/ChannelToggles";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { SlideChannels } from "../components/SlideChannels";
import { SlideExport } from "../components/SlideExport";
import {
  SlideLoading,
  SlideStage,
  SlideZoomControls,
  defaultDisplay,
  displayKey,
  loadDisplay,
  type SlideCursor,
  type SlideTool,
} from "../components/SlideStage";
import { t } from "../i18n";
import { slideInfo } from "../lib/api";
import { detailMessage, formatBytes, formatUm, isSlide } from "../lib/format";
import type { ChannelDisplay, Rect, SlideViewer, ViewState } from "../lib/slide";
import { writePref } from "../lib/storage";
import type { SlideInfo } from "../lib/types";
import { useApp } from "../store";

type Tab = "info" | "export";

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
  const channelLocked = useApp((s) => s.channelLocked);
  const resolveVisibleChannels = useApp((s) => s.resolveVisibleChannels);
  const updateLockedChannels = useApp((s) => s.updateLockedChannels);
  const nav = useNavigate();
  const file = files.find((f) => f.id === fileId) ?? null;

  const [info, setInfo] = useState<SlideInfo | null>(null);
  const [display, setDisplay] = useState<ChannelDisplay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<SlideViewer | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [tool, setTool] = useState<SlideTool>("pan");
  const [selection, setSelection] = useState<Rect | null>(null);
  const [plane, setPlane] = useState({ t: 0, z: 0 });
  const [scaleBar, setScaleBar] = useState(true);
  const [tab, setTab] = useState<Tab>("info");
  const [cursor, setCursor] = useState<SlideCursor | null>(null);
  const [snapOpen, setSnapOpen] = useState(false);

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
        const base = loadDisplay(next);
        if (useApp.getState().channelLocked) {
          const lockedVis = resolveVisibleChannels(next.channels);
          setDisplay(base.map((d, i) => ({ ...d, visible: lockedVis[i] ?? d.visible })));
        } else {
          setDisplay(base);
        }
        setInfo(next);
      })
      .catch((err) => {
        if (!cancelled) setError(detailMessage(err, lang));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, lang, resolveVisibleChannels]);

  useEffect(() => {
    if (info && display.length === info.channels.length) writePref(displayKey(info.id), JSON.stringify(display));
  }, [display, info]);

  const names = useMemo(() => info?.channels.map((c) => c.name) ?? [], [info]);
  const chips = useMemo(
    () => info?.channels.map((ch, i) => ({ ...ch, color: display[i]?.color ?? ch.color })) ?? [],
    [display, info],
  );
  const visible = useMemo(() => display.map((d) => d.visible), [display]);
  const mag = info?.magnification && view ? info.magnification * view.scale : null;

  function toggle(index: number) {
    setDisplay((prev) => {
      const next = prev.map((d, i) => (i === index ? { ...d, visible: !d.visible } : d));
      if (info && channelLocked) {
        updateLockedChannels(
          info.channels,
          next.map((d) => d.visible),
        );
      }
      return next;
    });
  }

  if (file && !isSlide(file)) {
    return (
      <Shell dense>
        <div className="p-10 text-base text-[var(--text-dim)]">{t(lang, "slideNotSlide")}</div>
      </Shell>
    );
  }

  const toolButton = (active: boolean) =>
    `flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-all duration-200 ${active ? "bg-white text-black shadow-sm" : "text-white/65 hover:bg-white/10 hover:text-white"}`;
  const iconButton =
    "flex h-7 w-7 items-center justify-center rounded-lg text-white/65 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-35";

  return (
    <Shell dense>
      <div className="grid min-h-[calc(100dvh-4rem)] grid-cols-1 lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:grid-cols-[260px_minmax(0,1fr)_320px]">
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
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={file?.name}>
              {file?.name ?? t(lang, "slideViewer")}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3 max-lg:max-h-[50dvh]">
            <p className="mb-1 text-sm font-medium">{t(lang, "channels")}</p>
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
              <div className="mt-4 grid gap-2 rounded-xl bg-[var(--bg)] p-3 text-xs">
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
                        onChange={(event) => setPlane((p) => ({ ...p, [axis === "T" ? "t" : "z"]: Number(event.target.value) }))}
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
          {info && display.length === info.channels.length ? (
            <SlideStage
              info={info}
              display={display}
              plane={plane}
              scaleBar={scaleBar}
              tool={tool}
              selection={selection}
              onSelection={(rect, done) => {
                setSelection(rect);
                if (done && rect) setTab("export");
              }}
              onViewer={setViewer}
              onView={setView}
              onCursor={setCursor}
              minimap={!snapOpen}
            >
              <Glass tone="dark" shape="chip" className="absolute left-2 right-2 top-2 z-20 flex flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap p-1">
                <button type="button" className={toolButton(tool === "pan")} aria-pressed={tool === "pan"} onClick={() => setTool("pan")}>
                  <Hand size={14} /> {t(lang, "toolPan")}
                </button>
                <button type="button" className={toolButton(tool === "select")} aria-pressed={tool === "select"} onClick={() => setTool("select")}>
                  <Selection size={14} /> {t(lang, "toolSelect")}
                </button>
                <span className="mx-1 h-4 w-px shrink-0 bg-white/10" aria-hidden />
                <SlideZoomControls viewer={viewer} view={view} />
                {mag !== null && (
                  <span className="ml-1 rounded-md bg-white/8 px-2 py-1 font-mono text-2xs tabular-nums text-white/70" title={t(lang, "equivalentMag")}>
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

              <Glass tone="dark" shape="chip" className="absolute bottom-3 left-3 z-20 max-w-[min(100%-10rem,34rem)] overflow-visible p-1">
                <ChannelToggles channels={chips} visible={visible} onToggle={toggle} />
              </Glass>

              {selection && (
                <Glass tone="dark" shape="chip" className="absolute left-3 top-14 z-20 flex max-w-[calc(100%-14rem)] flex-wrap items-center gap-1 p-1">
                  <span className="px-2 font-mono text-2xs tabular-nums text-white/70">
                    {Math.round(selection.w)} × {Math.round(selection.h)} px
                    {info.um_per_px ? ` · ${formatUm(selection.w * info.um_per_px)} × ${formatUm(selection.h * info.um_per_px)}` : ""}
                  </span>
                  <button type="button" className={toolButton(false)} onClick={() => viewer?.showRect(selection)}>
                    {t(lang, "zoomToRegion")}
                  </button>
                  <button type="button" className={iconButton} onClick={() => setSelection(null)} aria-label={t(lang, "clearRegion")} title={t(lang, "clearRegion")}>
                    <X size={14} />
                  </button>
                </Glass>
              )}

              {snapOpen && viewer && (
                <SnapshotPopover viewer={viewer} names={names} fileName={file?.name ?? "slide"} scaleBar={scaleBar} onClose={() => setSnapOpen(false)} />
              )}
            </SlideStage>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center bg-[#050607] px-8">
              <p role="alert" className="max-w-[48ch] text-center text-sm leading-6 text-red-200">
                {error}
              </p>
            </div>
          ) : (
            <SlideLoading />
          )}

          <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.06] bg-black/30 px-3 py-1.5 font-mono text-2xs tabular-nums text-white/55">
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
                {viewer && <span className="mr-2 text-white/40">{t(lang, viewer.renderer === "server" ? "renderServer" : viewer.renderer === "webgl" ? "renderGpu" : "renderCpu")} ·</span>}
                L{view.level}/{info.levels.length - 1}
                {view.loading > 0 ? " · …" : ""}
              </span>
            )}
          </div>
        </main>

        {/* Info / export */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-t lg:border-l lg:border-t-0">
          <div className="flex gap-1 border-b border-[var(--line)] p-2 text-sm" role="tablist">
            {(["info", "export"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-lg px-2 py-2 transition-colors ${tab === key ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
              >
                {t(lang, key === "info" ? "slideTabInfo" : "slideTabExport")}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {info && tab === "info" && <SlideInfoList info={info} view={view} />}
            {info && tab === "export" && (
              <SlideExport info={info} display={display} view={view?.rect ?? null} selection={selection} plane={plane} />
            )}
          </div>
        </Glass>
      </div>
    </Shell>
  );
}

function SlideInfoList({ info, view }: { info: SlideInfo; view: ViewState | null }) {
  const lang = useApp((s) => s.lang);
  const file = useApp((s) => s.files.find((f) => f.id === info.id) ?? null);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
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
            <span className="block text-xs text-[var(--text-dim)]">
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
        <ol className="grid gap-0.5 font-mono text-xs tabular-nums">
          {info.levels.map((lv, i) => (
            <li key={i} className={view?.level === i ? "text-[var(--accent)]" : ""}>
              L{i} · {lv.width}×{lv.height}
              {lv.virtual ? <span className="text-[var(--text-dim)]"> · {t(lang, "virtualLevel")}</span> : null}
            </li>
          ))}
        </ol>
      </dd>
    </dl>
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
    <div
      data-no-pan
      className="absolute right-3 top-14 z-30 w-72"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Glass shape="island" className="p-4 text-sm">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium">{t(lang, "screenshot")}</span>
          <button type="button" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] hover:bg-[var(--bg)]" aria-label={t(lang, "close")}>
            <X size={13} />
          </button>
        </div>
        <p className="mb-3 leading-5 text-[var(--text-dim)]">{t(lang, "screenshotHint")}</p>
        <div className="mb-3 grid gap-1.5">
          <span className="text-xs font-medium text-[var(--text-dim)]">{t(lang, "screenshotScale")}</span>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--bg)] p-1">
            {[1, 2, 4].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setK(value)}
                aria-pressed={k === value}
                className={`rounded-lg py-1.5 font-mono text-xs transition-colors ${k === value ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
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
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-50"
          >
            {busy ? t(lang, "rendering") : t(lang, "savePng")}
          </button>
          {canCopy && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void copy()}
              className="inline-flex h-9 items-center rounded-xl px-3 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
            >
              {t(lang, "copyImage")}
            </button>
          )}
        </div>
        {note && <p className="mt-2 text-xs leading-5 text-[var(--text-dim)]" aria-live="polite">{note}</p>}
      </Glass>
    </div>
  );
}
