import { useEffect, useMemo, useState } from "react";
import { Check, Gauge, WarningCircle } from "@phosphor-icons/react";
import { t, type MsgKey } from "../i18n";
import { getPerformance, resetPerformance, updatePerformance } from "../lib/api";
import { configure as configureCache } from "../lib/previewCache";
import { detailMessage, formatBytes } from "../lib/format";
import type { PerformanceValues, PerformanceView, RenderModeSetting } from "../lib/types";
import { useApp } from "../store";
import { Glass } from "./Glass";

type NumberKey = { [K in keyof PerformanceValues]: PerformanceValues[K] extends number ? K : never }[keyof PerformanceValues];
type SwitchKey = { [K in keyof PerformanceValues]: PerformanceValues[K] extends boolean ? K : never }[keyof PerformanceValues];
type NumberItem = { key: NumberKey; label: MsgKey; hint: MsgKey; unit?: MsgKey; step?: number };

const NUMBERS: Partial<Record<NumberKey, NumberItem>> = Object.fromEntries(
  ([
    { key: "tile_cache_mb", label: "perfTileCache", hint: "perfTileCacheHint", unit: "unitMb", step: 32 },
    { key: "render_cache_mb", label: "perfRenderCache", hint: "perfRenderCacheHint", unit: "unitMb", step: 32 },
    { key: "server_tile_quality", label: "perfQuality", hint: "perfQualityHint" },
    { key: "max_open_files", label: "perfOpenFiles", hint: "perfOpenFilesHint", unit: "unitCount" },
    { key: "prepare_workers", label: "perfPrepare", hint: "perfPrepareHint", unit: "unitCount" },
    { key: "export_workers", label: "perfExports", hint: "perfExportsHint", unit: "unitCount" },
    { key: "raster_max_mpx", label: "perfRaster", hint: "perfRasterHint", unit: "unitMpx", step: 4 },
    { key: "local_cache_mb", label: "perfLocalCacheSize", hint: "perfLocalCacheSizeHint", unit: "unitMb", step: 256 },
  ] as NumberItem[]).map((item) => [item.key, item]),
);

type Group = "render" | "memory" | "export" | "cache";

/** Settings are shown one group at a time; one save applies every group. */
const GROUPS: { key: Group; label: MsgKey; fields: (keyof PerformanceValues)[] }[] = [
  { key: "render", label: "perfGroupRender", fields: ["render_mode", "server_tile_quality", "render_cache_mb"] },
  { key: "memory", label: "perfGroupMemory", fields: ["tile_cache_mb", "max_open_files", "prepare_workers"] },
  { key: "export", label: "perfGroupExport", fields: ["export_workers", "raster_max_mpx"] },
  { key: "cache", label: "perfCacheSection", fields: ["local_cache", "local_cache_auto", "cache_rebuild_users", "local_cache_mb"] },
];

const CACHE_SWITCHES: { key: SwitchKey; label: MsgKey; hint: MsgKey; needs?: SwitchKey }[] = [
  { key: "local_cache", label: "perfLocalCache", hint: "perfLocalCacheHint" },
  { key: "local_cache_auto", label: "perfLocalCacheAuto", hint: "perfLocalCacheAutoHint", needs: "local_cache" },
  { key: "cache_rebuild_users", label: "perfRebuildUsers", hint: "perfRebuildUsersHint" },
];

const MODES: { key: RenderModeSetting; label: MsgKey; hint: MsgKey }[] = [
  { key: "auto", label: "renderAuto", hint: "renderAutoHint" },
  { key: "browser", label: "renderBrowser", hint: "renderBrowserHint" },
  { key: "server", label: "renderServerOption", hint: "renderServerHint" },
];

