import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import {
  ArrowClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChartBar,
  Export as ExportIcon,
  Folder,
  Plus,
  ShootingStar,
  SpinnerGap,
  SunDim,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { Glass } from "../components/Glass";
import { Modal } from "../components/Modal";
import { Shell } from "../components/Shell";
import { ZoomStage } from "../components/ZoomStage";
import { t, type MsgKey } from "../i18n";
import {
  analysisImageUrl,
  analysisSummary,
  createAnalysis,
  deleteAnalysis,
  exportAnalysis,
  getAnalysis,
  getCometResult,
  listAnalyses,
  patchCometResult,
  runAnalysis,
  updateAnalysis,
  type AnalysisFile,
  type AnalysisInfo,
  type AnalysisSummary,
  type Comet,
  type CometParams,
  type CometResult,
  type Stat,
  type TailDirection,
} from "../lib/api";
import { detailMessage, formatDateTime } from "../lib/format";
import type { Lang } from "../lib/types";
import { useApp } from "../store";

const METRIC_KEYS = ["TailDNAPercent", "TailMoment", "OliveMoment", "TailLength", "CometLength", "HeadDNAPercent"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
const METRIC_LABEL: Record<MetricKey, MsgKey> = {
  TailDNAPercent: "mTailDNAPercent",
  TailMoment: "mTailMoment",
  OliveMoment: "mOliveMoment",
  TailLength: "mTailLength",
  CometLength: "mCometLength",
  HeadDNAPercent: "mHeadDNAPercent",
};
const DETAIL_METRICS = [
  "CometArea", "CometLength", "CometIntensity", "CometDNA",
  "HeadArea", "HeadLength", "HeadDNA", "HeadDNAPercent",
  "TailArea", "TailLength", "TailDNA", "TailDNAPercent", "TailMoment", "OliveMoment",
];
const STATUS_COLOR: Record<string, string> = { valid: "#ef4444", outlier: "#f97316", invalid: "#94a3b8", deleted: "#64748b" };
const GROUP_COLORS = ["#0ea5e9", "#f97316", "#22c55e", "#a855f7", "#ef4444", "#eab308", "#14b8a6", "#ec4899"];

const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : Number(v.toFixed(digits)).toString());

// --- list ------------------------------------------------------------------------------------

function NewAnalysisDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lang = useApp((s) => s.lang);
  const folders = useApp((s) => s.folders);
  const files = useApp((s) => s.files);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !files.length) void refreshFiles().catch(() => undefined);
  }, [files.length, open, refreshFiles]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) map.set(f.folder, (map.get(f.folder) ?? 0) + 1);
    return map;
  }, [files]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const rec = await createAnalysis({ name: name || [...picked].map((p) => p.split("/").pop()).join(" · "), folders: [...picked] });
      nav(analysisPath(rec));
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={t(lang, "newAnalysis")} subtitle={t(lang, "newAnalysisHint")} onClose={onClose} width={520}>
      <label className="grid gap-1.5 text-sm text-[var(--text-dim)]">
        {t(lang, "analysisName")}
        <input value={name} onChange={(e) => setName(e.target.value)} className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[var(--text)]" />
      </label>
      <div className="mt-3 max-h-[44vh] overflow-auto rounded-xl border border-[var(--line)] p-1">
        {folders.filter((f) => counts.get(f)).length === 0 && <p className="p-3 text-sm text-[var(--text-dim)]">{t(lang, "emptyFiles")}</p>}
        {folders
          .filter((f) => counts.get(f))
          .map((f) => (
            <label key={f} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--bg)]">
              <input
                type="checkbox"
                checked={picked.has(f)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(f);
                    else next.delete(f);
                    return next;
                  })
                }
              />
              <Folder size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
              <span className="truncate">{f}</span>
              <span className="ml-auto font-mono text-xs text-[var(--text-dim)]">{counts.get(f)}</span>
            </label>
          ))}
      </div>
      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
          {t(lang, "cancel")}
        </button>
        <button type="button" disabled={busy || !picked.size} onClick={() => void create()} className="primary-action min-h-9 px-4 disabled:opacity-50">
          {t(lang, "startAnalysis")}
        </button>
      </div>
    </Modal>
  );
}

/** Analysis tools. Each tool owns its pages under /analysis/<type>; more will follow. */
const TOOLS: { type: AnalysisInfo["type"]; title: MsgKey; body: MsgKey; Icon: typeof ChartBar }[] = [
  { type: "comet", title: "cometAssay", body: "cometToolBody", Icon: ShootingStar },
];

export const analysisPath = (a: Pick<AnalysisInfo, "id" | "type">) => `/analysis/${a.type}/${a.id}`;

