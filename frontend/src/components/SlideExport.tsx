import { useEffect, useMemo, useState } from "react";
import { ArrowRight, DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { t, type MsgKey } from "../i18n";
import { ApiError, clientSettings, getJob, jobDownloadUrl, startSlideExport } from "../lib/api";
import { detailMessage, rgbCss } from "../lib/format";
import type { ChannelDisplay, Rect } from "../lib/slide";
import type { JobInfo, SlideExportFormat, SlideInfo } from "../lib/types";
import { useApp } from "../store";
import { Guide } from "./Guide";

type RegionMode = "view" | "selection" | "full";

const HINTS: Record<SlideExportFormat, MsgKey> = {
  "ome-tiff": "slideOmeHint",
  tiff: "slideTiffHint",
  png: "slideRasterHint",
  jpeg: "slideRasterHint",
};

/** Same arithmetic as the server (slide_export.plan): output size of a region at a level. */
function outputSize(info: SlideInfo, level: number, region: Rect | null): { w: number; h: number } {
  const lv = info.levels[level];
  const sx = info.width / lv.width;
  const sy = info.height / lv.height;
  const r = region ?? { x: 0, y: 0, w: info.width, h: info.height };
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(info.width, r.x + r.w);
  const y1 = Math.min(info.height, r.y + r.h);
  const lx = Math.floor(x0 / sx);
  const ly = Math.floor(y0 / sy);
  return {
    w: Math.max(0, Math.min(Math.ceil(x1 / sx), lv.width) - lx),
    h: Math.max(0, Math.min(Math.ceil(y1 / sy), lv.height) - ly),
  };
}

function megapixels(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} Gpx` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mpx` : `${(n / 1e3).toFixed(0)} kpx`;
}

