import { useEffect, useState } from "react";
import { Database, IdentificationCard, MoonStars, Translate } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AdminCodes } from "../components/AdminCodes";
import { AdminPerformance } from "../components/AdminPerformance";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { t } from "../i18n";
import { serverSettings } from "../lib/api";
import { detailMessage, formatBytes, formatDateTime } from "../lib/format";
import { useApp } from "../store";

export function Settings() {
  const lang = useApp((s) => s.lang);
  const theme = useApp((s) => s.theme);
  const setLang = useApp((s) => s.setLang);
  const setTheme = useApp((s) => s.setTheme);
  const user = useApp((s) => s.user);
  const reduce = useReducedMotion();
  const [info, setInfo] = useState<{ max_upload_bytes: number; ttl_hours: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void serverSettings()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch((err) => {
        if (!cancelled) setError(detailMessage(err, lang));
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  return (
    <Shell dense>
      <main className="mx-auto max-w-2xl px-5 py-10 sm:py-14">
        <div className="border-b border-[var(--line)] pb-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">{t(lang, "settingsEyebrow")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{t(lang, "settings")}</h1>
          <p className="mt-3 text-[13px] leading-5 text-[var(--text-dim)]">{t(lang, "settingsIntro")}</p>
        </div>

        <div className="mt-7 grid gap-4">
          {user && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", bounce: 0.12, duration: 0.55 }}
            >
              <Glass as="section" shape="card" className="p-5 sm:p-6">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                    <IdentificationCard size={18} weight="duotone" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[14px] font-semibold">{t(lang, "accountTitle")}</h2>
                    <dl className="mt-4 grid gap-2 rounded-xl bg-[var(--bg)]/50 p-3 text-[12px]">
                      {[
                        [t(lang, "codeLabel"), user.label || "—"],
                        [t(lang, "codeKind"), `${t(lang, user.role === "admin" ? "roleAdmin" : "roleUser")} · ${t(lang, user.kind === "permanent" ? "kindPermanent" : "kindTemporary")}`],
                        [t(lang, "expiresAt"), user.expires_at ? formatDateTime(user.expires_at, lang) : t(lang, "expiresNever")],
                        [t(lang, "usage"), `${user.usage.files} ${t(lang, "nFiles")} · ${formatBytes(user.usage.bytes, lang)}`],
                      ].map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between gap-4">
                          <dt className="text-[var(--text-dim)]">{k}</dt>
                          <dd className="truncate text-right font-mono text-[11px] tabular-nums">{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-[12px] leading-5 text-[var(--text-dim)]">
                      {user.kind === "permanent"
                        ? t(lang, "permanentNote")
                        : `${t(lang, "temporaryNote")} ${info?.ttl_hours ?? "…"} ${t(lang, "temporaryNoteTail")}`}
                    </p>
                  </div>
                </div>
              </Glass>
            </motion.div>
          )}

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0.12, duration: 0.55 }}
          >
            <Glass as="section" shape="card" className="p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Translate size={18} weight="duotone" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[14px] font-semibold">{t(lang, "settingsLang")}</h2>
                  <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-[var(--bg)]/50 p-1">
                    {(["zh", "en"] as const).map((key) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={lang === key}
                        onClick={() => setLang(key)}
                        className={`relative h-9 rounded-lg text-[12px] transition-colors ${lang === key ? "text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
                      >
                        {lang === key && (
                          <motion.span
                            layoutId="language-setting"
                            className="absolute inset-0 rounded-lg bg-[var(--text)]"
                            transition={{ type: "spring", stiffness: 400, damping: 32 }}
                          />
                        )}
                        <span className="relative z-[1]">{key === "zh" ? "中文" : "English"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Glass>
          </motion.div>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0.12, duration: 0.55, delay: 0.06 }}
          >
            <Glass as="section" shape="card" className="p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                  <MoonStars size={18} weight="duotone" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[14px] font-semibold">{t(lang, "settingsTheme")}</h2>
                  <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-[var(--bg)]/50 p-1">
                    {(["light", "dark", "system"] as const).map((key) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={theme === key}
                        onClick={() => setTheme(key)}
                        className={`relative h-9 rounded-lg text-[12px] transition-colors ${theme === key ? "text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
                      >
                        {theme === key && (
                          <motion.span
                            layoutId="theme-setting"
                            className="absolute inset-0 rounded-lg bg-[var(--text)]"
                            transition={{ type: "spring", stiffness: 400, damping: 32 }}
                          />
                        )}
                        <span className="relative z-[1]">
                          {t(lang, key === "light" ? "themeLight" : key === "dark" ? "themeDark" : "themeSystem")}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Glass>
          </motion.div>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0.12, duration: 0.55, delay: 0.12 }}
          >
            <Glass as="section" shape="card" className="p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Database size={18} weight="duotone" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[14px] font-semibold">{t(lang, "settingsStorage")}</h2>
                  <p className="mt-2 text-[12px] leading-5 text-[var(--text-dim)]">{t(lang, "settingsStorageHint")}</p>
                  {info ? (
                    <dl className="mt-4 grid gap-2 rounded-xl bg-[var(--bg)]/50 p-3 font-mono text-[11px] tabular-nums">
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-[var(--text-dim)]">{t(lang, "maxUpload")}</dt>
                        <dd>{formatBytes(info.max_upload_bytes, lang)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-[var(--text-dim)]">{t(lang, "retention")}</dt>
                        <dd>{info.ttl_hours} {t(lang, "hours")}</dd>
                      </div>
                    </dl>
                  ) : !error ? (
                    <div className="mt-4 grid gap-2" aria-hidden>
                      <span className="h-9 animate-pulse rounded-xl bg-[var(--bg)]/50" />
                      <span className="h-9 animate-pulse rounded-xl bg-[var(--bg)]/50" />
                    </div>
                  ) : null}
                </div>
              </div>
            </Glass>
          </motion.div>

          {user?.role === "admin" && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", bounce: 0.12, duration: 0.55, delay: 0.18 }}
            >
              <AdminCodes />
            </motion.div>
          )}

          {user?.role === "admin" && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", bounce: 0.12, duration: 0.55, delay: 0.24 }}
            >
              <AdminPerformance />
            </motion.div>
          )}
        </div>

        <AnimatePresence>
          {error && (
            <motion.p
              role="alert"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-5 text-[12px] text-[var(--danger)]"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <p className="mx-auto mt-8 max-w-lg text-center text-[11px] leading-5 text-[var(--text-dim)]">{t(lang, "legal")}</p>
      </main>
    </Shell>
  );
}
