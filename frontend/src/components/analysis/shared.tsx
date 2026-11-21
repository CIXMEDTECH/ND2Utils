import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, CaretDown, CaretRight, ChartBar, Dna, Folder, Plus, ShootingStar, SpinnerGap, Trash, WarningCircle } from "@phosphor-icons/react";
import { Glass } from "../Glass";
import { Modal } from "../Modal";
import { Shell } from "../Shell";
import { t, type MsgKey } from "../../i18n";
import {
  createAnalysis,
  deleteAnalysis,
  listAnalyses,
  pairAnalysisFiles,
  previewAnalysis,
  type AnalysisInfo,
  type AnalysisType,
  type EduKind,
  type PairingResult,
  type Stat,
} from "../../lib/api";
import { detailMessage, formatDateTime } from "../../lib/format";
import { useApp } from "../../store";

export const GROUP_COLORS = ["#0ea5e9", "#f97316", "#22c55e", "#a855f7", "#ef4444", "#eab308", "#14b8a6", "#ec4899"];

export const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : Number(v.toFixed(digits)).toString());

/** Analysis tools. Each tool owns its pages under /analysis/<type>. */
export const TOOLS: { type: AnalysisType; title: MsgKey; body: MsgKey; intro: MsgKey; newLabel: MsgKey; Icon: typeof ChartBar }[] = [
  { type: "comet", title: "cometAssay", body: "cometToolBody", intro: "analysisIntro", newLabel: "newAnalysis", Icon: ShootingStar },
  { type: "edu", title: "eduAssay", body: "eduToolBody", intro: "eduIntro", newLabel: "newEduAnalysis", Icon: Dna },
];

export const toolOf = (type: AnalysisType | undefined) => TOOLS.find((tl) => tl.type === type) ?? TOOLS[0];

export const analysisPath = (a: Pick<AnalysisInfo, "id" | "type">) => `/analysis/${a.type}/${a.id}`;

// --- list pages ---------------------------------------------------------------------------