function AnalysisCards({ items, onChanged }: { items: AnalysisInfo[]; onChanged: () => void }) {
  const lang = useApp((s) => s.lang);
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map((a) => {
        const tool = TOOLS.find((tl) => tl.type === a.type) ?? TOOLS[0];
        return (
          <li key={a.id}>
            <Glass shape="card" className="flex items-start gap-3 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <tool.Icon size={20} weight="duotone" />
              </span>
              <Link to={analysisPath(a)} className="min-w-0 flex-1">
                <p className="truncate font-semibold">{a.name}</p>
                <p className="mt-1 text-sm text-[var(--text-dim)]">
                  {t(lang, tool.title)} · {a.file_count} {t(lang, "nFiles")} · {formatDateTime(a.updated_at, lang)}
                </p>
                {(a.status === "running" || a.status === "queued") && (
                  <p className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--accent)]">
                    <SpinnerGap size={12} className="animate-spin" /> {Math.round(a.progress * 100)}%
                  </p>
                )}
              </Link>
              <button
                type="button"
                onClick={() => void deleteAnalysis(a.id).then(onChanged)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-dim)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-[var(--danger)]"
                title={t(lang, "delete")}
                aria-label={t(lang, "delete")}
              >
                <Trash size={16} />
              </button>
            </Glass>
          </li>
        );
      })}
    </ul>
  );
}

function useAnalyses(type?: AnalysisInfo["type"]) {
  const lang = useApp((s) => s.lang);
  const [items, setItems] = useState<AnalysisInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void listAnalyses()
      .then((all) => setItems(type ? all.filter((a) => a.type === type) : all))
      .catch((err) => setError(detailMessage(err, lang)));
  }, [lang, type]);
  useEffect(load, [load]);
  return { items, error, load };
}

/** /analysis: the analysis tools, and every analysis made with them. */
export function AnalysisHub() {
  const lang = useApp((s) => s.lang);
  const { items, error, load } = useAnalyses();
  return (
    <Shell dense>
      <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
        <div className="border-b border-[var(--line)] pb-6">
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-[var(--accent)]">{t(lang, "analysisEyebrow")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{t(lang, "analysisTitle")}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-dim)]">{t(lang, "analysisHubIntro")}</p>
        </div>
        <h2 className="mt-8 text-sm font-semibold text-[var(--text-dim)]">{t(lang, "analysisTools")}</h2>
        <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map(({ type, title, body, Icon }) => (
            <li key={type}>
              <Link to={`/analysis/${type}`} className="group block h-full">
                <Glass shape="card" className="flex h-full flex-col p-5 transition-transform group-hover:-translate-y-0.5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Icon size={22} weight="duotone" />
                  </span>
                  <h3 className="mt-4 text-lg font-semibold">{t(lang, title)}</h3>
                  <p className="mt-1.5 flex-1 text-sm leading-6 text-[var(--text-dim)]">{t(lang, body)}</p>
                  <span className="mt-3 text-xs text-[var(--text-dim)]">
                    {items ? items.filter((a) => a.type === type).length : "…"} {t(lang, "analysesCount")}
                  </span>
                </Glass>
              </Link>
            </li>
          ))}
          <li>
            <div className="flex h-full min-h-40 flex-col justify-center rounded-2xl border border-dashed border-[var(--line-strong)] p-5 text-sm leading-6 text-[var(--text-dim)]">
              {t(lang, "moreAnalysesSoon")}
            </div>
          </li>
        </ul>
        <h2 className="mt-10 text-sm font-semibold text-[var(--text-dim)]">{t(lang, "allAnalyses")}</h2>
        {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
        {items && items.length === 0 && <p className="mt-3 text-sm text-[var(--text-dim)]">{t(lang, "noAnalyses")}</p>}
        <div className="mt-3">{items && <AnalysisCards items={items} onChanged={load} />}</div>
      </main>
    </Shell>
  );
}

/** /analysis/comet: comet assay analyses and "new". */
export function CometTool() {
  const lang = useApp((s) => s.lang);
  const { items, error, load } = useAnalyses("comet");
  const [creating, setCreating] = useState(false);
  return (
    <Shell dense>
      <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--line)] pb-6">
          <div>
            <Link to="/analysis" className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-[0.16em] text-[var(--accent)] hover:underline">
              <ArrowLeft size={11} /> {t(lang, "analysisTitle")}
            </Link>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{t(lang, "cometAssay")}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-dim)]">{t(lang, "analysisIntro")}</p>
          </div>
          <button type="button" onClick={() => setCreating(true)} className="primary-action">
            <Plus size={16} />
            {t(lang, "newAnalysis")}
          </button>
        </div>
        {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}
        {items && items.length === 0 && (
          <div className="flex min-h-64 flex-col items-center justify-center text-center">
            <ShootingStar size={34} weight="duotone" className="mb-4 text-[var(--accent)]" />
            <p className="max-w-md text-md leading-6 text-[var(--text-dim)]">{t(lang, "noAnalyses")}</p>
          </div>
        )}
        <div className="mt-6">{items && <AnalysisCards items={items} onChanged={load} />}</div>
      </main>
      <NewAnalysisDialog open={creating} onClose={() => setCreating(false)} />
    </Shell>
  );
}

