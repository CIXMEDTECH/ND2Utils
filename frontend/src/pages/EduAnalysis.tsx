import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Export as ExportIcon, Eye, EyeSlash, SpinnerGap, SunDim, WarningCircle } from "@phosphor-icons/react";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { ZoomStage } from "../components/ZoomStage";
import {
  Advanced,
  GROUP_COLORS,
  ParamCheck,
  ParamNumber,
  ParamSelect,
  PreviewBar,
  SetupBanner,
  StatCell,
  ToolPage,
  UnpairedList,
  fmt,
  sameParams,
  useDraftPreview,
} from "../components/analysis/shared";
import { t, type MsgKey } from "../i18n";
import {
  EDU_CLASSIFY_KEYS,
  EDU_DEFAULTS,
  analysisImageUrl,
  eduSummary,
  exportAnalysis,
  getAnalysis,
  getAnalysisResult,
  patchAnalysisResult,
  runAnalysis,
  updateAnalysis,
  type AnalysisFile,
  type AnalysisInfo,
  type EduGroupSummary,
  type EduParams,
  type EduResult,
  type EduSummary,
} from "../lib/api";
import { DEFAULT_LEVELS, drawLayers, levelRange, useGrayImage, type Levels } from "../lib/analysisCanvas";
import { detailMessage } from "../lib/format";
import { useApp } from "../store";

type Flag = "positive" | "negative" | "excluded";
const FLAG_COLOR: Record<Flag, string> = { positive: "#facc15", negative: "rgba(203,213,225,0.6)", excluded: "#64748b" };
const OBJECT_COLOR = "#ec4899";
const NUCLEUS_COLOR = [40, 120, 255];

/** /analysis/edu: EdU analyses and "new". */
export function EduTool() {
  return <ToolPage type="edu" />;
}

const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${(100 * v).toFixed(digits)}%`);

function pickClassify(p: EduParams): Partial<EduParams> {
  const out: Record<string, unknown> = {};
  for (const k of EDU_CLASSIFY_KEYS) out[k] = p[k];
  return out as Partial<EduParams>;
}

/** Normalised EdU display colour (white / missing → green). */
function eduColor(c: number[] | undefined): number[] {
  if (!c || c.length < 3 || Math.max(...c) === 0 || Math.min(...c) > 200) return [0, 255, 0];
  return c.slice(0, 3);
}

function thresholdFor(params: EduParams, res: EduResult | null, pooled: Record<string, number | null> | undefined, preview: boolean): number | null {
  if (params.edu_method === "manual") return params.edu_threshold;
  const own = res?.auto_thresholds?.[params.edu_method] ?? null;
  if (preview || params.edu_scope === "image") return own;
  return pooled?.[params.edu_method] ?? own;
}

function classify(res: EduResult | null, threshold: number | null, marks: Record<string, Flag>): Flag[] {
  return (res?.nuclei ?? []).map((n) => marks[String(n.key)] ?? (threshold !== null && n.edu > threshold ? "positive" : "negative"));
}

// --- charts ----------------------------------------------------------------------------------

/** Per-nucleus EdU means (log scale) with the threshold; drag to set a manual threshold. */
function EduHistogram({ values, threshold, onThreshold }: { values: number[]; threshold: number | null; onThreshold: (v: number) => void }) {
  const lang = useApp((s) => s.lang);
  const w = 320;
  const h = 96;
  const bins = 64;
  const max = Math.max(1, ...values);
  const lmax = Math.log1p(max);
  const counts = useMemo(() => {
    const out = new Array(bins).fill(0) as number[];
    for (const v of values) out[Math.min(bins - 1, Math.floor((Math.log1p(Math.max(0, v)) / lmax) * bins))] += 1;
    return out;
  }, [values, lmax]);
  const top = Math.sqrt(Math.max(1, ...counts));
  const x = (v: number) => (Math.log1p(Math.max(0, v)) / lmax) * w;
  const drag = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  function valueAt(clientX: number) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return null;
    const frac = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return Number(Math.expm1(frac * lmax).toFixed(2));
  }
  const ticks = [0, 10, 100, 1000, 10000, 65535].filter((v) => v <= max * 1.01);
  return (
    <figure>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h + 14}`}
        className="w-full cursor-ew-resize touch-none select-none rounded-lg bg-[var(--bg)]"
        role="img"
        aria-label={t(lang, "eduHistogram")}
        onPointerDown={(e) => {
          drag.current = true;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const v = valueAt(e.clientX);
          if (v !== null) onThreshold(v);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const v = valueAt(e.clientX);
          if (v !== null) onThreshold(v);
        }}
        onPointerUp={() => {
          drag.current = false;
        }}
      >
        {counts.map((c, i) => {
          const bh = (Math.sqrt(c) / top) * (h - 4);
          const x0 = (i / bins) * w;
          const v0 = Math.expm1((i / bins) * lmax);
          const above = threshold !== null && v0 >= threshold;
          return <rect key={i} x={x0 + 0.5} y={h - bh} width={w / bins - 1} height={bh} fill={above ? "#facc15" : "var(--text-dim)"} opacity={above ? 0.9 : 0.45} />;
        })}
        {ticks.map((v) => (
          <text key={v} x={Math.min(w - 2, x(v) + 1)} y={h + 11} fontSize={8} fill="var(--text-dim)" textAnchor={v === 0 ? "start" : "middle"}>
            {v}
          </text>
        ))}
        {threshold !== null && (
          <g>
            <line x1={x(threshold)} x2={x(threshold)} y1={0} y2={h} stroke="#ef4444" strokeWidth={1.5} />
            <rect x={x(threshold) - 3} y={0} width={6} height={10} rx={2} fill="#ef4444" />
          </g>
        )}
      </svg>
      <figcaption className="mt-1 text-2xs leading-4 text-[var(--text-dim)]">{t(lang, "eduHistogramHint")}</figcaption>
    </figure>
  );
}