export function AnalysisCards({ items, onChanged }: { items: AnalysisInfo[]; onChanged: () => void }) {
  const lang = useApp((s) => s.lang);
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map((a) => {
        const tool = toolOf(a.type);
        return (
          <li key={a.id}>
            <Glass shape="card" className="flex items-start gap-3 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <tool.Icon size={20} weight="duotone" />
              </span>
              <Link to={analysisPath(a)} className="min-w-0 flex-1">
                <p className="truncate font-semibold">{a.name}</p>
                <p className="mt-1 text-sm text-[var(--text-dim)]">
                  {t(lang, tool.title)} · {a.file_count} {t(lang, a.type === "edu" ? "nFields" : "nFiles")} · {formatDateTime(a.updated_at, lang)}
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

export function useAnalyses(type?: AnalysisType) {
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

const UNPAIRED_REASON: Record<string, MsgKey> = { no_nucleus: "unpairedNoNucleus", no_edu: "unpairedNoEdu" };

export function UnpairedList({ items }: { items: PairingResult["unpaired"] }) {
  const lang = useApp((s) => s.lang);
  if (!items.length) return null;
  return (
    <ul className="mt-1 max-h-28 overflow-auto text-xs leading-5 text-[var(--text-dim)]">
      {items.map((u) => (
        <li key={u.file_id} className="truncate">
          <span className="font-mono">{u.name}</span> — {t(lang, UNPAIRED_REASON[u.reason] ?? "unpairedNoEdu")}
        </li>
      ))}
    </ul>
  );
}

/** New analysis from folders. EdU shows how the files pair into fields before creating. */
export function NewAnalysisDialog({ open, onClose, type }: { open: boolean; onClose: () => void; type: AnalysisType }) {
  const lang = useApp((s) => s.lang);
  const folders = useApp((s) => s.folders);
  const files = useApp((s) => s.files);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [eduKind, setEduKind] = useState<EduKind>("auto");
  const [pairing, setPairing] = useState<PairingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tool = toolOf(type);

  useEffect(() => {
    if (open && !files.length) void refreshFiles().catch(() => undefined);
  }, [files.length, open, refreshFiles]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) map.set(f.folder, (map.get(f.folder) ?? 0) + 1);
    return map;
  }, [files]);

  const pickedKey = [...picked].sort().join("|");
  useEffect(() => {
    setPairing(null);
    if (type !== "edu" || !open || !picked.size) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void pairAnalysisFiles({ folders: [...picked], edu_kind: eduKind })
        .then((res) => !cancelled && setPairing(res))
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, open, pickedKey, eduKind]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const rec = await createAnalysis({
        type,
        name: name || [...picked].map((p) => p.split("/").pop()).join(" · "),
        folders: [...picked],
        params: type === "edu" ? { edu_kind: eduKind } : undefined,
        run: false,
      });
      nav(analysisPath(rec));
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  const blocked = type === "edu" && pairing !== null && pairing.fields.length === 0;
  return (
    <Modal open={open} title={t(lang, tool.newLabel)} subtitle={t(lang, "newAnalysisHint")} onClose={onClose} width={540}>
      <label className="grid gap-1.5 text-sm text-[var(--text-dim)]">
        {t(lang, "analysisName")}
        <input value={name} onChange={(e) => setName(e.target.value)} className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[var(--text)]" />
      </label>
      {type === "edu" && (
        <label className="mt-3 grid gap-1.5 text-sm text-[var(--text-dim)]">
          {t(lang, "eduChannelColor")}
          <select value={eduKind} onChange={(e) => setEduKind(e.target.value as EduKind)} className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[var(--text)]">
            {(["auto", "green", "red", "farred"] as const).map((k) => (
              <option key={k} value={k}>
                {t(lang, `eduKind_${k}` as MsgKey)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="mt-3 max-h-[38vh] overflow-auto rounded-xl border border-[var(--line)] p-1">
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
      {type === "edu" && picked.size > 0 && (
        <div className="mt-3 rounded-xl bg-[var(--bg)] px-3 py-2 text-sm">
          {pairing === null ? (
            <p className="flex items-center gap-2 text-[var(--text-dim)]">
              <SpinnerGap size={14} className="animate-spin" /> {t(lang, "pairingCheck")}
            </p>
          ) : (
            <>
              <p className={pairing.fields.length ? "text-[var(--text)]" : "text-[var(--danger)]"}>
                {pairing.fields.length} {t(lang, "fieldsPaired")}
                {pairing.unpaired.length > 0 && (
                  <span className="text-[var(--text-dim)]">
                    {" "}
                    · {pairing.unpaired.length} {t(lang, "filesUnpaired")}
                  </span>
                )}
              </p>
              {pairing.fields.length > 0 && (
                <p className="mt-0.5 truncate text-xs text-[var(--text-dim)]">
                  {pairing.fields
                    .slice(0, 3)
                    .map((f) => (f.edu ? `${f.nucleus} + ${f.edu}` : f.nucleus))
                    .join(" · ")}
                  {pairing.fields.length > 3 ? " …" : ""}
                </p>
              )}
              <UnpairedList items={pairing.unpaired} />
            </>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
      <p className="mt-3 text-xs leading-5 text-[var(--text-dim)]">{t(lang, "setupAfterCreate")}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
          {t(lang, "cancel")}
        </button>
        <button type="button" disabled={busy || !picked.size || blocked} onClick={() => void create()} className="primary-action min-h-9 px-4 disabled:opacity-50">
          {t(lang, "createAndSetup")}
        </button>
      </div>
    </Modal>
  );
}

/** /analysis/<type>: the analyses of one tool and "new". */
export function ToolPage({ type }: { type: AnalysisType }) {
  const lang = useApp((s) => s.lang);
  const { items, error, load } = useAnalyses(type);
  const [creating, setCreating] = useState(false);
  const tool = toolOf(type);
  return (
    <Shell dense>
      <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--line)] pb-6">
          <div>
            <Link to="/analysis" className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-[0.16em] text-[var(--accent)] hover:underline">
              <ArrowLeft size={11} /> {t(lang, "analysisTitle")}
            </Link>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{t(lang, tool.title)}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-dim)]">{t(lang, tool.intro)}</p>
          </div>
          <button type="button" onClick={() => setCreating(true)} className="primary-action">
            <Plus size={16} />
            {t(lang, tool.newLabel)}
          </button>
        </div>
        {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}
        {items && items.length === 0 && (
          <div className="flex min-h-64 flex-col items-center justify-center text-center">
            <tool.Icon size={34} weight="duotone" className="mb-4 text-[var(--accent)]" />
            <p className="max-w-md text-md leading-6 text-[var(--text-dim)]">{t(lang, "noAnalyses")}</p>
          </div>
        )}
        <div className="mt-6">{items && <AnalysisCards items={items} onChanged={load} />}</div>
      </main>
      <NewAnalysisDialog open={creating} onClose={() => setCreating(false)} type={type} />
    </Shell>
  );
}

// --- statistics ------------------------------------------------------------------------------

export function StatCell({ stat, digits = 2, suffix = "" }: { stat: Stat | undefined; digits?: number; suffix?: string }) {
  if (!stat || !stat.n) return <td className="px-2 py-1.5 text-right font-mono text-xs text-[var(--text-dim)]">–</td>;
  return (
    <td className="px-2 py-1.5 text-right font-mono text-xs tabular-nums" title={`SEM ${fmt(stat.sem)} · median ${fmt(stat.median)}`}>
      {fmt(stat.mean, digits)}
      {suffix} <span className="text-[var(--text-dim)]">± {fmt(stat.sd, digits)}</span>
    </td>
  );
}

// --- parameters ------------------------------------------------------------------------------

const inputClass = "h-8 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[var(--text)]";

export function ParamNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hint,
  zeroLabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  /** Shown as placeholder when the value is 0 (e.g. "auto"). */
  zeroLabel?: string;
}) {
  const [text, setText] = useState(zeroLabel && value === 0 ? "" : String(value));
  useEffect(() => {
    setText(zeroLabel && value === 0 ? "" : String(value));
  }, [value, zeroLabel]);
  function commit(raw: string) {
    if (raw.trim() === "" && zeroLabel) {
      onChange(0);
      return;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, num));
    onChange(clamped);
    setText(String(clamped));
  }
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-2 text-sm text-[var(--text-dim)]" title={hint}>
      <span className="truncate">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          inputMode="decimal"
          value={text}
          min={min}
          max={max}
          step={step}
          placeholder={zeroLabel}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)}
          className={`${inputClass} w-full min-w-0 text-right font-mono text-xs`}
        />
        {unit && <span className="w-5 shrink-0 text-2xs">{unit}</span>}
      </span>
    </label>
  );
}

export function ParamSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,9.5rem)] items-center gap-2 text-sm text-[var(--text-dim)]" title={hint}>
      <span className="truncate">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`${inputClass} min-w-0 text-sm`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ParamCheck({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Advanced({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  const lang = useApp((s) => s.lang);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--line)]">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-sm font-medium text-[var(--text-dim)] hover:text-[var(--text)]" aria-expanded={open}>
          {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
          {t(lang, "advancedParams")}
        </button>
        {open && onReset && (
          <button type="button" onClick={onReset} className="text-xs text-[var(--text-dim)] underline hover:text-[var(--text)]">
            {t(lang, "restoreDefaults")}
          </button>
        )}
      </div>
      {open && <div className="grid gap-2 border-t border-[var(--line)] px-2.5 py-2.5">{children}</div>}
    </div>
  );
}

// --- preview -----------------------------------------------------------------------------------

function pick(obj: Record<string, unknown> | null | undefined, ignore: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!ignore.includes(k)) out[k] = v;
  return out;
}

export function sameParams(a: object | null | undefined, b: object | null | undefined, ignore: readonly string[] = []) {
  const pa = pick(a as Record<string, unknown>, ignore);
  const pb = pick(b as Record<string, unknown>, ignore);
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  for (const k of keys) if (JSON.stringify(pa[k] ?? null) !== JSON.stringify(pb[k] ?? null)) return false;
  return true;
}

/** Live preview of the selected image with draft parameters: runs (debounced) whenever the
 * draft differs from the saved parameters, or the image has no result yet. Nothing is stored. */
export function useDraftPreview<R>({
  analysisId,
  fileId,
  draft,
  saved,
  hasResult,
  ignore = [],
  enabled = true,
}: {
  analysisId: string;
  fileId: string | null;
  draft: object | null;
  saved: object | null | undefined;
  hasResult: boolean;
  ignore?: readonly string[];
  enabled?: boolean;
}) {
  const lang = useApp((s) => s.lang);
  const [preview, setPreview] = useState<{ key: string; result: R } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const dirty = Boolean(draft) && !sameParams(draft, saved, ignore);
  const wanted = enabled && Boolean(fileId) && Boolean(draft) && (dirty || !hasResult);
  const segKey = JSON.stringify(pick(draft as Record<string, unknown>, ignore));
  const key = `${fileId}:${segKey}`;

  useEffect(() => {
    setError(null);
    if (!wanted || !fileId || !draft) {
      setBusy(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const handle = window.setTimeout(() => {
      void previewAnalysis<R>(analysisId, fileId, draft as Record<string, unknown>, ctrl.signal)
        .then((result) => {
          if (!ctrl.signal.aborted) setPreview({ key, result });
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) setError(detailMessage(err, lang));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setBusy(false);
        });
    }, 600);
    return () => {
      window.clearTimeout(handle);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId, key, wanted, nonce]);

  const current = wanted && preview && preview.key === key ? preview.result : null;
  // While a new preview is computed, keep showing the previous one for this image.
  const stale = wanted && !current && preview && preview.key.startsWith(`${fileId}:`) ? preview.result : null;
  return { preview: current ?? stale, fresh: Boolean(current), busy, error, dirty, active: wanted, refresh: () => setNonce((n) => n + 1) };
}

/** Status line + actions while parameters are being tuned. */
export function PreviewBar({
  state,
  summary,
  busyAnalysis,
  canApplyImage,
  applyAllLabel,
  onApplyAll,
  onApplyImage,
  onDiscard,
}: {
  state: { busy: boolean; error: string | null; dirty: boolean; active: boolean; preview: unknown };
  summary?: ReactNode;
  busyAnalysis: boolean;
  canApplyImage: boolean;
  applyAllLabel: string;
  onApplyAll: () => void;
  onApplyImage?: () => void;
  onDiscard: () => void;
}) {
  const lang = useApp((s) => s.lang);
  if (!state.dirty && !state.active) return null;
  return (
    <div className="grid gap-2 rounded-xl border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] p-2.5 text-sm">
      <p className="flex items-center gap-1.5 text-[var(--accent)]">
        {state.busy ? <SpinnerGap size={14} className="animate-spin" /> : state.error ? <WarningCircle size={14} className="text-[var(--danger)]" /> : null}
        <span className="font-medium">{state.busy ? t(lang, "previewRunning") : state.error ? t(lang, "previewFailed") : t(lang, "previewReady")}</span>
        {summary && !state.busy && !state.error && <span className="ml-auto font-mono text-xs">{summary}</span>}
      </p>
      {state.error && <p className="text-xs text-[var(--danger)]">{state.error}</p>}
      <div className="grid grid-cols-[1fr_auto_auto] gap-1.5">
        <button type="button" disabled={busyAnalysis} onClick={onApplyAll} className="primary-action min-h-8 px-2 text-sm disabled:opacity-50">
          {applyAllLabel}
        </button>
        {onApplyImage && (
          <button
            type="button"
            disabled={busyAnalysis || !canApplyImage || !state.dirty}
            onClick={onApplyImage}
            className="inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-2 text-xs font-medium hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          >
            {t(lang, "onlyThisImage")}
          </button>
        )}
        <button type="button" disabled={!state.dirty} onClick={onDiscard} className="min-h-8 rounded-xl px-2 text-xs text-[var(--text-dim)] hover:bg-[var(--bg)] disabled:opacity-40">
          {t(lang, "discardChanges")}
        </button>
      </div>
    </div>
  );
}

/** Shown before the first run: tune, preview, then start. */
export function SetupBanner({ count, unit, busy, onStart }: { count: number; unit: string; busy: boolean; onStart: () => void }) {
  const lang = useApp((s) => s.lang);
  return (
    <div className="grid gap-2 rounded-xl border border-dashed border-[var(--accent)] p-3 text-sm">
      <p className="leading-5 text-[var(--text-dim)]">{t(lang, "setupHint")}</p>
      <button type="button" disabled={busy} onClick={onStart} className="primary-action min-h-9 px-3 disabled:opacity-50">
        {t(lang, "startAnalysisN")} ({count} {unit})
      </button>
    </div>
  );
}
