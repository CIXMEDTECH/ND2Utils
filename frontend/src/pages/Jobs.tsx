import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowRight, CheckCircle, Hourglass, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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

function StatusIcon({ status, spinning }: { status: JobInfo["status"]; spinning: boolean }) {
  if (status === "done") return <CheckCircle size={18} weight="fill" className="text-[var(--ok)]" />;
  if (status === "error") return <WarningCircle size={18} weight="fill" className="text-[var(--danger)]" />;
  if (status === "queued") return <Hourglass size={18} weight="duotone" className="text-[var(--accent)]" />;
  return (
    <motion.span animate={spinning ? { rotate: 360 } : undefined} transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}>
      <SpinnerGap size={18} className="text-[var(--accent)]" />
    </motion.span>
  );
}

export function Jobs() {
  const lang = useApp((s) => s.lang);
  const jobs = useApp((s) => s.jobs);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const reduce = useReducedMotion();
  const [error, setError] = useState<string | null>(null);
  const active = jobs.some((job) => job.status === "queued" || job.status === "running");

  useEffect(() => {
    void refreshJobs().catch((err) => setError(detailMessage(err, lang)));
  }, [lang, refreshJobs]);

  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => {
      void refreshJobs().catch((err) => setError(detailMessage(err, lang)));
    }, 1500);
    return () => window.clearInterval(handle);
  }, [active, lang, refreshJobs]);

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

        <AnimatePresence>
          {error && (
            <motion.p
              role="alert"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-5 text-[13px] text-[var(--danger)]"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        {jobs.length === 0 && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex min-h-72 flex-col items-center justify-center text-center"
          >
            <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <ArrowDown size={24} weight="duotone" />
            </span>
            <p className="max-w-sm text-[14px] leading-6 text-[var(--text-dim)]">{t(lang, "noJobs")}</p>
            <Link to="/workspace" className="text-action group mt-4">
              {t(lang, "goWorkspace")}
              <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </motion.div>
        )}

        <motion.ul layout className="grid gap-3">
          <AnimatePresence initial={false}>
            {jobs.map((job, index) => (
              <motion.li
                layout
                key={job.id}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, x: -12 }}
                transition={{ delay: Math.min(index * 0.035, 0.18) }}
                className="py-2"
              >
                <Glass shape="card" className="grid gap-4 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg)]/40 shadow-[inset_0_0_0_1px_var(--line)]">
                  <StatusIcon status={job.status} spinning={!reduce} />
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
                  <p className={`mt-1 text-[12px] ${job.status === "error" ? "text-[var(--danger)]" : "text-[var(--text-dim)]"}`}>
                    {job.status === "error" ? t(lang, "exportFailedHint") : t(lang, statusKey[job.status])}
                  </p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
                    <motion.div
                      className={`h-full rounded-full ${job.status === "error" ? "bg-[var(--danger)]" : "bg-[var(--accent)]"}`}
                      animate={{ width: `${Math.round((job.progress || 0) * 100)}%` }}
                      transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                </div>

                {job.status === "done" && (
                  <motion.a
                    initial={reduce ? false : { opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    href={jobDownloadUrl(job.id)}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-[12px] font-medium text-white transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-strong)] active:scale-[0.98]"
                  >
                    <ArrowDown size={14} />
                    {t(lang, "download")}
                  </motion.a>
                )}
                </Glass>
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      </main>
    </Shell>
  );
}