/** Mean ± SD per group with one dot per field. */
function PercentPlot({ groups, independent }: { groups: EduGroupSummary[]; independent: boolean }) {
  const rows = groups.filter((g) => (independent ? g.values_independent : g.values).length);
  if (!rows.length) return null;
  const all = rows.flatMap((g) => (independent ? g.values_independent : g.values));
  const max = Math.min(100, Math.max(5, ...all.map((v) => v * 1.15), ...rows.map((g) => ((independent ? g.percent_independent : g.percent).mean ?? 0) + ((independent ? g.percent_independent : g.percent).sd ?? 0))));
  const w = 320;
  const h = 170;
  const left = 30;
  const bottom = 26;
  const plotH = h - bottom - 8;
  const bandW = (w - left - 6) / rows.length;
  const y = (v: number) => 8 + plotH - (Math.min(v, max) / max) * plotH;
  const ticks = [0, max / 2, max].map((v) => Number(v.toPrecision(2)));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img">
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={left} x2={w - 4} y1={y(tk)} y2={y(tk)} stroke="var(--line)" strokeWidth={1} />
          <text x={left - 4} y={y(tk) + 3} textAnchor="end" fontSize={9} fill="var(--text-dim)">
            {tk}%
          </text>
        </g>
      ))}
      {rows.map((g, gi) => {
        const st = independent ? g.percent_independent : g.percent;
        const vals = independent ? g.values_independent : g.values;
        const cx = left + bandW * gi + bandW / 2;
        const bw = Math.min(40, bandW * 0.5);
        const color = GROUP_COLORS[gi % GROUP_COLORS.length];
        const mean = st.mean ?? 0;
        const sd = st.sd ?? 0;
        return (
          <g key={g.group}>
            <rect x={cx - bw / 2} y={y(mean)} width={bw} height={Math.max(0, y(0) - y(mean))} fill={`${color}33`} stroke={color} />
            {sd > 0 && (
              <g stroke={color} strokeWidth={1.2}>
                <line x1={cx} x2={cx} y1={y(mean + sd)} y2={y(Math.max(0, mean - sd))} />
                <line x1={cx - 5} x2={cx + 5} y1={y(mean + sd)} y2={y(mean + sd)} />
              </g>
            )}
            {vals.map((v, i) => (
              <circle key={i} cx={cx + (((i * 37) % 17) / 17 - 0.5) * bw * 0.8} cy={y(v)} r={2.2} fill={color} opacity={0.85} />
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

// --- overlay ---------------------------------------------------------------------------------

const pointsOf = (outline: number[]) => {
  let out = "";
  for (let i = 0; i + 1 < outline.length; i += 2) out += `${outline[i]},${outline[i + 1]} `;
  return out;
};

/** All outlines at once (thousands): memoised, events delegated through data-key. */
const Outlines = memo(function Outlines({
  res,
  flags,
  marks,
  mode,
  deleted,
  dashed,
}: {
  res: EduResult;
  flags: Flag[];
  marks: Record<string, Flag>;
  mode: EduParams["count_mode"];
  deleted: Set<number>;
  dashed: boolean;
}) {
  if (mode === "independent") {
    return (
      <>
        {res.nuclei.map((n) => (
          <polygon key={`n${n.key}`} points={pointsOf(n.outline)} fill="none" stroke="rgba(203,213,225,0.3)" strokeWidth={0.8} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
        ))}
        {res.edu_objects.map((o) => {
          const gone = deleted.has(o.key);
          return (
            <polygon
              key={`o${o.key}`}
              data-key={o.key}
              points={pointsOf(o.outline)}
              fill="transparent"
              stroke={gone ? "#64748b" : OBJECT_COLOR}
              strokeWidth={1.4}
              strokeDasharray={gone || dashed ? "4 3" : undefined}
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: "auto", cursor: "pointer" }}
            />
          );
        })}
      </>
    );
  }
  return (
    <>
      {res.nuclei.map((n, i) => {
        const f = flags[i];
        const manual = String(n.key) in marks;
        return (
          <polygon
            key={n.key}
            data-key={n.key}
            points={pointsOf(n.outline)}
            fill="transparent"
            stroke={FLAG_COLOR[f]}
            strokeWidth={manual ? 2.2 : f === "positive" ? 1.5 : 1}
            strokeDasharray={f === "excluded" ? "4 3" : dashed ? "2 2" : undefined}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: "auto", cursor: "pointer" }}
          />
        );
      })}
    </>
  );
});

// --- detail ------------------------------------------------------------------------------------

interface ChannelView extends Levels {
  visible: boolean;
}

export function EduDetail() {
  const { analysisId = "" } = useParams();
  const lang = useApp((s) => s.lang);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const nav = useNavigate();
  const [info, setInfo] = useState<AnalysisInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<EduResult | null>(null);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [summary, setSummary] = useState<EduSummary | null>(null);
  const [draft, setDraft] = useState<EduParams | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showUnpaired, setShowUnpaired] = useState(false);
  const [views, setViews] = useState<{ nucleus: ChannelView; edu: ChannelView; outlines: boolean }>({
    nucleus: { ...DEFAULT_LEVELS, visible: true },
    edu: { ...DEFAULT_LEVELS, visible: true },
    outlines: true,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const busy = info?.status === "running" || info?.status === "queued";
  const files = useMemo(() => info?.files ?? [], [info]);
  const selected = files.find((f) => f.file_id === selectedId) ?? null;
  const saved = useMemo(() => (info ? { ...EDU_DEFAULTS, ...(info.params as EduParams) } : null), [info]);
  const neverRun = files.length > 0 && !busy && files.every((f) => !f.analyzed);

  const load = useCallback(async () => {
    try {
      const next = await getAnalysis(analysisId);
      if (next.type !== "edu") {
        nav(`/analysis/${next.type}/${analysisId}`, { replace: true });
        return;
      }
      setInfo(next);
      setDraft((d) => d ?? { ...EDU_DEFAULTS, ...(next.params as EduParams) });
      setSelectedId((id) => (id && next.files?.some((f) => f.file_id === id) ? id : (next.files?.[0]?.file_id ?? null)));
    } catch (err) {
      setError(detailMessage(err, lang));
    }
  }, [analysisId, lang, nav]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!busy) return;
    const handle = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(handle);
  }, [busy, load]);

  const selectedVersion = selected?.analyzed_at;
  useEffect(() => {
    setResult(null);
    if (!selectedId) return;
    let cancelled = false;
    void getAnalysisResult<EduResult>(analysisId, selectedId)
      .then((res) => !cancelled && setResult(res))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [analysisId, selectedId, selectedVersion]);

  const pv = useDraftPreview<EduResult>({
    analysisId,
    fileId: selectedId,
    draft,
    saved,
    hasResult: Boolean(selected?.analyzed),
    ignore: EDU_CLASSIFY_KEYS,
    enabled: !busy,
  });
  const isPreview = Boolean(pv.preview);
  const shown: EduResult | null = pv.preview ?? result;

  // Threshold, counting mode and scope only reclassify: saved right away (no new segmentation).
  const classifyKey = draft ? JSON.stringify(pickClassify(draft)) : "";
  useEffect(() => {
    if (!draft || !saved || sameParams(pickClassify(draft), pickClassify(saved))) return;
    const handle = window.setTimeout(() => {
      void updateAnalysis(analysisId, { params: pickClassify(draft) })
        .then((next) => setInfo(next))
        .catch((err) => setError(detailMessage(err, lang)));
    }, 450);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifyKey]);

  const statsVersion = `${info?.updated_at}:${files.map((f) => `${f.file_id}:${f.analyzed_at ?? 0}:${f.group}:${f.counts?.positive}:${f.counts?.nuclei}:${f.counts?.independent}`).join("|")}`;
  useEffect(() => {
    if (!info) return;
    void eduSummary(analysisId)
      .then(setSummary)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId, statsVersion]);

  // Images: nuclear stain (blue) + EdU (its channel colour), each with its own levels.
  const version = selected?.analyzed_at ?? 0;
  const nucGray = useGrayImage(selected ? analysisImageUrl(analysisId, selected.file_id, version, { role: "nucleus" }) : null);
  const eduGray = useGrayImage(selected ? analysisImageUrl(analysisId, selected.file_id, version, { role: "edu" }) : null);
  const eduRgb = eduColor(shown?.edu?.color ?? selected?.partner?.channels?.[0]?.color);
  const ready = Boolean(nucGray && eduGray);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !nucGray || !eduGray) return;
    drawLayers(canvas, [
      { gray: nucGray, color: NUCLEUS_COLOR, levels: views.nucleus, visible: views.nucleus.visible },
      { gray: eduGray, color: eduRgb, levels: views.edu, visible: views.edu.visible },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nucGray, eduGray, views.nucleus, views.edu, eduRgb.join(",")]);

  const params = draft ?? EDU_DEFAULTS;
  const threshold = thresholdFor(params, shown, info?.pooled_thresholds, isPreview);
  const marks = useMemo(() => (isPreview ? {} : ((result?.marks ?? {}) as Record<string, Flag>)), [isPreview, result]);
  const flags = useMemo(() => classify(shown, threshold, marks), [shown, threshold, marks]);
  const deleted = useMemo(() => new Set(isPreview ? [] : (result?.edu_deleted ?? [])), [isPreview, result]);
  const counts = useMemo(() => {
    const nuclei = flags.filter((f) => f !== "excluded").length;
    const positive = flags.filter((f) => f === "positive").length;
    const independent = (shown?.edu_objects.length ?? 0) - deleted.size;
    return { nuclei, positive, independent, excluded: flags.length - nuclei };
  }, [flags, shown, deleted]);
  const mode = params.count_mode;
  const ratio = counts.nuclei ? (mode === "independent" ? counts.independent : counts.positive) / counts.nuclei : null;
  const means = useMemo(() => (shown?.nuclei ?? []).map((n) => n.edu), [shown]);

  async function saveMarks(next: Record<string, Flag>) {
    if (!result || !selectedId) return;
    setResult({ ...result, marks: next });
    await patchAnalysisResult(analysisId, selectedId, { marks: next });
    void load();
  }

  async function saveDeleted(next: Set<number>) {
    if (!result || !selectedId) return;
    setResult({ ...result, edu_deleted: [...next] });
    await patchAnalysisResult(analysisId, selectedId, { edu_deleted: [...next] });
    void load();
  }

  function onTap(el: Element, e: React.PointerEvent) {
    const key = Number(el.getAttribute("data-key"));
    if (!key || isPreview || !result) return;
    setActiveKey(key);
    if (mode === "independent") {
      const next = new Set(deleted);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      void saveDeleted(next);
      return;
    }
    const index = result.nuclei.findIndex((n) => n.key === key);
    if (index < 0) return;
    const current = flags[index];
    const auto: Flag = threshold !== null && result.nuclei[index].edu > threshold ? "positive" : "negative";
    const next = { ...marks };
    let target: Flag;
    if (e.altKey || e.shiftKey) target = current === "excluded" ? auto : "excluded";
    else target = current === "excluded" ? auto : current === "positive" ? "negative" : "positive";
    if (target === auto) delete next[String(key)];
    else next[String(key)] = target;
    void saveMarks(next);
  }

  function onOverlayMove(e: React.MouseEvent<SVGSVGElement>) {
    const key = Number((e.target as Element).getAttribute("data-key")) || null;
    if (key && key !== activeKey) setActiveKey(key);
  }

  async function applyAll() {
    if (!draft) return;
    await updateAnalysis(analysisId, { params: draft });
    await runAnalysis(analysisId);
    void load();
  }

  async function applyImage() {
    if (!draft || !selectedId) return;
    await patchAnalysisResult(analysisId, selectedId, { params: { ...draft } });
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
  const set = (patch: Partial<EduParams>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const segmented = (active: boolean) =>
    `flex h-8 items-center justify-center rounded-lg px-2 text-sm transition-colors ${active ? "bg-[var(--bg-elev)] text-[var(--accent)] shadow-sm" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`;
  const multiChannel = Boolean(selected && !selected.partner && selected.channels.length >= 2);
  const activeNucleus = mode !== "independent" ? (shown?.nuclei.find((n) => n.key === activeKey) ?? null) : null;
  const activeObject = mode === "independent" ? (shown?.edu_objects.find((o) => o.key === activeKey) ?? null) : null;
  const activeFlag = activeNucleus && shown ? flags[shown.nuclei.indexOf(activeNucleus)] : null;
  const um = shown?.um_per_px ?? null;
  const segOptions = [
    { value: "otsu" as const, label: "Otsu" },
    { value: "li" as const, label: "Li" },
    { value: "triangle" as const, label: "Triangle" },
    { value: "manual" as const, label: t(lang, "manual") },
  ];
  const fieldRatio = (f: AnalysisFile) => (mode === "independent" ? f.counts?.ratio_independent : f.counts?.ratio);

  const channelPanel = (key: "nucleus" | "edu", label: string, color: number[], gray: typeof nucGray) => {
    const v = views[key];
    const auto = gray ? levelRange(gray, { ...v, mode: "auto" }) : [0, 255];
    const black = v.mode === "auto" ? auto[0] : v.black;
    const white = v.mode === "auto" ? auto[1] : v.white;
    const patch = (p: Partial<ChannelView>) => setViews((s) => ({ ...s, [key]: { ...s[key], black, white, ...p, mode: "manual" } }));
    return (
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => setViews((s) => ({ ...s, [key]: { ...s[key], visible: !s[key].visible } }))} className="inline-flex items-center gap-1.5" aria-pressed={v.visible}>
            {v.visible ? <Eye size={13} /> : <EyeSlash size={13} />}
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${color.join(",")})` }} />
            <span className="max-w-[7rem] truncate">{label}</span>
          </button>
          <button
            type="button"
            onClick={() => setViews((s) => ({ ...s, [key]: { ...s[key], mode: "auto" } }))}
            className={`rounded-md px-1.5 py-0.5 ${v.mode === "auto" ? "bg-sky-400 text-slate-950" : "hover:bg-white/10"}`}
          >
            {t(lang, "autoContrast")}
          </button>
        </div>
        {(
          [
            ["blackPoint", black, 0, 254, (n: number) => patch({ black: Math.min(n, white - 1) })],
            ["whitePoint", white, 1, 255, (n: number) => patch({ white: Math.max(n, black + 1) })],
          ] as const
        ).map(([lbl, value, min, max, onChange]) => (
          <label key={lbl} className="grid grid-cols-[2.6rem_minmax(0,1fr)_1.8rem] items-center gap-2">
            <span className="text-white/60">{t(lang, lbl)}</span>
            <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="stage-zoom-slider" />
            <span className="text-right font-mono tabular-nums">{value}</span>
          </label>
        ))}
      </div>
    );
  };

  return (
    <Shell dense>
      <div className="grid min-h-[calc(100dvh-3.35rem)] grid-cols-1 lg:h-[calc(100dvh-3.35rem)] lg:min-h-0 lg:grid-cols-[290px_minmax(0,1fr)_380px]">
        {/* fields */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
          <div className="border-b border-[var(--line)] px-3 py-3">
            <nav className="flex items-center gap-1 text-xs text-[var(--text-dim)]">
              <Link to="/analysis" className="hover:text-[var(--text)]">
                {t(lang, "analysisTitle")}
              </Link>
              <span>/</span>
              <Link to="/analysis/edu" className="hover:text-[var(--text)]">
                {t(lang, "eduAssay")}
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
              {t(lang, "eduAssay")} · {files.length} {t(lang, "nFields")}
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
            {(info?.unpaired?.length ?? 0) > 0 && (
              <div className="mt-2 rounded-lg bg-[color-mix(in_srgb,var(--warning,#f59e0b)_14%,transparent)] px-2 py-1.5 text-xs">
                <button type="button" onClick={() => setShowUnpaired((v) => !v)} className="flex w-full items-center gap-1.5 text-left">
                  <WarningCircle size={13} className="shrink-0" />
                  {info?.unpaired?.length} {t(lang, "filesUnpaired")}
                </button>
                {showUnpaired && <UnpairedList items={info?.unpaired ?? []} />}
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
                        title={f.partner ? `${f.file_name} + ${f.partner.name}` : f.file_name}
                      >
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        {f.error ? (
                          <WarningCircle size={14} className="shrink-0 text-[var(--danger)]" />
                        ) : f.counts ? (
                          <span className="shrink-0 font-mono text-2xs text-[var(--text-dim)]">
                            {mode === "independent" ? f.counts.independent : f.counts.positive}/{f.counts.nuclei} · {pct(fieldRatio(f), 0)}
                          </span>
                        ) : busy ? (
                          <SpinnerGap size={13} className="shrink-0 animate-spin text-[var(--text-dim)]" />
                        ) : (
                          <span className="shrink-0 text-2xs text-[var(--text-dim)]">{t(lang, "notAnalyzed")}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="border-t border-[var(--line)] px-3 py-2 text-xs leading-4 text-[var(--text-dim)]">{t(lang, mode === "independent" ? "eduClickHintIndependent" : "eduClickHint")}</p>
        </Glass>

        {/* image + overlay */}
        <main className="relative flex min-h-[460px] flex-col bg-[var(--well)]">
          {error && <p className="m-3 rounded-lg bg-black/60 p-2 text-sm text-[var(--danger)]">{error}</p>}
          {selected && shown?.error ? (
            <p className="m-auto max-w-md p-6 text-center text-sm text-white/70">
              {t(lang, "analysisFailed")}: {shown.error}
            </p>
          ) : (
            <ZoomStage
              src={null}
              alt={selected?.name ?? ""}
              mediaReady={ready}
              mediaLoading={Boolean(selected) && !ready}
              onTap={onTap}
              media={<canvas ref={canvasRef} role="img" aria-label={selected?.name ?? ""} className="block max-h-none max-w-none" />}
              mediaOverlay={
                shown && !shown.error && views.outlines ? (
                  <svg viewBox={`0 0 ${shown.width} ${shown.height}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none" onMouseMove={onOverlayMove}>
                    <Outlines res={shown} flags={flags} marks={marks} mode={mode} deleted={deleted} dashed={isPreview} />
                    {(activeNucleus || activeObject) && (
                      <polygon
                        points={pointsOf((activeNucleus ?? activeObject)!.outline)}
                        fill="rgba(255,255,255,0.12)"
                        stroke="#fff"
                        strokeWidth={2.4}
                        vectorEffect="non-scaling-stroke"
                        style={{ pointerEvents: "none" }}
                      />
                    )}
                  </svg>
                ) : null
              }
            >
              <div className="absolute left-3 top-3 z-20 flex flex-wrap items-center gap-2 rounded-xl bg-black/60 px-2.5 py-1.5 text-xs text-white/85 backdrop-blur">
                {isPreview && <span className="rounded-md bg-sky-400 px-1.5 py-0.5 font-medium text-slate-950">{t(lang, "previewBadge")}</span>}
                {shown && (
                  <>
                    <span>
                      {t(lang, "eduNuclei")} <b className="font-mono">{counts.nuclei}</b>
                    </span>
                    {mode === "independent" ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2.5 w-2.5 rounded-sm border" style={{ borderColor: OBJECT_COLOR }} />
                        {t(lang, "eduObjects")} <b className="font-mono">{counts.independent}</b>
                      </span>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm border" style={{ borderColor: FLAG_COLOR.positive }} />
                          EdU+ <b className="font-mono">{counts.positive}</b>
                        </span>
                        {counts.excluded > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <span className="h-2.5 w-2.5 rounded-sm border border-dashed" style={{ borderColor: FLAG_COLOR.excluded }} />
                            {t(lang, "excluded")} {counts.excluded}
                          </span>
                        )}
                      </>
                    )}
                    <b className="font-mono text-white">{pct(ratio)}</b>
                  </>
                )}
              </div>
              <div className="absolute right-3 top-3 z-20 grid w-56 gap-2 rounded-xl bg-black/70 px-3 py-2.5 text-xs text-white/85 backdrop-blur" title={t(lang, "displayHint")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-medium">
                    <SunDim size={14} /> {t(lang, "displayAdjust")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setViews((s) => ({ ...s, outlines: !s.outlines }))}
                    aria-pressed={views.outlines}
                    className={`rounded-md px-1.5 py-0.5 ${views.outlines ? "bg-white text-slate-950" : "hover:bg-white/10"}`}
                  >
                    {t(lang, "outlines")}
                  </button>
                </div>
                {channelPanel("nucleus", shown?.nucleus?.channel_name ?? "DAPI", NUCLEUS_COLOR, nucGray)}
                {channelPanel("edu", shown?.edu?.channel_name ?? "EdU", eduRgb, eduGray)}
              </div>
            </ZoomStage>
          )}
        </main>

        {/* parameters, statistics */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col overflow-auto border-t lg:border-l lg:border-t-0">
          <section className="grid gap-3 border-b border-[var(--line)] p-4">
            <h2 className="text-sm font-semibold">{t(lang, "analysisParams")}</h2>
            {neverRun && <SetupBanner count={files.length} unit={t(lang, "nFields")} busy={busy} onStart={() => void applyAll()} />}
            {draft && (
              <>
                <div className="grid gap-1 text-sm text-[var(--text-dim)]">
                  {t(lang, "countMode")}
                  <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-[var(--bg)] p-0.5">
                    {(["nucleus", "independent"] as const).map((m) => (
                      <button key={m} type="button" onClick={() => set({ count_mode: m })} className={segmented(draft.count_mode === m)} title={t(lang, `countMode_${m}_hint` as MsgKey)}>
                        {t(lang, `countMode_${m}` as MsgKey)}
                      </button>
                    ))}
                  </div>
                </div>
                <ParamSelect
                  label={t(lang, "eduChannelColor")}
                  value={draft.edu_kind}
                  onChange={(v) => set({ edu_kind: v })}
                  hint={t(lang, "eduChannelColorHint")}
                  options={(["auto", "green", "red", "farred"] as const).map((k) => ({ value: k, label: t(lang, `eduKind_${k}` as MsgKey) }))}
                />
                {multiChannel && selected && (
                  <>
                    <ParamSelect
                      label={t(lang, "nucleusChannel")}
                      value={draft.nucleus_channel === null ? "" : String(draft.nucleus_channel)}
                      onChange={(v) => set({ nucleus_channel: v === "" ? null : Number(v) })}
                      options={[{ value: "", label: t(lang, "channelAutoShort") }, ...selected.channels.map((c) => ({ value: String(c.index), label: c.name }))]}
                    />
                    <ParamSelect
                      label={t(lang, "eduChannel")}
                      value={draft.edu_channel === null ? "" : String(draft.edu_channel)}
                      onChange={(v) => set({ edu_channel: v === "" ? null : Number(v) })}
                      options={[{ value: "", label: t(lang, "channelAutoShort") }, ...selected.channels.map((c) => ({ value: String(c.index), label: c.name }))]}
                    />
                  </>
                )}

                {draft.count_mode === "nucleus" ? (
                  <div className="grid gap-2 rounded-xl bg-[var(--bg)] p-2.5">
                    <p className="flex items-center justify-between text-sm font-medium">
                      {t(lang, "eduThreshold")}
                      <span className="font-mono text-xs text-[var(--text-dim)]">
                        {threshold === null ? "–" : fmt(threshold, 1)}
                        {draft.edu_method !== "manual" && !isPreview && draft.edu_scope === "analysis" && info?.pooled_thresholds?.[draft.edu_method] != null ? ` · ${t(lang, "pooledShort")}` : ""}
                      </span>
                    </p>
                    {means.length > 0 && <EduHistogram values={means} threshold={threshold} onThreshold={(v) => set({ edu_method: "manual", edu_threshold: v })} />}
                    <ParamSelect
                      label={t(lang, "thresholdMethod")}
                      value={draft.edu_method}
                      onChange={(v) => set({ edu_method: v, edu_threshold: v === "manual" ? Number((threshold ?? 0).toFixed(2)) : draft.edu_threshold })}
                      hint={t(lang, "eduMethodHint")}
                      options={[
                        { value: "li", label: t(lang, "eduMethod_li") },
                        { value: "log-otsu", label: t(lang, "eduMethod_logotsu") },
                        { value: "otsu", label: "Otsu" },
                        { value: "manual", label: t(lang, "manual") },
                      ]}
                    />
                    {draft.edu_method === "manual" ? (
                      <ParamNumber label={t(lang, "thresholdValue")} value={draft.edu_threshold} min={0} step={1} onChange={(v) => set({ edu_threshold: v })} hint={t(lang, "eduThresholdHint")} />
                    ) : (
                      <ParamSelect
                        label={t(lang, "eduScope")}
                        value={draft.edu_scope}
                        onChange={(v) => set({ edu_scope: v })}
                        hint={t(lang, "eduScopeHint")}
                        options={[
                          { value: "analysis", label: t(lang, "eduScope_analysis") },
                          { value: "image", label: t(lang, "eduScope_image") },
                        ]}
                      />
                    )}
                    <p className="text-2xs leading-4 text-[var(--text-dim)]">{t(lang, "eduInstantHint")}</p>
                  </div>
                ) : (
                  <div className="grid gap-2 rounded-xl bg-[var(--bg)] p-2.5">
                    <p className="text-sm font-medium">{t(lang, "eduSegmentation")}</p>
                    <ParamSelect label={t(lang, "thresholdMethod")} value={draft.edu_seg_method} onChange={(v) => set({ edu_seg_method: v })} options={segOptions} />
                    {draft.edu_seg_method === "manual" ? (
                      <ParamNumber label={t(lang, "thresholdValue")} value={draft.edu_seg_threshold} min={0} onChange={(v) => set({ edu_seg_threshold: v })} />
                    ) : (
                      <ParamNumber label={t(lang, "thresholdFactor")} value={draft.edu_seg_factor} min={0.2} max={5} step={0.05} unit="×" onChange={(v) => set({ edu_seg_factor: v })} hint={t(lang, "thresholdFactorHint")} />
                    )}
                    {shown && <p className="text-2xs text-[var(--text-dim)]">{t(lang, "levelShort")} {fmt(shown.edu_seg_level, 1)}</p>}
                  </div>
                )}

                <p className="pt-1 text-sm font-medium">{t(lang, "nucleusSegmentation")}</p>
                <ParamSelect label={t(lang, "thresholdMethod")} value={draft.nucleus_method} onChange={(v) => set({ nucleus_method: v })} options={segOptions} />
                {draft.nucleus_method === "manual" ? (
                  <ParamNumber label={t(lang, "thresholdValue")} value={draft.nucleus_threshold} min={0} onChange={(v) => set({ nucleus_threshold: v })} />
                ) : (
                  <ParamNumber label={t(lang, "thresholdFactor")} value={draft.nucleus_factor} min={0.2} max={5} step={0.05} unit="×" onChange={(v) => set({ nucleus_factor: v })} hint={t(lang, "thresholdFactorHint")} />
                )}
                <ParamCheck label={t(lang, "splitTouching")} checked={draft.split_touching} onChange={(v) => set({ split_touching: v })} hint={t(lang, "splitTouchingHint")} />
                {draft.split_touching && (
                  <ParamNumber label={t(lang, "splitStrength")} value={draft.split_strength} min={0.2} max={50} step={0.5} unit="px" onChange={(v) => set({ split_strength: v })} hint={t(lang, "splitStrengthHint")} />
                )}
                <ParamNumber label={t(lang, "minArea")} value={draft.min_area} min={0} step={10} unit="px" zeroLabel={t(lang, "autoShort")} onChange={(v) => set({ min_area: v })} hint={t(lang, "eduMinAreaHint")} />
                <Advanced onReset={() => setDraft((d) => (d ? { ...EDU_DEFAULTS, ...pickClassify(d), edu_kind: d.edu_kind } : d))}>
                  <ParamNumber label={t(lang, "smoothSigma")} value={draft.smooth_sigma} min={0} max={10} step={0.25} unit="px" onChange={(v) => set({ smooth_sigma: v })} hint={t(lang, "smoothSigmaHint")} />
                  <ParamNumber
                    label={t(lang, "backgroundRadius")}
                    value={draft.background_radius}
                    min={0}
                    max={2000}
                    step={5}
                    unit="px"
                    zeroLabel={shown ? `${t(lang, "autoShort")} ${Math.round(shown.background_radius)}` : t(lang, "autoShort")}
                    onChange={(v) => set({ background_radius: v })}
                    hint={t(lang, "backgroundRadiusHint")}
                  />
                  <ParamNumber label={t(lang, "maxArea")} value={draft.max_area} min={0} step={100} unit="px" zeroLabel={t(lang, "noLimit")} onChange={(v) => set({ max_area: v })} />
                  <ParamCheck label={t(lang, "excludeBorder")} checked={draft.exclude_border} onChange={(v) => set({ exclude_border: v })} />
                  {draft.count_mode === "nucleus" && (
                    <>
                      <p className="pt-1 text-xs font-medium text-[var(--text-dim)]">{t(lang, "eduSegmentation")}</p>
                      <ParamSelect label={t(lang, "thresholdMethod")} value={draft.edu_seg_method} onChange={(v) => set({ edu_seg_method: v })} options={segOptions} />
                      {draft.edu_seg_method === "manual" ? (
                        <ParamNumber label={t(lang, "thresholdValue")} value={draft.edu_seg_threshold} min={0} onChange={(v) => set({ edu_seg_threshold: v })} />
                      ) : (
                        <ParamNumber label={t(lang, "thresholdFactor")} value={draft.edu_seg_factor} min={0.2} max={5} step={0.05} unit="×" onChange={(v) => set({ edu_seg_factor: v })} />
                      )}
                    </>
                  )}
                  {shown && (
                    <p className="text-2xs leading-4 text-[var(--text-dim)]">
                      {t(lang, "eduMeasured")}: Ø {fmt(shown.diameter, 1)} px · {t(lang, "levelShort")} {fmt(shown.nucleus_level, 1)}
                    </p>
                  )}
                </Advanced>
                <PreviewBar
                  state={pv}
                  summary={pv.preview ? `${counts.nuclei} · ${mode === "independent" ? counts.independent : counts.positive} · ${pct(ratio)}` : undefined}
                  busyAnalysis={busy}
                  canApplyImage={Boolean(selected)}
                  applyAllLabel={neverRun ? t(lang, "startAnalysisN") : t(lang, "applyAllAndRun")}
                  onApplyAll={() => void applyAll()}
                  onApplyImage={() => void applyImage()}
                  onDiscard={() => saved && setDraft((d) => ({ ...saved, ...(d ? pickClassify(d) : {}) }))}
                />
                {selected?.override && (
                  <p className="flex items-center justify-between gap-2 rounded-lg bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs text-[var(--accent)]">
                    {t(lang, "imageHasOverride")}
                    <button type="button" onClick={() => void patchAnalysisResult(analysisId, selected.file_id, { reset_params: true }).then(load)} className="underline">
                      {t(lang, "useAnalysisParams")}
                    </button>
                  </p>
                )}
              </>
            )}
          </section>

          {selected && (
            <section className="border-b border-[var(--line)] p-4">
              <label className="grid gap-1 text-sm text-[var(--text-dim)]">
                {t(lang, "imageGroup")}
                <input
                  key={`${selected.file_id}:${selected.group}`}
                  defaultValue={selected.group}
                  list="edu-groups"
                  onBlur={(e) => void setGroup(selected, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[var(--text)]"
                />
                <datalist id="edu-groups">
                  {groupNames.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
              <p className="mt-2 truncate text-xs text-[var(--text-dim)]">
                {selected.partner ? `${selected.file_name} + ${selected.partner.name}` : selected.file_name}
              </p>
              {activeNucleus ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-xs">
                  <div className="col-span-2 flex justify-between text-sm font-semibold">
                    <span>
                      {t(lang, "nucleusNo")} {activeNucleus.key}
                    </span>
                    <span style={{ color: activeFlag ? (activeFlag === "negative" ? "var(--text-dim)" : FLAG_COLOR[activeFlag]) : undefined }}>
                      {activeFlag ? t(lang, `flag_${activeFlag}` as MsgKey) : ""}
                      {String(activeNucleus.key) in marks ? ` · ${t(lang, "setByHand")}` : ""}
                    </span>
                  </div>
                  <dt className="text-[var(--text-dim)]">{t(lang, "areaLabel")}</dt>
                  <dd className="text-right tabular-nums">
                    {activeNucleus.area} px{um ? ` · ${fmt(activeNucleus.area * um * um, 1)} µm²` : ""}
                  </dd>
                  <dt className="text-[var(--text-dim)]">{shown?.nucleus?.channel_name ?? "DAPI"}</dt>
                  <dd className="text-right tabular-nums">{fmt(activeNucleus.dapi, 1)}</dd>
                  <dt className="text-[var(--text-dim)]">EdU</dt>
                  <dd className="text-right tabular-nums">{fmt(activeNucleus.edu, 1)}</dd>
                </dl>
              ) : activeObject ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-xs">
                  <div className="col-span-2 flex justify-between text-sm font-semibold">
                    <span>
                      {t(lang, "eduObjectNo")} {activeObject.key}
                    </span>
                    {deleted.has(activeObject.key) && <span className="text-[var(--text-dim)]">{t(lang, "status_deleted")}</span>}
                  </div>
                  <dt className="text-[var(--text-dim)]">{t(lang, "areaLabel")}</dt>
                  <dd className="text-right tabular-nums">{activeObject.area} px</dd>
                  <dt className="text-[var(--text-dim)]">EdU</dt>
                  <dd className="text-right tabular-nums">{fmt(activeObject.mean, 1)}</dd>
                </dl>
              ) : (
                <p className="mt-3 text-xs text-[var(--text-dim)]">{t(lang, mode === "independent" ? "eduClickHintIndependent" : "eduHoverHint")}</p>
              )}
            </section>
          )}

          <section className="p-4">
            <h2 className="text-sm font-semibold">{t(lang, "groupStats")}</h2>
            {summary && summary.total > 0 ? (
              <>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--line)] text-xs text-[var(--text-dim)]">
                        <th className="px-2 py-1 text-left font-medium">{t(lang, "group")}</th>
                        <th className="px-2 py-1 text-right font-medium" title={t(lang, "nFields")}>
                          n
                        </th>
                        <th className="px-2 py-1 text-right font-medium">{t(lang, "eduPositiveShort")}</th>
                        <th className="px-2 py-1 text-right font-medium" title={t(lang, "pooledHint")}>
                          {t(lang, "pooledShort")}
                        </th>
                        <th className="px-2 py-1 text-right font-medium">{t(lang, "meanSd")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.groups.map((g, gi) => {
                        const ind = mode === "independent";
                        return (
                          <tr key={g.group} className="border-b border-[var(--line)]/60">
                            <td className="max-w-[7rem] truncate px-2 py-1.5" title={g.group}>
                              <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: GROUP_COLORS[gi % GROUP_COLORS.length] }} />
                              {g.group}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono text-xs">{g.fields}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-xs">
                              {ind ? g.independent : g.positive}/{g.nuclei}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono text-xs">{fmt(ind ? g.pooled_percent_independent : g.pooled_percent, 1)}%</td>
                            <StatCell stat={ind ? g.percent_independent : g.percent} digits={1} suffix="%" />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3">
                  <PercentPlot groups={summary.groups} independent={mode === "independent"} />
                </div>
                <p className="mt-1 text-2xs leading-4 text-[var(--text-dim)]">{t(lang, "eduStatsHint")}</p>
              </>
            ) : (
              <p className="mt-3 text-xs text-[var(--text-dim)]">{busy ? t(lang, "analyzing") : t(lang, "notAnalyzedYet")}</p>
            )}
            <button type="button" disabled={exporting || busy || neverRun} onClick={() => void startExport()} className="primary-action mt-4 w-full min-h-10 disabled:opacity-50">
              <ExportIcon size={16} className="shrink-0" />
              {t(lang, "exportAnalysis")}
            </button>
          </section>
        </Glass>
      </div>
    </Shell>
  );
}