export function SlideExport({
  info,
  display,
  view,
  selection,
  plane,
}: {
  info: SlideInfo;
  display: ChannelDisplay[];
  view: Rect | null;
  selection: Rect | null;
  plane: { t: number; z: number };
}) {
  const lang = useApp((s) => s.lang);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const nav = useNavigate();
  const [format, setFormat] = useState<SlideExportFormat>("ome-tiff");
  const [mode, setMode] = useState<RegionMode>(selection ? "selection" : "view");
  const [level, setLevel] = useState(0);
  const [channels, setChannels] = useState<boolean[]>(() => display.map((d) => d.visible));
  const [scaleBar, setScaleBar] = useState(true);
  const [quality, setQuality] = useState(92);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rasterLimit, setRasterLimit] = useState(64_000_000);

  useEffect(() => {
    void clientSettings()
      .then((s) => setRasterLimit(s.raster_max_pixels))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (selection) setMode("selection");
  }, [selection]);

  // Follow the viewer's visibility until the user edits the export's own channel list.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setChannels(display.map((d) => d.visible));
  }, [display, touched]);

  const region = mode === "full" ? null : mode === "selection" ? selection : view;
  const size = useMemo(() => outputSize(info, level, region), [info, level, region]);
  const raster = format === "png" || format === "jpeg";
  const composite = format !== "ome-tiff";
  const pixels = size.w * size.h;
  const tooLarge = raster && (pixels > rasterLimit || (format === "jpeg" && Math.max(size.w, size.h) > 65500));
  const chosen = channels.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
  const blocked = busy || !chosen.length || !size.w || !size.h || tooLarge || (mode === "selection" && !selection);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error") return;
    const handle = window.setTimeout(() => {
      void getJob(job.id)
        .then(setJob)
        .catch((err) => setError(detailMessage(err, lang)));
    }, 700);
    return () => window.clearTimeout(handle);
  }, [job, lang]);

  async function run() {
    if (blocked) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const started = await startSlideExport(info.id, {
        format,
        region: region ? [region.x, region.y, region.w, region.h] : null,
        level,
        channels: chosen,
        luts: display.map((d, i) => ({ min: d.min, max: d.max, gamma: d.gamma, color: d.color, visible: chosen.includes(i) })),
        t: plane.t,
        z: plane.z,
        scale_bar: composite && scaleBar,
        jpeg_quality: quality,
      });
      setJob(await getJob(started.id));
      void refreshJobs().catch(() => undefined);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "too_large" ? t(lang, "tooLargeRaster") : detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  const selectClass =
    "h-10 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] text-[var(--text)] transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent)]";
  const running = job && (job.status === "queued" || job.status === "running");

  return (
    <div className="flex flex-col gap-4">
      <label className="grid gap-1.5 text-[11px] font-medium text-[var(--text-dim)]">
        {t(lang, "format")}
        <select value={format} onChange={(event) => setFormat(event.target.value as SlideExportFormat)} className={selectClass}>
          <option value="ome-tiff">OME-TIFF</option>
          <option value="tiff">TIFF</option>
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </label>
      <Guide title="export" body={HINTS[format]} />

      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-[11px] font-medium text-[var(--text-dim)]">{t(lang, "exportRegion")}</legend>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--bg)] p-1" role="radiogroup">
          {(["view", "selection", "full"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={mode === key}
              onClick={() => setMode(key)}
              className={`rounded-lg px-1.5 py-1.5 text-[11.5px] transition-colors ${mode === key ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
            >
              {t(lang, key === "view" ? "regionView" : key === "selection" ? "regionSelection" : "regionFull")}
            </button>
          ))}
        </div>
        {mode === "selection" && !selection && <p className="text-[11.5px] leading-5 text-[var(--text-dim)]">{t(lang, "needSelection")}</p>}
      </fieldset>

      <label className="grid gap-1.5 text-[11px] font-medium text-[var(--text-dim)]">
        {t(lang, "resolution")}
        <select value={level} onChange={(event) => setLevel(Number(event.target.value))} className={selectClass}>
          {info.levels.map((lv, i) => (
            <option key={i} value={i}>
              {i === 0 ? t(lang, "fullResolution") : `1/${Number(lv.downsample.toPrecision(3))}`}
              {info.um_per_px ? ` · ${(info.um_per_px * lv.downsample).toPrecision(3)} µm/px` : ""}
            </option>
          ))}
        </select>
      </label>

      <p className={`flex items-baseline justify-between rounded-xl bg-[var(--bg)] px-3 py-2 text-[12px] ${tooLarge ? "text-[var(--danger)]" : ""}`}>
        <span className="text-[var(--text-dim)]">{t(lang, "outputSize")}</span>
        <span className="font-mono tabular-nums">
          {size.w} × {size.h} px · {megapixels(pixels)}
        </span>
      </p>
      {tooLarge && <p className="-mt-2 text-[11.5px] leading-5 text-[var(--danger)]">{t(lang, "tooLargeRaster")}</p>}

      <fieldset>
        <legend className="mb-1.5 text-[11px] font-medium text-[var(--text-dim)]">{t(lang, "exportChannels")}</legend>
        <div className="grid grid-cols-2 gap-1">
          {info.channels.map((ch, i) => (
            <label key={i} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-[11.5px] hover:bg-[var(--bg)]">
              <input
                type="checkbox"
                checked={channels[i] ?? false}
                onChange={(event) => {
                  setTouched(true);
                  setChannels((prev) => prev.map((v, j) => (j === i ? event.target.checked : v)));
                }}
              />
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: rgbCss(display[i]?.color) }} />
              <span className="truncate font-mono">{ch.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {composite && (
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl bg-[var(--bg)] p-3 text-[12px]">
          <input type="checkbox" checked={scaleBar} onChange={(event) => setScaleBar(event.target.checked)} />
          {t(lang, "scaleBar")}
        </label>
      )}
      {format === "jpeg" && (
        <label className="grid gap-2 text-[11px] font-medium text-[var(--text-dim)]">
          <span className="flex items-center justify-between">
            {t(lang, "jpegQ")}
            <span className="font-mono tabular-nums text-[var(--text)]">{quality}</span>
          </span>
          <input type="range" min={60} max={100} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
        </label>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-[12px] leading-5 text-[var(--danger)]">
          <WarningCircle size={15} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={blocked || Boolean(running)}
        onClick={() => void run()}
        className="group inline-flex min-h-11 items-center justify-between rounded-xl bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-[0_10px_24px_var(--accent-glow)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[var(--accent-strong)] active:scale-[0.98] disabled:translate-y-0 disabled:opacity-40"
      >
        <span className="inline-flex items-center gap-2">
          {(busy || running) && (
            <span className="spinner h-3.5 w-3.5 rounded-full border border-white/35 border-t-white" />
          )}
          {busy || running ? t(lang, "jobRunning") : t(lang, "startExport")}
        </span>
        <ArrowRight size={13} className="transition-transform duration-300 group-hover:translate-x-0.5" />
      </button>

      {job && (
        <div className="rounded-xl border border-[var(--line)] p-3 text-[12px]" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <span className={job.status === "error" ? "text-[var(--danger)]" : "text-[var(--text-dim)]"}>
              {job.status === "done" ? t(lang, "exportReady") : job.status === "error" ? t(lang, "jobError") : t(lang, "jobRunning")}
            </span>
            <span className="font-mono tabular-nums text-[11px]">{Math.round((job.progress ?? 0) * 100)}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg)]">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${job.status === "error" ? "bg-[var(--danger)]" : "bg-[var(--accent)]"}`}
              style={{ width: `${Math.max(2, (job.progress ?? 0) * 100)}%` }}
            />
          </div>
          {job.status === "error" && job.error && <p className="mt-2 leading-5 text-[var(--danger)]">{job.error}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {job.status === "done" && (
              <a
                href={jobDownloadUrl(job.id)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[11.5px] font-medium text-[var(--bg)]"
              >
                <DownloadSimple size={14} /> {t(lang, "download")}
              </a>
            )}
            <button type="button" onClick={() => nav("/jobs")} className="h-8 rounded-lg px-2 text-[11.5px] text-[var(--accent)] hover:bg-[var(--accent-soft)]">
              {t(lang, "viewJobs")}
            </button>
          </div>
          {job.download_name && <p className="mt-2 truncate font-mono text-[10.5px] text-[var(--text-dim)]">{job.download_name}</p>}
        </div>
      )}
    </div>
  );
}
