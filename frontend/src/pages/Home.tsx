import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChartBar, FolderOpen, SlidersHorizontal, SquaresFour } from "@phosphor-icons/react";
import { DropZone } from "../components/DropZone";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { t, type MsgKey } from "../i18n";
import { listAnalyses, listProjects, type AnalysisInfo } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { ProjectInfo } from "../lib/types";
import { useApp } from "../store";

const TASKS: { to: string; title: MsgKey; body: MsgKey; Icon: typeof FolderOpen }[] = [
  { to: "/workspace", title: "taskImport", body: "taskImportBody", Icon: FolderOpen },
  { to: "/advanced", title: "taskInspect", body: "taskInspectBody", Icon: SlidersHorizontal },
  { to: "/studio", title: "taskEdit", body: "taskEditBody", Icon: SquaresFour },
  { to: "/analysis", title: "taskAnalyze", body: "taskAnalyzeBody", Icon: ChartBar },
];

/** Start page: drop files in, or jump straight to a task (it used to describe a single
 * upload → view → export flow; editing and statistics are first-class tasks now). */
export function Home() {
  const lang = useApp((s) => s.lang);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisInfo[] | null>(null);

  useEffect(() => {
    void listProjects()
      .then((p) => setProjects(p.slice(0, 4)))
      .catch(() => setProjects([]));
    void listAnalyses()
      .then((a) => setAnalyses(a.slice(0, 4)))
      .catch(() => setAnalyses([]));
  }, []);

  const recent = (
    title: MsgKey,
    items: { id: string; name: string; to: string; when: number; meta: string }[] | null,
    Icon: typeof FolderOpen,
  ) => (
    <Glass shape="card" className="p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon size={17} weight="duotone" className="text-[var(--accent)]" />
        {t(lang, title)}
      </h3>
      {items === null ? (
        <div className="mt-3 h-16 animate-pulse rounded-lg bg-[var(--bg)]/50" />
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-dim)]">{t(lang, "nothingYet")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--line)]">
          {items.map((item) => (
            <li key={item.id}>
              <Link to={item.to} className="flex items-center gap-3 py-2 text-sm hover:text-[var(--accent)]">
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 font-mono text-2xs text-[var(--text-dim)]">{item.meta}</span>
                <span className="hidden shrink-0 text-2xs text-[var(--text-dim)] sm:block">{formatDateTime(item.when, lang)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Glass>
  );

  return (
    <Shell>
      <section className="home-hero relative overflow-hidden">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 items-center gap-10 px-5 py-12 lg:grid-cols-[1fr_1fr] lg:gap-16 lg:py-16">
          <div className="relative z-[1]">
            <p className="mb-4 font-mono text-xs font-medium uppercase tracking-[0.18em] text-[var(--accent)]">{t(lang, "homeKicker")}</p>
            <h1 className="max-w-[16ch] text-[clamp(2.2rem,4.6vw,4rem)] font-semibold leading-[1.05] tracking-[-0.045em] text-balance">
              {t(lang, "homeHeadline")}
            </h1>
            <p className="mt-6 max-w-[52ch] text-md leading-7 text-[var(--text-dim)] text-pretty">{t(lang, "homeLead")}</p>
          </div>
          <div className="relative z-[1]">
            <DropZone inputId="home-nd2-upload" />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 pb-10">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TASKS.map(({ to, title, body, Icon }) => (
            <li key={to}>
              <Link to={to} className="group block h-full">
                <Glass shape="card" className="flex h-full flex-col p-5 transition-transform group-hover:-translate-y-0.5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Icon size={22} weight="duotone" />
                  </span>
                  <h2 className="mt-5 text-lg font-semibold tracking-[-0.02em]">{t(lang, title)}</h2>
                  <p className="mt-2 flex-1 text-sm leading-6 text-[var(--text-dim)] text-pretty">{t(lang, body)}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--accent)]">
                    {t(lang, "open")}
                    <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Glass>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 pb-24">
        <h2 className="mb-4 text-md font-semibold">{t(lang, "continueWork")}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {recent(
            "recentProjects",
            projects &&
              projects.map((p) => ({ id: p.id, name: p.name, to: `/studio/${p.id}`, when: p.updated_at || p.created_at, meta: `${p.file_ids.length} ${t(lang, "nFiles")}` })),
            SquaresFour,
          )}
          {recent(
            "recentAnalyses",
            analyses &&
              analyses.map((a) => ({ id: a.id, name: a.name, to: `/analysis/${a.id}`, when: a.updated_at, meta: `${a.file_count} ${t(lang, "nFiles")}` })),
            ChartBar,
          )}
        </div>
      </section>
    </Shell>
  );
}