/** Links from 1.1 beta1 (/analysis/<id>) → /analysis/comet/<id>. */
export function AnalysisRedirect() {
  const { analysisId = "" } = useParams();
  return <Navigate to={`/analysis/comet/${analysisId}`} replace />;
}

// --- charts ----------------------------------------------------------------------------------

function ProfileChart({ comet, lang }: { comet: Comet; lang: Lang }) {
  const p = comet.profiles;
  if (!p || !p.comet.length) return null;
  const w = 300;
  const h = 110;
  const max = Math.max(1, ...p.comet);
  const line = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${((i / Math.max(1, vals.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 6)).toFixed(1)}`).join(" ");
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-28 w-full rounded-lg bg-[var(--bg)]" role="img" aria-label={t(lang, "intensityProfile")}>
        <path d={line(p.comet)} fill="none" stroke="#eab308" strokeWidth={1.6} />
        <path d={line(p.head)} fill="none" stroke="#22c55e" strokeWidth={1.4} />
        <path d={line(p.tail)} fill="none" stroke="#3b82f6" strokeWidth={1.4} />
      </svg>
      <figcaption className="mt-1 flex gap-3 text-2xs text-[var(--text-dim)]">
        <span className="text-[#eab308]">— {t(lang, "profileComet")}</span>
        <span className="text-[#22c55e]">— {t(lang, "profileHead")}</span>
        <span className="text-[#3b82f6]">— {t(lang, "profileTail")}</span>
      </figcaption>
    </figure>
  );
}

function BoxPlot({ summary, metric }: { summary: AnalysisSummary; metric: MetricKey }) {
  const groups = summary.groups.filter((g) => (g.values[metric] ?? []).length);
  if (!groups.length) return null;
  const all = groups.flatMap((g) => g.values[metric] ?? []);
  const max = Math.max(1e-6, ...all) * 1.08;
  const w = 320;
  const h = 180;
  const left = 34;
  const bottom = 26;
  const plotH = h - bottom - 8;
  const bandW = (w - left - 6) / groups.length;
  const y = (v: number) => 8 + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max].map((v) => Number(v.toPrecision(2)));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img">
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={left} x2={w - 4} y1={y(tk)} y2={y(tk)} stroke="var(--line)" strokeWidth={1} />
          <text x={left - 4} y={y(tk) + 3} textAnchor="end" fontSize={9} fill="var(--text-dim)">
            {tk}
          </text>
        </g>
      ))}
      {groups.map((g, gi) => {
        const vals = [...(g.values[metric] ?? [])].sort((a, b) => a - b);
        const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
        const cx = left + bandW * gi + bandW / 2;
        const bw = Math.min(46, bandW * 0.5);
        const color = GROUP_COLORS[gi % GROUP_COLORS.length];
        return (
          <g key={g.group}>
            <line x1={cx} x2={cx} y1={y(vals[0])} y2={y(vals[vals.length - 1])} stroke={color} strokeWidth={1} />
            <rect x={cx - bw / 2} y={y(q(0.75))} width={bw} height={Math.max(1, y(q(0.25)) - y(q(0.75)))} fill={`${color}33`} stroke={color} />
            <line x1={cx - bw / 2} x2={cx + bw / 2} y1={y(q(0.5))} y2={y(q(0.5))} stroke={color} strokeWidth={2} />
            {vals.map((v, i) => (
              <circle key={i} cx={cx + (((i * 37) % 17) / 17 - 0.5) * bw * 0.9} cy={y(v)} r={1.8} fill={color} opacity={0.75} />
            ))}
            <text x={cx} y={h - 10} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
              {g.group.length > 16 ? `…${g.group.slice(-15)}` : g.group}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// --- detail ------------------------------------------------------------------------------------

function StatCell({ stat }: { stat: Stat | undefined }) {
  if (!stat || !stat.n) return <td className="px-2 py-1.5 text-right font-mono text-xs text-[var(--text-dim)]">–</td>;
  return (
    <td className="px-2 py-1.5 text-right font-mono text-xs tabular-nums" title={`SEM ${fmt(stat.sem)} · median ${fmt(stat.median)}`}>
      {fmt(stat.mean)} <span className="text-[var(--text-dim)]">± {fmt(stat.sd)}</span>
    </td>
  );
}

interface DisplaySettings {
  mode: "auto" | "manual";
  black: number;
  white: number;
  gamma: number;
  pseudo: boolean;
}

const DEFAULT_DISPLAY: DisplaySettings = { mode: "auto", black: 0, white: 255, gamma: 1, pseudo: false };

/** Black/white points from the histogram (0.1 % / 99.9 %), like an auto-contrast. */
function autoRange(hist: Uint32Array, total: number): [number, number] {
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > total * 0.001) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc > total * 0.001) {
      hi = v;
      break;
    }
  }
  return hi > lo ? [lo, hi] : [lo, Math.min(255, lo + 1)];
}

const isReddish = (c: number[] | undefined) => Boolean(c && c[0] > 160 && c[1] < 120 && c[2] < 120);

export function AnalysisDetail() {
  const { analysisId = "" } = useParams();
  const lang = useApp((s) => s.lang);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const nav = useNavigate();
  const [info, setInfo] = useState<AnalysisInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<CometResult | null>(null);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [includeOutliers, setIncludeOutliers] = useState(false);
  const [plotMetric, setPlotMetric] = useState<MetricKey>("TailDNAPercent");
  const [draft, setDraft] = useState<CometParams | null>(null);
  const [exporting, setExporting] = useState(false);
  const [display, setDisplay] = useState<DisplaySettings>(DEFAULT_DISPLAY);
  const gray = useRef<{ data: Uint8Array; w: number; h: number; auto: [number, number] } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageVersion, setImageVersion] = useState(0);

  const busy = info?.status === "running" || info?.status === "queued";
  const files = useMemo(() => info?.files ?? [], [info]);
  const selected = files.find((f) => f.file_id === selectedId) ?? null;

  const load = useCallback(async () => {
    try {
      const next = await getAnalysis(analysisId);
      setInfo(next);
      setDraft((d) => d ?? next.params);
      setSelectedId((id) => id ?? next.files?.[0]?.file_id ?? null);
    } catch (err) {
      setError(detailMessage(err, lang));
    }
  }, [analysisId, lang]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while images are being analysed.
  useEffect(() => {
    if (!busy) return;
    const handle = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(handle);
  }, [busy, load]);

  // The selected image's result, reloaded whenever it is analysed again.
  const selectedVersion = selected?.analyzed_at;
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void getCometResult(analysisId, selectedId)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [analysisId, selectedId, selectedVersion]);

  const statsVersion = files.map((f) => `${f.file_id}:${f.analyzed_at ?? 0}:${f.group}:${JSON.stringify(f.counts ?? {})}`).join("|");
  useEffect(() => {
    if (!info) return;
    void analysisSummary(analysisId, includeOutliers)
      .then(setSummary)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId, includeOutliers, statsVersion]);

  // The analysed (8-bit) channel, drawn through black/white/gamma so dim images can be seen.
  const imageUrl = selected ? analysisImageUrl(analysisId, selected.file_id, selected.analyzed_at) : null;
  useEffect(() => {
    gray.current = null;
    setImageVersion((v) => v + 1);
    if (!imageUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scratch = document.createElement("canvas");
      scratch.width = w;
      scratch.height = h;
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const data = new Uint8Array(w * h);
      const hist = new Uint32Array(256);
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        data[i] = rgba[j];
        hist[rgba[j]] += 1;
      }
      gray.current = { data, w, h, auto: autoRange(hist, data.length) };
      setImageVersion((v) => v + 1);
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const channelColor = selected?.channels?.[result?.channel ?? 0]?.color ?? [255, 255, 255];
  const imageReady = Boolean(gray.current);
  useLayoutEffect(() => {
    const g = gray.current;
    const canvas = canvasRef.current;
    if (!g || !canvas) return;
    const [lo, hi] = display.mode === "auto" ? g.auto : [display.black, Math.max(display.white, display.black + 1)];
    const color = display.pseudo ? channelColor : [255, 255, 255];
    const inv = 1 / (display.gamma || 1);
    const r = new Uint8ClampedArray(256);
    const gg = new Uint8ClampedArray(256);
    const b = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let level = (v - lo) / (hi - lo);
      level = level <= 0 ? 0 : level >= 1 ? 1 : Math.pow(level, inv);
      r[v] = level * color[0];
      gg[v] = level * color[1];
      b[v] = level * color[2];
    }
    if (canvas.width !== g.w) canvas.width = g.w;
    if (canvas.height !== g.h) canvas.height = g.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const out = ctx.createImageData(g.w, g.h);
    const px = out.data;
    for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
      const v = g.data[i];
      px[j] = r[v];
      px[j + 1] = gg[v];
      px[j + 2] = b[v];
      px[j + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, imageVersion, imageReady, channelColor.join(",")]);

  const autoLevels = gray.current?.auto ?? [0, 255];
  const shownBlack = display.mode === "auto" ? autoLevels[0] : display.black;
  const shownWhite = display.mode === "auto" ? autoLevels[1] : display.white;
  const setLevel = (patch: Partial<DisplaySettings>) =>
    setDisplay((d) => ({ ...d, black: shownBlack, white: shownWhite, ...patch, mode: "manual" }));
  // Red outlines vanish on a red image: valid comets turn cyan while the pseudo-colour is red.
  const statusColor = (s: string) => (s === "valid" && display.pseudo && isReddish(channelColor) ? "#22d3ee" : STATUS_COLOR[s]);

  const deleted = useMemo(() => new Set(result?.deleted ?? []), [result]);
  const activeComet = result?.comets.find((c) => c.key === activeKey) ?? null;

  async function toggleComet(c: Comet) {
    if (!result || !selectedId) return;
    const next = new Set(deleted);
    if (next.has(c.key)) next.delete(c.key);
    else next.add(c.key);
    setResult({ ...result, deleted: [...next] });
    await patchCometResult(analysisId, selectedId, { deleted: [...next] });
    void load();
  }

  async function applyParams(scope: "all" | "image") {
    if (!draft || !info) return;
    if (scope === "all") {
      await updateAnalysis(analysisId, { params: draft });
      await runAnalysis(analysisId);
    } else if (selectedId) {
      await patchCometResult(analysisId, selectedId, { params: draft });
    }
    void load();
  }

  async function setGroup(file: AnalysisFile, group: string) {
    if (!group.trim() || group === file.group) return;
    await updateAnalysis(analysisId, { groups: { [file.file_id]: group.trim() } });
    void load();
  }

  async function startExport() {
    setExporting(true);
    try {
      await exportAnalysis(analysisId);
      await refreshJobs();
      nav("/jobs");
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setExporting(false);
    }
  }

  const grouped = useMemo(() => {
    const out = new Map<string, AnalysisFile[]>();
    for (const f of files) out.set(f.group, [...(out.get(f.group) ?? []), f]);
    return [...out.entries()];
  }, [files]);
  const groupNames = grouped.map(([g]) => g);

  const segmented = (active: boolean) =>
    `flex h-8 items-center justify-center gap-1 rounded-lg px-2 text-sm transition-colors ${active ? "bg-[var(--bg-elev)] text-[var(--accent)] shadow-sm" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`;

  const tailIcons: Record<TailDirection, React.ReactNode> = {
    right: <ArrowRight size={15} />,
    left: <ArrowLeft size={15} />,
    up: <ArrowUp size={15} />,
    down: <ArrowDown size={15} />,
  };

  return (
    <Shell dense>
      <div className="grid min-h-[calc(100dvh-3.35rem)] grid-cols-1 lg:h-[calc(100dvh-3.35rem)] lg:min-h-0 lg:grid-cols-[290px_minmax(0,1fr)_370px]">
        {/* images */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
          <div className="border-b border-[var(--line)] px-3 py-3">
            <nav className="flex items-center gap-1 text-xs text-[var(--text-dim)]">
              <Link to="/analysis" className="hover:text-[var(--text)]">
                {t(lang, "analysisTitle")}
              </Link>
              <span>/</span>
              <Link to="/analysis/comet" className="hover:text-[var(--text)]">
                {t(lang, "cometAssay")}
              </Link>
            </nav>
            <input
              key={info?.name}
              defaultValue={info?.name ?? ""}
              onBlur={(e) => e.target.value.trim() && e.target.value !== info?.name && void updateAnalysis(analysisId, { name: e.target.value }).then(load)}
              className="mt-1.5 w-full rounded-md bg-transparent px-1 py-0.5 text-md font-semibold hover:bg-[var(--bg)] focus:bg-[var(--bg)] focus:outline-none"
              aria-label={t(lang, "analysisName")}
            />
            <p className="px-1 text-xs text-[var(--text-dim)]">
              {t(lang, "cometAssay")} · {files.length} {t(lang, "nFiles")}
            </p>
            {busy && (
              <div className="mt-2 px-1">
                <p className="flex items-center gap-1.5 text-xs text-[var(--accent)]">
                  <SpinnerGap size={12} className="animate-spin" /> {t(lang, "analyzing")} {Math.round((info?.progress ?? 0) * 100)}%
                </p>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--line)]">
                  <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.max(3, (info?.progress ?? 0) * 100)}%` }} />
                </div>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {grouped.map(([group, list], gi) => (
              <section key={group}>
                <h3 className="flex items-center gap-1.5 px-3 pb-1 pt-2.5 text-xs font-semibold text-[var(--text-dim)]">
                  <span className="h-2 w-2 rounded-full" style={{ background: GROUP_COLORS[gi % GROUP_COLORS.length] }} />
                  <span className="truncate">{group}</span>
                </h3>
                <ul>
                  {list.map((f) => (
                    <li key={f.file_id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(f.file_id);
                          setActiveKey(null);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${f.file_id === selectedId ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "hover:bg-[var(--bg)]"}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        {f.error ? (
                          <WarningCircle size={14} className="shrink-0 text-[var(--danger)]" />
                        ) : f.counts ? (
                          <span className="shrink-0 font-mono text-2xs text-[var(--text-dim)]" title={t(lang, "countedComets")}>
                            {f.counts.valid}
                            {f.counts.outlier ? `+${f.counts.outlier}` : ""}
                          </span>
                        ) : (
                          <SpinnerGap size={13} className="shrink-0 animate-spin text-[var(--text-dim)]" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="border-t border-[var(--line)] px-3 py-2 text-xs leading-4 text-[var(--text-dim)]">{t(lang, "cometClickHint")}</p>
        </Glass>

        {/* image + overlay */}
        <main className="relative flex min-h-[460px] flex-col bg-[var(--well)]">
          {error && <p className="m-3 rounded-lg bg-black/60 p-2 text-sm text-[var(--danger)]">{error}</p>}
          {selected && result?.error ? (
            <p className="m-auto max-w-md p-6 text-center text-sm text-white/70">
              {t(lang, "analysisFailed")}: {result.error}
            </p>
          ) : (
            <ZoomStage
              src={null}
              alt={selected?.name ?? ""}
              mediaReady={imageReady}
              mediaLoading={Boolean(selected) && !imageReady}
              media={<canvas ref={canvasRef} role="img" aria-label={selected?.name ?? ""} className="block max-h-none max-w-none" />}
              mediaOverlay={
                result && !result.error ? (
                  <svg viewBox={`0 0 ${result.width} ${result.height}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
                    {result.comets.map((c) => {
                      const status = deleted.has(c.key) ? "deleted" : c.status;
                      const color = statusColor(status);
                      const pts = (c.hull ?? c.outline).map((p) => p.join(",")).join(" ");
                      const active = c.key === activeKey;
                      return (
                        <g
                          key={c.key}
                          data-no-pan
                          style={{ pointerEvents: "auto", cursor: "pointer" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveKey(c.key);
                            if (e.altKey || e.detail === 2) return;
                            if (c.status !== "invalid") void toggleComet(c);
                          }}
                          onMouseEnter={() => setActiveKey(c.key)}
                        >
                          <polygon
                            points={pts}
                            fill={active ? `${color}22` : "transparent"}
                            stroke={color}
                            strokeWidth={active ? 2.5 : 1.5}
                            strokeDasharray={status === "deleted" ? "6 4" : undefined}
                            vectorEffect="non-scaling-stroke"
                          />
                          {c.head && status !== "invalid" && (
                            <circle cx={c.head.cx} cy={c.head.cy} r={c.head.r} fill="none" stroke={status === "deleted" ? color : "#22c55e"} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
                          )}
                          {c.num && (
                            <text
                              x={Math.max(...(c.hull ?? c.outline).map((p) => p[0])) + 4}
                              y={Math.min(...(c.hull ?? c.outline).map((p) => p[1])) + 14}
                              fill={color}
                              fontSize={Math.max(12, result.width / 70)}
                              fontWeight={600}
                            >
                              {c.num}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                ) : null
              }
            >
              <div className="absolute left-3 top-3 z-20 flex flex-wrap gap-1.5 rounded-xl bg-black/60 px-2.5 py-1.5 text-xs text-white/80 backdrop-blur">
                {(["valid", "outlier", "invalid", "deleted"] as const).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-sm border" style={{ borderColor: statusColor(s), borderStyle: s === "deleted" ? "dashed" : "solid" }} />
                    {t(lang, `status_${s}` as MsgKey)}
                    {selected?.counts ? ` ${selected.counts[s]}` : ""}
                  </span>
                ))}
              </div>
              <div
                className="absolute right-3 top-3 z-20 grid w-56 gap-1.5 rounded-xl bg-black/70 px-3 py-2.5 text-xs text-white/85 backdrop-blur"
                title={t(lang, "displayHint")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-medium">
                    <SunDim size={14} /> {t(lang, "displayAdjust")}
                  </span>
                  <span className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setDisplay((d) => ({ ...d, mode: "auto" }))}
                      aria-pressed={display.mode === "auto"}
                      className={`rounded-md px-1.5 py-0.5 ${display.mode === "auto" ? "bg-sky-400 text-slate-950" : "hover:bg-white/10"}`}
                    >
                      {t(lang, "autoContrast")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDisplay((d) => ({ ...d, pseudo: !d.pseudo }))}
                      aria-pressed={display.pseudo}
                      className={`rounded-md px-1.5 py-0.5 ${display.pseudo ? "bg-white text-slate-950" : "hover:bg-white/10"}`}
                    >
                      {t(lang, "pseudoColor")}
                    </button>
                    <button type="button" onClick={() => setDisplay(DEFAULT_DISPLAY)} className="rounded-md px-1.5 py-0.5 hover:bg-white/10">
                      {t(lang, "resetDisplay")}
                    </button>
                  </span>
                </div>
                {(
                  [
                    ["blackPoint", shownBlack, 0, 254, 1, (v: number) => setLevel({ black: Math.min(v, shownWhite - 1) })],
                    ["whitePoint", shownWhite, 1, 255, 1, (v: number) => setLevel({ white: Math.max(v, shownBlack + 1) })],
                    ["gammaLabel", display.gamma, 0.3, 3, 0.05, (v: number) => setDisplay((d) => ({ ...d, gamma: v }))],
                  ] as const
                ).map(([label, value, min, max, step, onChange]) => (
                  <label key={label} className="grid grid-cols-[3rem_minmax(0,1fr)_2.2rem] items-center gap-2">
                    <span className="text-white/60">{t(lang, label)}</span>
                    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="stage-zoom-slider" />
                    <span className="text-right font-mono tabular-nums">{label === "gammaLabel" ? value.toFixed(2) : value}</span>
                  </label>
                ))}
              </div>
            </ZoomStage>
          )}
        </main>

        {/* parameters, comet, statistics */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col overflow-auto border-t lg:border-l lg:border-t-0">
          <section className="border-b border-[var(--line)] p-4">
            <h2 className="text-sm font-semibold">{t(lang, "analysisParams")}</h2>
            {draft && (
              <div className="mt-3 grid gap-3 text-sm">
                <label className="grid gap-1 text-[var(--text-dim)]">
                  {t(lang, "cometChannel")}
                  <select
                    value={draft.channel ?? ""}
                    onChange={(e) => setDraft({ ...draft, channel: e.target.value === "" ? null : Number(e.target.value) })}
                    className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[var(--text)]"
                  >
                    <option value="">{t(lang, "channelAuto")}</option>
                    {(selected?.channels ?? []).map((ch) => (
                      <option key={ch.index} value={ch.index}>
                        {ch.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-1 text-[var(--text-dim)]">
                  {t(lang, "tailDirection")}
                  <div className="grid grid-cols-4 gap-0.5 rounded-lg bg-[var(--bg)] p-0.5">
                    {(["right", "left", "up", "down"] as const).map((d) => (
                      <button key={d} type="button" onClick={() => setDraft({ ...draft, tail: d })} className={segmented(draft.tail === d)} title={t(lang, `tail_${d}` as MsgKey)}>
                        {tailIcons[d]}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="grid gap-1 text-[var(--text-dim)]">
                  {t(lang, "headFinding")}
                  <select
                    value={draft.head_mode}
                    onChange={(e) => setDraft({ ...draft, head_mode: e.target.value as CometParams["head_mode"] })}
                    className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[var(--text)]"
                  >
                    <option value="auto">{t(lang, "headAuto")}</option>
                    <option value="profile">{t(lang, "headProfile")}</option>
                    <option value="brightest">{t(lang, "headBrightest")}</option>
                  </select>
                </label>
                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={draft.background_correction} onChange={(e) => setDraft({ ...draft, background_correction: e.target.checked })} />
                    {t(lang, "bgCorrection")}
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-[var(--text-dim)]">
                    {t(lang, "minArea")}
                    <input
                      type="number"
                      min={16}
                      step={50}
                      value={draft.min_area}
                      onChange={(e) => setDraft({ ...draft, min_area: Math.max(16, Number(e.target.value) || 400) })}
                      className="h-8 w-20 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-right font-mono text-[var(--text)]"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" disabled={busy} onClick={() => void applyParams("all")} className="primary-action min-h-9 px-2 disabled:opacity-50">
                    <ArrowClockwise size={15} className="shrink-0" />
                    {t(lang, "reanalyzeAll")}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !selected}
                    onClick={() => void applyParams("image")}
                    className="inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-2 text-sm font-medium hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                  >
                    {t(lang, "onlyThisImage")}
                  </button>
                </div>
                {selected?.override && (
                  <p className="flex items-center justify-between gap-2 rounded-lg bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs text-[var(--accent)]">
                    {t(lang, "imageHasOverride")}
                    <button type="button" onClick={() => void patchCometResult(analysisId, selected.file_id, { reset_params: true }).then(load)} className="underline">
                      {t(lang, "useAnalysisParams")}
                    </button>
                  </p>
                )}
              </div>
            )}
          </section>

          {selected && (
            <section className="border-b border-[var(--line)] p-4">
              <label className="grid gap-1 text-sm text-[var(--text-dim)]">
                {t(lang, "imageGroup")}
                <input
                  key={`${selected.file_id}:${selected.group}`}
                  defaultValue={selected.group}
                  list="analysis-groups"
                  onBlur={(e) => void setGroup(selected, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[var(--text)]"
                />
                <datalist id="analysis-groups">
                  {groupNames.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
              {activeComet?.metrics ? (
                <div className="mt-4">
                  <h3 className="flex items-center justify-between text-sm font-semibold">
                    <span>
                      {t(lang, "cometNo")} {activeComet.num}
                    </span>
                    <span className="text-xs font-normal" style={{ color: STATUS_COLOR[deleted.has(activeComet.key) ? "deleted" : activeComet.status] }}>
                      {t(lang, `status_${deleted.has(activeComet.key) ? "deleted" : activeComet.status}` as MsgKey)}
                    </span>
                  </h3>
                  <ProfileChart comet={activeComet} lang={lang} />
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-xs">
                    {DETAIL_METRICS.map((k) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="truncate text-[var(--text-dim)]">{k}</dt>
                        <dd className="tabular-nums">{fmt(activeComet.metrics?.[k])}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : activeComet ? (
                <p className="mt-3 text-xs text-[var(--text-dim)]">
                  {t(lang, "status_invalid")}: {activeComet.reasons.join(", ")}
                </p>
              ) : (
                <p className="mt-3 text-xs text-[var(--text-dim)]">{t(lang, "cometHoverHint")}</p>
              )}
            </section>
          )}

          <section className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t(lang, "groupStats")}</h2>
              <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-dim)]">
                <input type="checkbox" checked={includeOutliers} onChange={(e) => setIncludeOutliers(e.target.checked)} />
                {t(lang, "includeOutliers")}
              </label>
            </div>
            {summary && summary.groups.length > 0 ? (
              <>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--line)] text-xs text-[var(--text-dim)]">
                        <th className="px-2 py-1 text-left font-medium">{t(lang, "group")}</th>
                        <th className="px-2 py-1 text-right font-medium">n</th>
                        <th className="px-2 py-1 text-right font-medium">{t(lang, METRIC_LABEL[plotMetric])}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.groups.map((g, gi) => (
                        <tr key={g.group} className="border-b border-[var(--line)]/60">
                          <td className="max-w-[9rem] truncate px-2 py-1.5" title={g.group}>
                            <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: GROUP_COLORS[gi % GROUP_COLORS.length] }} />
                            {g.group}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-xs">{g.metrics[plotMetric]?.n ?? 0}</td>
                          <StatCell stat={g.metrics[plotMetric]} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {METRIC_KEYS.slice(0, 3).map((m) => (
                    <button key={m} type="button" onClick={() => setPlotMetric(m)} className={`rounded-md px-2 py-1 text-xs ${plotMetric === m ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--text-dim)] hover:bg-[var(--bg)]"}`}>
                      {t(lang, METRIC_LABEL[m])}
                    </button>
                  ))}
                </div>
                <div className="mt-2">
                  <BoxPlot summary={summary} metric={plotMetric} />
                </div>
                <p className="mt-1 text-2xs leading-4 text-[var(--text-dim)]">{t(lang, "statsHint")}</p>
              </>
            ) : (
              <p className="mt-3 text-xs text-[var(--text-dim)]">{busy ? t(lang, "analyzing") : t(lang, "noComets")}</p>
            )}
            <button type="button" disabled={exporting || busy} onClick={() => void startExport()} className="primary-action mt-4 w-full min-h-10 disabled:opacity-50">
              <ExportIcon size={16} className="shrink-0" />
              {t(lang, "exportAnalysis")}
            </button>
          </section>
        </Glass>
      </div>
    </Shell>
  );
}
