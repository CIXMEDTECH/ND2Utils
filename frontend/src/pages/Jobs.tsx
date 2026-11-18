import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowRight, Broom, CheckCircle, Hourglass, SpinnerGap, StopCircle, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { t } from "../i18n";
import { jobDownloadUrl } from "../lib/api";
import { detailMessage } from "../lib/format";
import type { JobInfo } from "../lib/types";
import { useApp } from "../store";

const statusKey = {
  queued: "jobQueued",
  running: "jobRunning",
  done: "jobDone",
  error: "jobError",
} as const;

function StatusIcon({ status }: { status: JobInfo["status"] }) {
  if (status === "done") return <CheckCircle size={18} weight="fill" className="text-[var(--ok)]" />;
  if (status === "error") return <WarningCircle size={18} weight="fill" className="text-[var(--danger)]" />;
  if (status === "queued") return <Hourglass size={18} weight="duotone" className="text-[var(--accent)]" />;
  return <SpinnerGap size={18} className="animate-spin text-[var(--accent)]" />;
}

const plainButton =
  "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-sm font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]";
const dangerButton =
  "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--danger)] px-3 text-sm font-medium text-white transition-opacity hover:opacity-90";
const iconDanger =
  "inline-flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-[var(--danger)]";

export function Jobs() {
  const lang = useApp((s) => s.lang);
  const jobs = useApp((s) => s.jobs);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const removeJobs = useApp((s) => s.removeJobs);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const pickedIds = useMemo(() => jobs.filter((job) => picked.has(job.id)).map((job) => job.id), [jobs, picked]);
  const finishedIds = useMemo(() => jobs.filter((job) => job.status === "done" || job.status === "error").map((job) => job.id), [jobs]);

  function remove(ids: string[]) {
    setPicked((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    void removeJobs(ids).catch((err) => setError(detailMessage(err, lang)));
  }

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Running jobs are kept current by the global activity tracker (see Shell).
  useEffect(() => {
    void refreshJobs().catch((err) => setError(detailMessage(err, lang)));
  }, [lang, refreshJobs]);

  const dateFormatter = new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Shell dense>
      <main className="mx-auto max-w-4xl px-5 py-10 sm:py-14">
        <div className="flex items-end justify-between gap-4 border-b border-[var(--line)] pb-6">
          <div>
            <p className="font-mono text-2xs uppercase tracking-[0.16em] text-[var(--accent)]">{t(lang, "jobsEyebrow")}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{t(lang, "jobs")}</h1>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="font-mono text-xs text-[var(--text-dim)]">{jobs.length}</span>
            {pickedIds.length > 0 && (
              <>
                <button type="button" onClick={() => remove(pickedIds)} className={dangerButton}>
                  <Trash size={16} className="shrink-0" />
                  {t(lang, "jobsDeletePicked")} ({pickedIds.length})
                </button>
                <button type="button" onClick={() => setPicked(new Set())} className={plainButton}>
                  <X size={15} className="shrink-0" />
                  {t(lang, "cancel")}
                </button>
              </>
            )}
            {pickedIds.length === 0 && finishedIds.length > 0 && (
              <button type="button" onClick={() => remove(finishedIds)} className={plainButton} title={t(lang, "jobsClearFinishedHint")}>
                <Broom size={16} className="shrink-0" />
                {t(lang, "jobsClearFinished")}
              </button>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-5 text-base text-[var(--danger)]">
            {error}
          </p>
        )}

        {jobs.length === 0 && (
          <div className="flex min-h-72 flex-col items-center justify-center text-center">
            <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <ArrowDown size={24} weight="duotone" />
            </span>
            <p className="max-w-sm text-md leading-6 text-[var(--text-dim)]">{t(lang, "noJobs")}</p>
            <Link to="/workspace" className="text-action mt-4">
              {t(lang, "goWorkspace")}
              <ArrowRight size={14} />
            </Link>
          </div>
        )}

        <ul className="grid gap-3">
          {jobs.map((job) => (
            <li key={job.id} className="py-2">
              <Glass shape="card" className="grid gap-4 p-4 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto] sm:items-center">
                <input
                  type="checkbox"
                  checked={picked.has(job.id)}
                  onChange={() => togglePick(job.id)}
                  aria-label={t(lang, "jobsPick")}
                  className="h-4 w-4"
                />
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg)]/40 shadow-[inset_0_0_0_1px_var(--line)]">
                  <StatusIcon status={job.status} />
                </span>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="font-mono text-sm font-medium uppercase tracking-wide">
                      {job.format ?? "export"} · {job.file_ids.length} {t(lang, "nFiles")}
                    </p>
                    <time className="font-mono text-2xs text-[var(--text-dim)]">
                      {dateFormatter.format(new Date(job.created_at * 1000))}
                    </time>
                  </div>
                  {(job.download_name || job.label) && (
                    <p className="mt-1 truncate font-mono text-xs text-[var(--text)]" title={job.download_name ?? job.label ?? undefined}>
                      {job.download_name ?? `/${job.label}`}
                    </p>
                  )}
                  <p className={`mt-1 text-sm ${job.status === "error" ? "text-[var(--danger)]" : "text-[var(--text-dim)]"}`}>
                    {job.status === "error" ? t(lang, "exportFailedHint") : t(lang, statusKey[job.status])}
                    {job.status === "error" && job.error ? ` (${job.error})` : ""}
                  </p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${job.status === "error" ? "bg-[var(--danger)]" : "bg-[var(--accent)]"}`}
                      style={{ width: `${Math.round((job.progress || 0) * 100)}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:justify-end">
                  {job.status === "done" && (
                    <a
                      href={jobDownloadUrl(job.id)}
                      className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-strong)]"
                    >
                      <ArrowDown size={15} />
                      {t(lang, "download")}
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => remove([job.id])}
                    className={job.status === "queued" || job.status === "running" ? plainButton : iconDanger}
                    title={t(lang, job.status === "queued" || job.status === "running" ? "jobCancel" : "jobDelete")}
                    aria-label={t(lang, job.status === "queued" || job.status === "running" ? "jobCancel" : "jobDelete")}
                  >
                    {job.status === "queued" || job.status === "running" ? (
                      <>
                        <StopCircle size={16} className="shrink-0" />
                        {t(lang, "jobCancel")}
                      </>
                    ) : (
                      <Trash size={17} />
                    )}
                  </button>
                </div>
              </Glass>
            </li>
          ))}
        </ul>
      </main>
    </Shell>
  );
}
