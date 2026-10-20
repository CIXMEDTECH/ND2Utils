import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  ClockCounterClockwise,
  GearSix,
  GridFour,
  Moon,
  ShieldCheck,
  SignOut,
  SlidersHorizontal,
  Sun,
  Translate,
} from "@phosphor-icons/react";
import { t } from "../i18n";
import { useApp } from "../store";
import { Glass } from "./Glass";
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
  const user = useApp((s) => s.user);
  const signOut = useApp((s) => s.signOut);
  const navigate = useNavigate();
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
      <a href="#main-content" className="skip-link">
        {lang === "zh" ? "跳到主要内容" : "Skip to main content"}
      </a>
      <div className="app-chrome">
        <Glass as="header" shape="island" className="app-header">
          <Link to="/" className="group flex items-center gap-2.5 text-[var(--accent)]" aria-label="ND2Utils">
            <Mark />
            <span className="font-semibold tracking-[-0.025em] text-[var(--text)]">ND2Utils</span>
          </Link>

          <nav className="hidden items-center gap-0.5 md:flex" aria-label={lang === "zh" ? "主导航" : "Primary navigation"}>
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
            {user && (
              <Link
                to="/settings"
                className="mr-1 hidden max-w-[11rem] items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-elev)] hover:text-[var(--text)] sm:inline-flex"
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
              <span className="text-[12px]">{t(lang, "lang")}</span>
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
        </Glass>
      </div>

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
          <NavLink key={to} to={to} className="mobile-nav-link">
            {({ isActive }) => (
              <>
                <Icon size={18} weight={isActive ? "fill" : "regular"} />
                <span className="text-[10px]">{t(lang, key)}</span>
              </>
            )}
          </NavLink>
        ))}
      </Glass>
    </div>
  );
}
