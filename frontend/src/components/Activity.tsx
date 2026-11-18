import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { CheckCircle, DownloadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { t, type MsgKey } from "../i18n";
import { type Task, useTasks } from "../lib/activity";
import { jobDownloadUrl } from "../lib/api";
import type { Lang } from "../lib/types";
import { useApp } from "../store";

const TITLES: Record<Task["kind"], MsgKey> = {
  upload: "actUpload",
  prepare: "actPrepare",
  cache: "actCache",
  export: "actExport",
};

const isRunning = (task: Task) => task.state === "running" || task.state === "queued";
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

function title(task: Task, lang: Lang): string {
  if (task.kind === "export" && task.state === "done") return t(lang, "actExportDone");
  if (task.kind === "export" && task.state === "error") return t(lang, "actExportFailed");
  return t(lang, TITLES[task.kind]);
}

/** Short status for the header pill: "38%", "3/10", "排队中". */
function short(task: Task, lang: Lang): string {
  if (task.state === "queued") return t(lang, "jobQueued");
  if (task.total) return `${task.done}/${task.total}`;
  return task.ratio == null ? "" : percent(task.ratio);
}

function detail(task: Task, lang: Lang): string {
  if (task.kind === "upload") return task.text ?? "";
  if (task.kind === "export") return [task.text, isRunning(task) ? short(task, lang) : ""].filter(Boolean).join(" · ");
  return `${task.done}/${task.total} ${t(lang, "nFiles")}`;
}

/** Overall progress of the running tasks; null when none of them knows its progress. */
function overall(tasks: Task[]): number | null {
  const known = tasks.filter((task) => isRunning(task) && task.ratio != null);
  if (!known.length) return null;
  return known.reduce((sum, task) => sum + (task.ratio ?? 0), 0) / known.length;
}

/** Thin bar along the bottom edge of the header while something runs. */
export function ActivityLine() {
  const running = useTasks().filter(isRunning);
  if (!running.length) return null;
  const ratio = overall(running);
  return (
    <span className="pointer-events-none absolute inset-x-5 bottom-0 h-0.5 overflow-hidden rounded-full bg-[var(--line)]" aria-hidden>
      <span
        className={`block h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ${ratio == null ? "progress-indeterminate" : ""}`}
        style={ratio == null ? undefined : { width: percent(Math.max(ratio, 0.02)) }}
      />
    </span>
  );
}

/** Header pill: the most important task at a glance; click for every task. */
export function ActivityIndicator() {
  const lang = useApp((s) => s.lang);
  const removeJobs = useApp((s) => s.removeJobs);
  const tasks = useTasks();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const box = buttonRef.current.getBoundingClientRect();
    setPos({ top: box.bottom + 10, right: Math.max(8, window.innerWidth - box.right - 8) });
  }, [open, tasks.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onResize = () => setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!tasks.length) setOpen(false);
  }, [tasks.length]);

  if (!tasks.length) return null;
  const running = tasks.filter(isRunning);
  const lead = running[0] ?? tasks[0];
  const failed = !running.length && tasks.some((task) => task.state === "error");
  const status = running.length ? short(lead, lang) : "";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${t(lang, "actTitle")}: ${title(lead, lang)} ${status}`}
        className={`mr-1 inline-flex h-8 max-w-[15rem] items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${
          failed
            ? "border-[color-mix(in_srgb,var(--danger)_35%,var(--line))] text-[var(--danger)]"
            : "border-[var(--line)] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--text)]"
        }`}
      >
        {running.length ? (
          <span className="spinner h-3 w-3 border-[var(--line-strong)] border-t-[var(--accent)]" />
        ) : failed ? (
          <WarningCircle size={14} weight="fill" />
        ) : (
          <CheckCircle size={14} weight="fill" className="text-[var(--ok)]" />
        )}
        <span className="hidden truncate sm:inline">{title(lead, lang)}</span>
        {status && <span className="shrink-0 font-mono tabular-nums text-[var(--text)]">{status}</span>}
        {tasks.length > 1 && <span className="shrink-0 font-mono text-2xs text-[var(--text-dim)]">+{tasks.length - 1}</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t(lang, "actTitle")}
            style={{ top: pos?.top ?? 0, right: pos?.right ?? 8, visibility: pos ? "visible" : "hidden" }}
            className="liquid-glass liquid-glass--chip fade-in fixed z-[60] w-[min(22rem,calc(100vw-1rem))] bg-[var(--bg-elev)] p-1.5 shadow-[var(--shadow)]"
          >
            <p className="px-2 pb-1 pt-1 text-xs font-medium text-[var(--text-dim)]">{t(lang, "actTitle")}</p>
            <ul className="grid gap-0.5">
              {tasks.map((task) => (
                <li key={task.key} className="rounded-lg px-2 py-2 hover:bg-[var(--bg)]/60">
                  <div className="flex items-center gap-2 text-sm">
                    {isRunning(task) ? (
                      <span className="spinner h-3 w-3 border-[var(--line-strong)] border-t-[var(--accent)]" />
                    ) : task.state === "error" ? (
                      <WarningCircle size={14} weight="fill" className="shrink-0 text-[var(--danger)]" />
                    ) : (
                      <CheckCircle size={14} weight="fill" className="shrink-0 text-[var(--ok)]" />
                    )}
                    <span className="font-medium">{title(task, lang)}</span>
                    {task.state === "done" && task.jobId ? (
                      <a
                        href={jobDownloadUrl(task.jobId)}
                        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                      >
                        <DownloadSimple size={13} /> {t(lang, "download")}
                      </a>
                    ) : isRunning(task) && task.ratio != null && !task.total ? (
                      <span className="ml-auto font-mono text-xs tabular-nums text-[var(--text-dim)]">{percent(task.ratio)}</span>
                    ) : null}
                    {task.jobId && (
                      <button
                        type="button"
                        onClick={() => void removeJobs([task.jobId!])}
                        className={`${task.state === "done" || (isRunning(task) && task.ratio != null && !task.total) ? "" : "ml-auto"} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-[var(--danger)]`}
                        title={t(lang, isRunning(task) ? "jobCancel" : "jobDelete")}
                        aria-label={t(lang, isRunning(task) ? "jobCancel" : "jobDelete")}
                      >
                        <X size={13} weight="bold" />
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 truncate pl-5 font-mono text-2xs text-[var(--text-dim)]" title={detail(task, lang)}>
                    {detail(task, lang)}
                  </p>
                  {isRunning(task) && (
                    <div className="ml-5 mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--line)]">
                      <div
                        className={`h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ${task.ratio == null ? "progress-indeterminate" : ""}`}
                        style={task.ratio == null ? undefined : { width: percent(Math.max(task.ratio, 0.02)) }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {tasks.some((task) => task.kind === "export") && (
              <Link
                to="/jobs"
                onClick={() => setOpen(false)}
                className="mt-1 block rounded-lg px-2 py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                {t(lang, "actAllJobs")}
              </Link>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
