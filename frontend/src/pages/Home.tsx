import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUpRight, Export as ExportIcon, Eye, UploadSimple } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Shell } from "../components/Shell";
import { DropZone } from "../components/DropZone";
import { Glass } from "../components/Glass";
import { Magnetic } from "../components/Magnetic";
import { t } from "../i18n";
import { useApp } from "../store";

const ease = [0.16, 1, 0.3, 1] as const;

export function Home() {
  const lang = useApp((s) => s.lang);
  const nav = useNavigate();
  const reduce = useReducedMotion();

  const steps = [
    { k: "stepUpload" as const, b: "stepUploadBody" as const, Icon: UploadSimple },
    { k: "stepInspect" as const, b: "stepInspectBody" as const, Icon: Eye },
    { k: "stepExport" as const, b: "stepExportBody" as const, Icon: ExportIcon },
  ];

  return (
    <Shell>
      <section className="home-hero relative overflow-hidden">
        <div className="ambient-orb ambient-orb-left" aria-hidden />
        <div className="ambient-orb ambient-orb-right" aria-hidden />
        <div className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-[1280px] grid-cols-1 items-center gap-12 px-5 py-14 lg:grid-cols-[0.88fr_1.12fr] lg:gap-20 lg:py-20">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.72, ease }}
            className="relative z-[1]"
          >
            <p className="mb-5 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--accent)]">
              {t(lang, "homeEyebrow")}
            </p>
            <h1 className="max-w-[12ch] text-[clamp(2.8rem,6vw,5.6rem)] font-semibold leading-[0.98] tracking-[-0.055em] text-balance">
              {t(lang, "tagline")}
            </h1>
            <p className="mt-7 max-w-[48ch] text-[15px] leading-7 text-[var(--text-dim)] text-pretty md:text-[16px]">
              {t(lang, "sub")}
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Magnetic>
                <button
                  type="button"
                  onClick={() => document.getElementById("home-nd2-upload")?.click()}
                  className="primary-action group"
                >
                  {t(lang, "chooseFiles")}
                  <ArrowDown size={15} className="transition-transform duration-300 group-hover:translate-y-0.5" />
                </button>
              </Magnetic>
              <Link to="/workspace" className="text-action group">
                {t(lang, "goWorkspace")}
                <ArrowUpRight size={15} className="transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </Link>
            </div>
          </motion.div>

          <motion.div
            initial={reduce ? false : { opacity: 0, x: 26, scale: 0.985 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={{ duration: 0.82, delay: 0.08, ease }}
            className="relative z-[1]"
          >
            <DropZone inputId="home-nd2-upload" />
          </motion.div>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 pb-24 pt-8 md:pb-28">
        <ol className="grid gap-5 md:grid-cols-3 md:gap-6">
          {steps.map(({ k, b, Icon }, i) => (
            <motion.li
              key={k}
              initial={reduce ? false : { opacity: 0, y: 22, rotateX: 8 }}
              whileInView={{ opacity: 1, y: 0, rotateX: 0 }}
              viewport={{ once: true, amount: 0.45 }}
              transition={{ type: "spring", bounce: 0.12, duration: 0.7, delay: i * 0.08 }}
              className={i === 1 ? "md:translate-y-8" : ""}
              style={{ transformPerspective: 800 }}
            >
              <Glass shape="card" className="h-full p-6">
                <div className="flex items-center justify-between">
                  <Icon size={20} weight="duotone" className="text-[var(--accent)]" />
                  <span className="font-mono text-[11px] text-[var(--text-dim)]">0{i + 1}</span>
                </div>
                <h2 className="mt-8 text-lg font-semibold tracking-[-0.02em]">{t(lang, k)}</h2>
                <p className="mt-3 max-w-[34ch] text-[13px] leading-6 text-[var(--text-dim)] text-pretty">
                  {t(lang, b)}
                </p>
              </Glass>
            </motion.li>
          ))}
        </ol>
      </section>

      <section className="advanced-callout relative overflow-hidden bg-[var(--well)] px-5 py-20 text-[#eef1f2]">
        <div className="callout-glow" aria-hidden />
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.65, ease }}
          className="relative mx-auto flex max-w-[1280px] flex-col items-start justify-between gap-8 md:flex-row md:items-end"
        >
          <h2 className="max-w-[34ch] text-[clamp(1.4rem,3vw,2.3rem)] font-medium leading-tight tracking-[-0.035em] text-balance">
            {t(lang, "advancedStrip")}
          </h2>
          <Magnetic>
            <button type="button" onClick={() => nav("/advanced")} className="dark-action group shrink-0">
              {t(lang, "enterAdvanced")}
              <ArrowUpRight size={15} className="transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </button>
          </Magnetic>
        </motion.div>
      </section>
    </Shell>
  );
}
