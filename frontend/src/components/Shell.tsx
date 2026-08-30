import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import {
  ClockCounterClockwise,
  GearSix,
  GridFour,
  Moon,
  SlidersHorizontal,
  Sun,
  Translate,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { t } from "../i18n";
import { useApp } from "../store";
import { Glass } from "./Glass";
import { Magnetic } from "./Magnetic";
import { Mark } from "./Mark";

const nav = [
  { to: "/workspace", key: "basic" as const, Icon: GridFour },
  { to: "/advanced", key: "advanced" as const, Icon: SlidersHorizontal },
  { to: "/jobs", key: "jobs" as const, Icon: ClockCounterClockwise },
  { to: "/settings", key: "settings" as const, Icon: GearSix },
];

export function Shell({ children, dense = false }: { children: React.ReactNode; dense?: boolean }) {
  const lang = useApp((s) => s.lang);
  const theme = useApp((s) => s.theme);
  const setLang = useApp((s) => s.setLang);
  const setTheme = useApp((s) => s.setTheme);
  const reduce = useReducedMotion();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const dark = theme === "dark" || (theme === "system" && systemDark);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <div className="min-h-[100dvh] pb-16 text-[var(--text)] md:pb-0">
      <div className="app-grain" aria-hidden />
      <a href="#main-content" className="skip-link">
        {lang === "zh" ? "跳到主要内容" : "Skip to main content"}
      </a>
      <motion.div
        initial={reduce ? false : { opacity: 0, y: -14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", bounce: 0, duration: 0.55 }}
        className="app-chrome"
      >
        <Glass as="header" shape="island" className="app-header">
          <Link to="/" className="group flex items-center gap-2.5 text-[var(--accent)]" aria-label="ND2Utils">
            <motion.span
              whileHover={reduce ? undefined : { rotate: 40, scale: 1.08 }}
              transition={{ type: "spring", stiffness: 280, damping: 16 }}
              className="flex"
            >
              <Mark />
            </motion.span>
            <span className="font-semibold tracking-[-0.025em] text-[var(--text)]">ND2Utils</span>
          </Link>

          <nav className="hidden items-center gap-0.5 md:flex" aria-label={lang === "zh" ? "主导航" : "Primary navigation"}>
            {nav.map(({ to, key, Icon }) => (
              <NavLink key={to} to={to} className="nav-link relative">
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="desktop-nav-active"
                        className="absolute inset-0 rounded-full bg-[var(--text)]"
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                      />
                    )}
                    <Icon size={14} weight={isActive ? "fill" : "regular"} className="relative z-[1]" />
                    <span className="relative z-[1]">{t(lang, key)}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-1">
            <Magnetic>
              <button
                type="button"
                onClick={() => setLang(lang === "zh" ? "en" : "zh")}
                className="icon-action language-action gap-1.5 px-2.5"
                aria-label={t(lang, "switchLanguage")}
                title={t(lang, "switchLanguage")}
              >
                <Translate size={16} />
                <span className="text-[12px]">{t(lang, "lang")}</span>
              </button>
            </Magnetic>
            <Magnetic>
              <button
                type="button"
                onClick={() => setTheme(dark ? "light" : "dark")}
                className="icon-action"
                aria-label={t(lang, dark ? "switchToLight" : "switchToDark")}
                title={t(lang, dark ? "switchToLight" : "switchToDark")}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={dark ? "sun" : "moon"}
                    initial={reduce ? false : { opacity: 0, rotate: -40, scale: 0.7 }}
                    animate={{ opacity: 1, rotate: 0, scale: 1 }}
                    exit={reduce ? undefined : { opacity: 0, rotate: 40, scale: 0.7 }}
                    transition={{ type: "spring", stiffness: 420, damping: 22 }}
                    className="flex"
                  >
                    {dark ? <Sun size={16} /> : <Moon size={16} />}
                  </motion.span>
                </AnimatePresence>
              </button>
            </Magnetic>
          </div>
        </Glass>
      </motion.div>

      <div id="main-content" tabIndex={-1}>
        {children}
      </div>

      {!dense && (
        <footer className="px-6 py-9 text-center text-[12px] leading-5 text-[var(--text-dim)]">
          {t(lang, "legal")}
        </footer>
      )}

      <Glass as="nav" shape="dock" className="mobile-nav md:hidden" aria-label={lang === "zh" ? "主导航" : "Primary navigation"}>
        {nav.map(({ to, key, Icon }) => (
          <NavLink key={to} to={to} className="mobile-nav-link relative">
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="mobile-nav-active"
                    className="absolute inset-x-1 inset-y-1 rounded-xl bg-[var(--accent-soft)]"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}
                <Icon size={18} weight={isActive ? "fill" : "regular"} className="relative z-[1]" />
                <span className="relative z-[1] text-[10px]">{t(lang, key)}</span>
              </>
            )}
          </NavLink>
        ))}
      </Glass>
    </div>
  );
}
