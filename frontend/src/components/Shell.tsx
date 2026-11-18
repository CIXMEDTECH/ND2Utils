import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  ChartBar,
  ClockCounterClockwise,
  FolderOpen,
  GearSix,
  Moon,
  ShieldCheck,
  SignOut,
  SlidersHorizontal,
  SquaresFour,
  Sun,
  Translate,
} from "@phosphor-icons/react";
import { t } from "../i18n";
import { clientSettings } from "../lib/api";
import { APP_VERSION } from "../lib/version";
import { useActivityTracker } from "../lib/activity";
import { ActivityIndicator, ActivityLine } from "./Activity";
import { useApp } from "../store";
import { Glass } from "./Glass";
import { Mark } from "./Mark";

// Task order: bring files in, look at them, edit, quantify, take results out.
const nav = [
  { to: "/workspace", key: "navFiles" as const, Icon: FolderOpen },
  { to: "/advanced", key: "navView" as const, Icon: SlidersHorizontal },
  { to: "/studio", key: "navEdit" as const, Icon: SquaresFour },
  { to: "/analysis", key: "navAnalyze" as const, Icon: ChartBar },
  { to: "/jobs", key: "navExports" as const, Icon: ClockCounterClockwise },
  { to: "/settings", key: "settings" as const, Icon: GearSix },
];

export function Shell({ children, dense = false }: { children: React.ReactNode; dense?: boolean }) {
  const lang = useApp((s) => s.lang);
  const theme = useApp((s) => s.theme);
  const setLang = useApp((s) => s.setLang);
  const setTheme = useApp((s) => s.setTheme);
  const user = useApp((s) => s.user);
  const signOut = useApp((s) => s.signOut);
  const navigate = useNavigate();
  useActivityTracker();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const [version, setVersion] = useState(APP_VERSION);

  useEffect(() => {
    let alive = true;
    clientSettings()
      .then((s) => alive && s.version && setVersion(s.version))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <div className="min-h-[100dvh] pb-16 text-[var(--text)] md:pb-0">
      <a href="#main-content" className="skip-link">
        {lang === "zh" ? "跳到主要内容" : "Skip to main content"}
      </a>
      <div className={`app-chrome ${dense ? "app-chrome--dense" : ""}`}>
        <Glass as="header" shape="island" className="app-header">
          <Link to="/" className="group flex items-center gap-2.5 text-[var(--accent)]" aria-label={t(lang, "app")}>
            <Mark />
            <span className="whitespace-nowrap font-semibold tracking-[-0.025em] text-[var(--text)]">{t(lang, "app")}</span>
            <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-2xs font-medium text-[var(--accent)]">
              v{version}
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label={lang === "zh" ? "主导航" : "Primary navigation"}>
            {nav.map(({ to, key, Icon }) => (
              <NavLink key={to} to={to} className="nav-link">
                {({ isActive }) => (
                  <>
                    <Icon size={14} weight={isActive ? "fill" : "regular"} />
                    <span>{t(lang, key)}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-1">
            <ActivityIndicator />
            {user && (
              <Link
                to="/settings"
                className="mr-1 hidden max-w-[11rem] items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--bg)]/60 px-2.5 py-1 text-xs text-[var(--text-dim)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text)] sm:inline-flex"
                title={t(lang, "accountTitle")}
              >
                {user.role === "admin" && <ShieldCheck size={14} weight="fill" className="shrink-0 text-[var(--accent)]" />}
                <span className="truncate">{user.label || t(lang, user.role === "admin" ? "roleAdmin" : "roleUser")}</span>
              </Link>
            )}
            <button
              type="button"
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
              className="icon-action language-action gap-1.5 px-2.5"
              aria-label={t(lang, "switchLanguage")}
              title={t(lang, "switchLanguage")}
            >
              <Translate size={16} />
              <span className="text-sm">{t(lang, "lang")}</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme(dark ? "light" : "dark")}
              className="icon-action"
              aria-label={t(lang, dark ? "switchToLight" : "switchToDark")}
              title={t(lang, dark ? "switchToLight" : "switchToDark")}
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              type="button"
              onClick={() => void signOut().finally(() => navigate("/"))}
              className="icon-action"
              aria-label={t(lang, "signOut")}
              title={t(lang, "signOut")}
            >
              <SignOut size={16} />
            </button>
          </div>
          <ActivityLine />
        </Glass>
      </div>

      <div id="main-content" tabIndex={-1}>
        {children}
      </div>

      {!dense && (
        <footer className="px-6 py-9 text-center text-sm leading-5 text-[var(--text-dim)]">
          {t(lang, "legal")}
        </footer>
      )}

      <Glass as="nav" shape="dock" className="mobile-nav md:hidden" aria-label={lang === "zh" ? "主导航" : "Primary navigation"}>
        {nav.map(({ to, key, Icon }) => (
          <NavLink key={to} to={to} className="mobile-nav-link">
            {({ isActive }) => (
              <>
                <Icon size={18} weight={isActive ? "fill" : "regular"} />
                <span className="text-2xs">{t(lang, key)}</span>
              </>
            )}
          </NavLink>
        ))}
      </Glass>
    </div>
  );
}
