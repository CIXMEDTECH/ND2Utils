import { useState } from "react";
import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { t } from "../i18n";
import { startExport } from "../lib/api";
import { detailMessage } from "../lib/format";
import type { ChannelEdit, LutSetting } from "../lib/types";
import { useApp } from "../store";
import { Guide } from "./Guide";

export function ExportPanel({
  fileIds,
  folders = [],
  fileCount,
  coords,
  luts,
  visible,
  cropsByFile,
  channelEditsByFile,
}: {
  fileIds: string[];
  /** Workspace folders to export recursively (resolved on the server). */
  folders?: string[];
  /** Number of ND2 files the export covers, when it differs from fileIds.length (folders). */
  fileCount?: number;
  coords?: { t: number; z: number; p: number };
  luts?: LutSetting[];
  visible?: boolean[];
  cropsByFile?: Record<string, { x: number; y: number; w: number; h: number; ratio_label?: string }>;
  channelEditsByFile?: Record<string, ChannelEdit[]>;
}) {
  const lang = useApp((s) => s.lang);
  const nav = useNavigate();
  const refreshJobs = useApp((s) => s.refreshJobs);
  const [format, setFormat] = useState<"ome-tiff" | "tiff" | "png" | "jpeg">("ome-tiff");
  const [scope, setScope] = useState<"current" | "all">("current");
  const [channelsMode, setChannelsMode] = useState<"composite" | "split" | "both">("composite");
  const [scaleBar, setScaleBar] = useState(true);
  const [separateScaleBar, setSeparateScaleBar] = useState(true);
  const [flatStructure, setFlatStructure] = useState(false);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [jpegQuality, setJpegQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const display = format === "png" || format === "jpeg" || format === "tiff";
  const count = fileCount ?? fileIds.length;

  async function run() {
    if (!count || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startExport({
        file_ids: fileIds,
        folders,
        format,
        scope,
        channels_mode: channelsMode,
        // OME-TIFF packages also contain viewable 8-bit companions; they get the scale bar too.
        scale_bar: scaleBar,
        separate_scale_bar: separateScaleBar,
        flat_structure: flatStructure,
        include_metadata: includeMetadata,
        burn_lut: false,
        jpeg_quality: jpegQuality,
        coords: coords ?? { t: 0, z: 0, p: 0 },
        luts: luts ? Object.fromEntries(luts.map((lut, index) => [String(index), lut])) : undefined,
        visible: visible ?? luts?.map((lut) => lut.visible),
        crops_by_file: cropsByFile,
        channel_edits_by_file: channelEditsByFile,
      });
      await refreshJobs();
      nav("/jobs");
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  const selectClass = "h-10 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] text-[var(--text)] transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent)]";

  return (
    <div className="flex flex-col gap-4">
      <label className="grid gap-1.5 text-[11px] font-medium text-[var(--text-dim)]">
        {t(lang, "format")}
        <select value={format} onChange={(event) => setFormat(event.target.value as typeof format)} className={selectClass}>
          <option value="ome-tiff">OME-TIFF</option>
          <option value="tiff">TIFF</option>
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </label>

      <Guide title="export" body={format === "ome-tiff" ? "omeHint" : format === "tiff" ? "tiffHint" : "displayWarn"} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <label className="grid gap-1.5 text-[11px] font-medium text-[var(--text-dim)]">
          {t(lang, "scope")}
          <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)} className={selectClass}>
            <option value="current">{t(lang, "currentPlane")}</option>
            <option value="all">{t(lang, "allPlanes")}</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-[11px] font-medium text-[var(--text-dim)]">
          {t(lang, "chMode")}
          <select value={channelsMode} onChange={(event) => setChannelsMode(event.target.value as typeof channelsMode)} className={selectClass}>
            <option value="composite">{t(lang, display ? "composite" : "multiChannelFile")}</option>
            <option value="split">{t(lang, "splitCh")}</option>
            <option value="both">{t(lang, "both")}</option>
          </select>
        </label>
      </div>

      <div className="grid gap-2 rounded-xl bg-[var(--bg)] p-3">
        <label className="flex cursor-pointer items-start gap-2.5 text-[12px] leading-5">
          <input type="checkbox" checked={includeMetadata} onChange={(event) => setIncludeMetadata(event.target.checked)} className="mt-0.5" />
          {t(lang, "includeMeta")}
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-[12px] leading-5">
          <input type="checkbox" checked={scaleBar} onChange={(event) => setScaleBar(event.target.checked)} className="mt-0.5" />
          {t(lang, "scaleBar")}
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-[12px] leading-5">
          <input type="checkbox" checked={separateScaleBar} onChange={(event) => setSeparateScaleBar(event.target.checked)} className="mt-0.5" />
          {t(lang, "separateScaleBar")}
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-[12px] leading-5">
          <input type="checkbox" checked={flatStructure} onChange={(event) => setFlatStructure(event.target.checked)} className="mt-0.5" />
          {t(lang, "flatStructure")}
        </label>
      </div>

      {format === "jpeg" && (
        <label className="grid gap-2 overflow-hidden text-[11px] font-medium text-[var(--text-dim)]">
          <span className="flex items-center justify-between">
            {t(lang, "jpegQ")}
            <span className="font-mono tabular-nums text-[var(--text)]">{jpegQuality}</span>
          </span>
          <input type="range" min={60} max={98} value={jpegQuality} onChange={(event) => setJpegQuality(Number(event.target.value))} />
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
        disabled={busy || !count}
        onClick={() => void run()}
        className="group inline-flex min-h-11 items-center justify-between rounded-xl bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-[0_10px_24px_var(--accent-glow)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[var(--accent-strong)] hover:shadow-[0_14px_30px_var(--accent-glow)] active:scale-[0.98] disabled:translate-y-0 disabled:opacity-40"
      >
        <span className="inline-flex items-center gap-2">
          {busy && (
            <span className="spinner h-3.5 w-3.5 rounded-full border border-white/35 border-t-white" />
          )}
          {busy ? t(lang, "jobRunning") : t(lang, "startExport")}
        </span>
        <span className="inline-flex items-center gap-2 font-mono text-[10px] font-normal text-white/72">
          {count} {t(lang, "nFiles")}
          <ArrowRight size={13} className="transition-transform duration-300 group-hover:translate-x-0.5" />
        </span>
      </button>
    </div>
  );
}
