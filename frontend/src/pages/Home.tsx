import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUpRight, Export as ExportIcon, Eye, UploadSimple } from "@phosphor-icons/react";
import { Shell } from "../components/Shell";
import { DropZone } from "../components/DropZone";
import { Glass } from "../components/Glass";
import { t } from "../i18n";
import { useApp } from "../store";

export function Home() {
  const lang = useApp((s) => s.lang);
  const nav = useNavigate();

  const steps = [
    { k: "stepUpload" as const, b: "stepUploadBody" as const, Icon: UploadSimple },
    { k: "stepInspect" as const, b: "stepInspectBody" as const, Icon: Eye },
    { k: "stepExport" as const, b: "stepExportBody" as const, Icon: ExportIcon },
  ];

  return (
    <Shell>
      <section className="home-hero relative overflow-hidden">
        <div className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-[1280px] grid-cols-1 items-center gap-12 px-5 py-14 lg:grid-cols-[0.88fr_1.12fr] lg:gap-20 lg:py-20">
          <div className="relative z-[1]">
            <p className="mb-5 font-mono text-xs font-medium uppercase tracking-[0.18em] text-[var(--accent)]">
              {t(lang, "homeEyebrow")}
            </p>
            <h1 className="max-w-[12ch] text-[clamp(2.8rem,6vw,5.6rem)] font-semibold leading-[0.98] tracking-[-0.055em] text-balance">
              {t(lang, "tagline")}
            </h1>
            <p className="mt-7 max-w-[48ch] text-md leading-7 text-[var(--text-dim)] text-pretty md:text-md">
              {t(lang, "sub")}
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => document.getElementById("home-nd2-upload")?.click()}
                className="primary-action"
              >
                {t(lang, "chooseFiles")}
                <ArrowDown size={15} />
              </button>
              <Link to="/workspace" className="text-action">
                {t(lang, "goWorkspace")}
                <ArrowUpRight size={15} />
              </Link>
            </div>
          </div>

          <div className="relative z-[1]">
            <DropZone inputId="home-nd2-upload" />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 pb-24 pt-8 md:pb-28">
        <ol className="grid gap-5 md:grid-cols-3 md:gap-6">
          {steps.map(({ k, b, Icon }, i) => (
            <li key={k} className={i === 1 ? "md:translate-y-8" : ""}>
              <Glass shape="card" className="h-full p-6">
                <div className="flex items-center justify-between">
                  <Icon size={20} weight="duotone" className="text-[var(--accent)]" />
                  <span className="font-mono text-xs text-[var(--text-dim)]">0{i + 1}</span>
                </div>
                <h2 className="mt-8 text-lg font-semibold tracking-[-0.02em]">{t(lang, k)}</h2>
                <p className="mt-3 max-w-[34ch] text-base leading-6 text-[var(--text-dim)] text-pretty">
                  {t(lang, b)}
                </p>
              </Glass>
            </li>
          ))}
        </ol>
      </section>

      <section className="advanced-callout relative overflow-hidden bg-[var(--well)] px-5 py-20 text-[#eef1f2]">
        <div className="callout-glow" aria-hidden />
        <div className="relative mx-auto flex max-w-[1280px] flex-col items-start justify-between gap-8 md:flex-row md:items-end">
          <h2 className="max-w-[34ch] text-[clamp(1.4rem,3vw,2.3rem)] font-medium leading-tight tracking-[-0.035em] text-balance">
            {t(lang, "advancedStrip")}
          </h2>
          <button type="button" onClick={() => nav("/advanced")} className="dark-action shrink-0">
            {t(lang, "enterAdvanced")}
            <ArrowUpRight size={15} />
          </button>
        </div>
      </section>
    </Shell>
  );
}