/** Administrators: performance settings, applied on the server without a restart. */
export function AdminPerformance() {
  const lang = useApp((s) => s.lang);
  const userId = useApp((s) => s.user?.id ?? null);
  const [view, setView] = useState<PerformanceView | null>(null);
  const [draft, setDraft] = useState<PerformanceValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<Group>("render");

  useEffect(() => {
    let cancelled = false;
    const load = (initial: boolean) =>
      getPerformance()
        .then((next) => {
          if (cancelled) return;
          setView(next);
          if (initial) setDraft(next.values);
        })
        .catch((err) => {
          if (!cancelled && initial) setError(detailMessage(err, lang));
        });
    void load(true);
    // Keep the status (cache use, running exports) current while the page is open.
    const handle = window.setInterval(() => void load(false), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [lang]);

  const dirty = useMemo(
    () => Boolean(view && draft && (Object.keys(draft) as (keyof PerformanceValues)[]).some((k) => draft[k] !== view.values[k])),
    [draft, view],
  );

  async function run(action: () => Promise<PerformanceView>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setView(next);
      setDraft(next.values);
      // This browser follows the new cache settings right away (others on their next load).
      void configureCache(userId, true);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  function numberField(item: NumberItem | undefined) {
    if (!draft || !view || !item) return null;
    const spec = view.schema[item.key];
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const value = draft[item.key];
    const set = (next: number) => {
      if (Number.isNaN(next)) return;
      setDraft({ ...draft, [item.key]: Math.round(Math.min(max, Math.max(min, next))) });
    };
    const unit = item.unit ? t(lang, item.unit) : "";
    return (
      <div key={item.key} className="grid gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`perf-${item.key}`} className="text-sm font-medium">
            {t(lang, item.label)}
          </label>
          <span className="flex items-center gap-1.5">
            <input
              id={`perf-${item.key}`}
              type="number"
              min={min}
              max={max}
              step={item.step ?? 1}
              value={value}
              onChange={(event) => set(Number(event.target.value))}
              className="h-8 w-24 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-right font-mono text-sm tabular-nums focus:border-[var(--accent)]"
            />
            {unit && <span className="w-14 text-xs text-[var(--text-dim)]">{unit}</span>}
          </span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={item.step ?? 1}
          value={value}
          onChange={(event) => set(Number(event.target.value))}
          aria-label={t(lang, item.label)}
        />
        <p className="flex justify-between gap-3 text-xs leading-4 text-[var(--text-dim)]">
          <span>{t(lang, item.hint)}</span>
          <span className="shrink-0 font-mono">
            {t(lang, "perfDefault")} {String(spec.default)}
          </span>
        </p>
      </div>
    );
  }

  const status = view?.status;
  const segmented = (active: boolean) =>
    `relative h-9 rounded-lg text-sm transition-colors ${active ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`;

  return (
    <Glass as="section" shape="card" className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] sm:flex">
          <Gauge size={18} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold">{t(lang, "perfTitle")}</h2>
          <p className="mt-2 text-sm leading-5 text-[var(--text-dim)]">{t(lang, "perfIntro")}</p>

          {status && (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-[var(--bg)]/50 p-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-[var(--text-dim)]">{t(lang, "perfCpu")}</dt>
                <dd className="font-mono tabular-nums">{status.cpu_count ?? "–"}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--text-dim)]">{t(lang, "perfMemory")}</dt>
                <dd className="font-mono tabular-nums">
                  {status.memory_total ? formatBytes(status.memory_total, lang) : "–"}
                  {status.memory_available ? (
                    <span className="text-[var(--text-dim)]">
                      {" "}
                      · {formatBytes(status.memory_available, lang)} {t(lang, "perfMemoryFree")}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--text-dim)]">{t(lang, "perfCacheUse")}</dt>
                <dd className="font-mono tabular-nums">{formatBytes(status.tile_cache_bytes + status.render_cache_bytes, lang)}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--text-dim)]">{t(lang, "perfOpenSlides")}</dt>
                <dd className="font-mono tabular-nums">{status.open_slides}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--text-dim)]">{t(lang, "perfExportsNow")}</dt>
                <dd className="font-mono tabular-nums">
                  {status.exports_running} {t(lang, "perfRunning")} · {status.exports_waiting} {t(lang, "perfWaiting")}
                </dd>
              </div>
            </dl>
          )}

          {draft && view && (
            <div className="mt-5 grid gap-5">
              <div className="flex gap-1 overflow-x-auto rounded-xl bg-[var(--bg)]/50 p-1" role="tablist">
                {GROUPS.map((g) => {
                  const changed = g.fields.some((k) => draft[k] !== view.values[k]);
                  return (
                    <button
                      key={g.key}
                      type="button"
                      role="tab"
                      aria-selected={group === g.key}
                      onClick={() => setGroup(g.key)}
                      className={`${segmented(group === g.key)} inline-flex shrink-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3`}
                    >
                      {t(lang, g.label)}
                      {changed && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-label={t(lang, "perfDirty")} />}
                    </button>
                  );
                })}
              </div>

              {group === "render" && (
                <>
                  <fieldset>
                    <legend className="text-sm font-medium">{t(lang, "perfRenderMode")}</legend>
                    <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-[var(--bg)]/50 p-1" role="radiogroup">
                      {MODES.map((mode) => (
                        <button
                          key={mode.key}
                          type="button"
                          role="radio"
                          aria-checked={draft.render_mode === mode.key}
                          onClick={() => setDraft({ ...draft, render_mode: mode.key })}
                          className={segmented(draft.render_mode === mode.key)}
                        >
                          {t(lang, mode.label)}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[var(--text-dim)]">
                      {t(lang, MODES.find((m) => m.key === draft.render_mode)?.hint ?? "renderAutoHint")}
                    </p>
                  </fieldset>
                  {numberField(NUMBERS.server_tile_quality)}
                  {numberField(NUMBERS.render_cache_mb)}
                </>
              )}

              {group === "memory" && (
                <>
                  {numberField(NUMBERS.tile_cache_mb)}
                  {numberField(NUMBERS.max_open_files)}
                  {numberField(NUMBERS.prepare_workers)}
                </>
              )}

              {group === "export" && (
                <>
                  {numberField(NUMBERS.export_workers)}
                  {numberField(NUMBERS.raster_max_mpx)}
                </>
              )}

              {group === "cache" && (
                <div className="grid gap-4">
                  <p className="text-xs leading-5 text-[var(--text-dim)]">{t(lang, "perfCacheIntro")}</p>
                  {CACHE_SWITCHES.map((item) => {
                    const disabled = Boolean(item.needs && !draft[item.needs]);
                    const on = draft[item.key] && !disabled;
                    return (
                      <div key={item.key} className={`flex items-start justify-between gap-4 ${disabled ? "opacity-45" : ""}`}>
                        <div className="min-w-0">
                          <p id={`perf-${item.key}`} className="text-sm font-medium">
                            {t(lang, item.label)}
                          </p>
                          <p className="mt-0.5 text-xs leading-4 text-[var(--text-dim)]">{t(lang, item.hint)}</p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-labelledby={`perf-${item.key}`}
                          disabled={disabled}
                          onClick={() => setDraft({ ...draft, [item.key]: !draft[item.key] })}
                          className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-[var(--accent)]" : "bg-[var(--line-strong)]"}`}
                        >
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-[left] duration-150 ${on ? "left-[18px]" : "left-0.5"}`} />
                        </button>
                      </div>
                    );
                  })}
                  <div className={draft.local_cache ? "" : "pointer-events-none opacity-45"}>{numberField(NUMBERS.local_cache_mb)}</div>
                </div>
              )}

              {error && (
                <p role="alert" className="flex items-start gap-1.5 text-sm leading-5 text-[var(--danger)]">
                  <WarningCircle size={15} className="mt-0.5 shrink-0" />
                  {error}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-4">
                <button
                  type="button"
                  disabled={!dirty || busy}
                  onClick={() => void run(() => updatePerformance(draft))}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-40"
                >
                  {t(lang, "perfSave")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(resetPerformance)}
                  className="inline-flex h-9 items-center rounded-xl px-3 text-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)] disabled:opacity-40"
                >
                  {t(lang, "perfReset")}
                </button>
                <span className="ml-auto text-xs text-[var(--text-dim)]" aria-live="polite">
                  {saved ? (
                    <span className="inline-flex items-center gap-1 text-[var(--accent)]">
                      <Check size={13} weight="bold" /> {t(lang, "perfSaved")}
                    </span>
                  ) : dirty ? (
                    t(lang, "perfDirty")
                  ) : null}
                </span>
              </div>
            </div>
          )}
          {!view && !error && (
            <div className="mt-4 grid gap-2" aria-hidden>
              <span className="h-9 animate-pulse rounded-xl bg-[var(--bg)]/50" />
              <span className="h-24 animate-pulse rounded-xl bg-[var(--bg)]/50" />
            </div>
          )}
          {!view && error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
        </div>
      </div>
    </Glass>
  );
}
