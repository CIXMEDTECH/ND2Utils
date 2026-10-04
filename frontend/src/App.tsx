import { Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { t } from "./i18n";
import { lazyPage } from "./lib/lazyPage";
import { useApp } from "./store";

const Home = lazyPage(() => import("./pages/Home").then((module) => module.Home));
const Workspace = lazyPage(() => import("./pages/Workspace").then((module) => module.Workspace));
const Advanced = lazyPage(() => import("./pages/Advanced").then((module) => module.Advanced));
const Jobs = lazyPage(() => import("./pages/Jobs").then((module) => module.Jobs));
const Settings = lazyPage(() => import("./pages/Settings").then((module) => module.Settings));
const Login = lazyPage(() => import("./pages/Login").then((module) => module.Login));

export function App() {
  const lang = useApp((s) => s.lang);
  const user = useApp((s) => s.user);
  const authChecked = useApp((s) => s.authChecked);
  const checkAuth = useApp((s) => s.checkAuth);
  const location = useLocation();
  const reduce = useReducedMotion();
  const sessionExpired = useApp((s) => s.sessionExpired);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  useEffect(() => {
    void checkAuth().catch(() => undefined);
  }, [checkAuth]);

  const fallback = (
    <div role="status" className="flex min-h-[100dvh] items-center justify-center gap-2 bg-[var(--bg)] font-mono text-[11px] text-[var(--text-dim)]">
      <motion.span
        animate={reduce ? undefined : { rotate: 360 }}
        transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
        className="h-3.5 w-3.5 rounded-full border border-[var(--line-strong)] border-t-[var(--accent)]"
      />
      {t(lang, "loadingPage")}
    </div>
  );

  if (!authChecked) return fallback;
  if (!user) {
    return (
      <Suspense fallback={fallback}>
        <Login sessionEnded={sessionExpired} />
      </Suspense>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? undefined : { opacity: 0, y: -8 }}
        transition={{ type: "spring", bounce: 0, duration: 0.45 }}
        className="min-h-[100dvh]"
      >
        <Suspense fallback={fallback}>
          <Routes location={location}>
            <Route path="/" element={<Home />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/advanced" element={<Advanced />} />
            <Route path="/advanced/:fileId" element={<Advanced />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </motion.div>
    </AnimatePresence>
  );
}
