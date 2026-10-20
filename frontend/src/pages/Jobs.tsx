import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowRight, CheckCircle, Hourglass, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
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

export function Jobs() {
  const lang = useApp((s) => s.lang);
  const jobs = useApp((s) => s.jobs);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const [error, setError] = useState<string | null>(null);

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
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">{t(lang, "jobsEyebrow")}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{t(lang, "jobs")}</h1>
          </div>
          <span className="font-mono text-[11px] text-[var(--text-dim)]">{jobs.length}</span>
        </div>

        {error && (
          <p role="alert" className="mt-5 text-[13px] text-[var(--danger)]">
            {error}
          </p>
        )}

        {jobs.length === 0 && (
          <div className="flex min-h-72 flex-col items-center justify-center text-center">
            <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <ArrowDown size={24} weight="duotone" />
            </span>
            <p className="max-w-sm text-[14px] leading-6 text-[var(--text-dim)]">{t(lang, "noJobs")}</p>
            <Link to="/workspace" className="text-action mt-4">
              {t(lang, "goWorkspace")}
              <ArrowRight size={14} />
            </Link>
          </div>
        )}

        <ul className="grid gap-3">
          {jobs.map((job) => (
            <li key={job.id} className="py-2">
              <Glass shape="card" className="grid gap-4 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg)]/40 shadow-[inset_0_0_0_1px_var(--line)]">
                  <StatusIcon status={job.status} />
                </span>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="font-mono text-[12px] font-medium uppercase tracking-wide">
                      {job.format ?? "export"} · {job.file_ids.length} {t(lang, "nFiles")}
                    </p>
                    <time className="font-mono text-[10px] text-[var(--text-dim)]">
                      {dateFormatter.format(new Date(job.created_at * 1000))}
                    </time>
                  </div>
                  {(job.download_name || job.label) && (
                    <p className="mt-1 truncate font-mono text-[11px] text-[var(--text)]" title={job.download_name ?? job.label ?? undefined}>
                      {job.download_name ?? `/${job.label}`}
                    </p>
                  )}
                  <p className={`mt-1 text-[12px] ${job.status === "error" ? "text-[var(--danger)]" : "text-[var(--text-dim)]"}`}>
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

                {job.status === "done" && (
                  <a
                    href={jobDownloadUrl(job.id)}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[var(--accent-strong)]"
                  >
                    <ArrowDown size={14} />
                    {t(lang, "download")}
                  </a>
                )}
              </Glass>
            </li>
          ))}
        </ul>
      </main>
    </Shell>
  );
}
