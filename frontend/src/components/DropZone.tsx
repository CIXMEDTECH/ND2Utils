import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { t } from "../i18n";
import { uploadFile } from "../lib/api";
import { detailMessage } from "../lib/format";
import { useApp } from "../store";

type UploadProgress = {
  label: string;
  ratio: number | null;
};

export function DropZone({
  compact = false,
  inputId = "nd2-upload",
}: {
  compact?: boolean;
  inputId?: string;
}) {
  const lang = useApp((s) => s.lang);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const select = useApp((s) => s.select);
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(list: FileList | File[]) {
    if (progress) return;
    const files = [...list].filter((file) => file.name.toLowerCase().endsWith(".nd2"));
    if (!files.length) {
      setError(t(lang, "notNd2"));
      return;
    }

    setError(null);
    let lastId: string | null = null;
    let firstError: string | null = null;

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setProgress({
        label: `${t(lang, "uploading")} ${file.name} (${i + 1}/${files.length})`,
        ratio: i / files.length,
      });
      try {
        const rec = await uploadFile(file, (ratio) => {
          setProgress({
            label: `${t(lang, "uploading")} ${file.name} · ${Math.round(ratio * 100)}%`,
            ratio: (i + ratio) / files.length,
          });
        });
        lastId = rec.id;
      } catch (err) {
        firstError ??= detailMessage(err, lang);
      }
    }

    if (!lastId) {
      setProgress(null);
      setError(firstError ?? t(lang, "errorGeneric"));
      return;
    }

    try {
      setProgress({ label: t(lang, "indexing"), ratio: null });
      await refreshFiles();
      select(lastId);
      if (firstError) setError(firstError);
      nav("/workspace");
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setProgress(null);
    }
  }

  return (
    <motion.label
      htmlFor={inputId}
      aria-busy={Boolean(progress)}
      initial={reduce ? false : { opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: over ? 1.012 : 1 }}
      whileHover={reduce || progress ? undefined : { scale: 1.006 }}
      transition={{ type: "spring", stiffness: 260, damping: 24 }}
      className={`drop-zone liquid-glass group relative flex cursor-pointer flex-col items-center justify-center overflow-hidden transition-[border-color,box-shadow,transform] duration-300 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--focus)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--bg)] ${
        compact
          ? "liquid-glass--card min-h-40"
          : "liquid-glass--dark liquid-glass--island min-h-[340px] text-[#eef1f2] md:min-h-[420px]"
      } ${over ? "border-[var(--accent)] shadow-[0_20px_70px_var(--accent-glow)]" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        void handleFiles(event.dataTransfer.files);
      }}
    >
      <input
        id={inputId}
        type="file"
        accept=".nd2"
        multiple
        disabled={Boolean(progress)}
        className="sr-only"
        aria-label={t(lang, "chooseFiles")}
        onChange={(event) => {
          if (event.target.files) void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {!compact && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="stage-grid absolute inset-0 opacity-55" />
          <div className="drop-orbit drop-orbit-outer" />
          <div className="drop-orbit drop-orbit-inner" />
          <div className={`scan-line ${over ? "is-active" : ""}`} />
        </div>
      )}

      <div className="relative z-[1] flex max-w-md flex-col items-center px-6 text-center">
        <motion.span
          animate={reduce ? undefined : { y: over ? -5 : [0, -3, 0] }}
          transition={over ? { type: "spring", stiffness: 260, damping: 18 } : { duration: 4, repeat: Infinity, ease: "easeInOut" }}
          className={`${compact ? "mb-3 h-9 w-9" : "mb-7 h-14 w-14"} flex items-center justify-center rounded-2xl border border-current/15 bg-white/[0.07] text-[var(--accent)] shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]`}
        >
          <UploadSimple size={compact ? 19 : 26} weight="duotone" />
        </motion.span>

        <p className={`font-semibold tracking-[-0.02em] ${compact ? "text-[14px]" : "text-xl"}`}>
          {over ? t(lang, "dropActive") : t(lang, "drop")}
        </p>
        <p className={`mt-2 max-w-[38ch] text-[13px] leading-5 ${compact ? "text-[var(--text-dim)]" : "text-white/58"}`}>
          {t(lang, "dropHint")}
        </p>

        <AnimatePresence mode="wait" initial={false}>
          {progress && (
            <motion.div
              key="progress"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="mt-5 w-full max-w-xs"
            >
              <p className="font-mono text-[11px] text-[var(--accent)]">{progress.label}</p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                <motion.div
                  className={`h-full rounded-full bg-[var(--accent)] ${progress.ratio == null ? "progress-indeterminate" : ""}`}
                  animate={progress.ratio == null ? undefined : { width: `${Math.max(progress.ratio * 100, 3)}%` }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                />
              </div>
            </motion.div>
          )}
          {!progress && error && (
            <motion.p
              key="error"
              role="alert"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 inline-flex items-start gap-1.5 text-left text-[12px] leading-5 text-[var(--danger)]"
            >
              <WarningCircle size={15} className="mt-0.5 shrink-0" />
              {error}
            </motion.p>
          )}
          {!progress && !error && over && (
            <motion.span
              key="ready"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="mt-4 text-[var(--accent)]"
              aria-hidden
            >
              <CheckCircle size={18} weight="fill" />
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </motion.label>
  );
}
