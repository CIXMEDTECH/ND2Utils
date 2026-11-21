import { Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { t } from "./i18n";
import { lazyPage } from "./lib/lazyPage";
import { useApp } from "./store";

const Home = lazyPage(() => import("./pages/Home").then((module) => module.Home));
const Workspace = lazyPage(() => import("./pages/Workspace").then((module) => module.Workspace));
const Studio = lazyPage(() => import("./pages/Studio").then((module) => module.Studio));
const Advanced = lazyPage(() => import("./pages/Advanced").then((module) => module.Advanced));
const Slide = lazyPage(() => import("./pages/Slide").then((module) => module.Slide));
const Jobs = lazyPage(() => import("./pages/Jobs").then((module) => module.Jobs));
const AnalysisHub = lazyPage(() => import("./pages/Analysis").then((module) => module.AnalysisHub));
const CometTool = lazyPage(() => import("./pages/Analysis").then((module) => module.CometTool));
const AnalysisDetail = lazyPage(() => import("./pages/Analysis").then((module) => module.AnalysisDetail));
const AnalysisRedirect = lazyPage(() => import("./pages/Analysis").then((module) => module.AnalysisRedirect));
const EduTool = lazyPage(() => import("./pages/EduAnalysis").then((module) => module.EduTool));
const EduDetail = lazyPage(() => import("./pages/EduAnalysis").then((module) => module.EduDetail));
const Settings = lazyPage(() => import("./pages/Settings").then((module) => module.Settings));
const Login = lazyPage(() => import("./pages/Login").then((module) => module.Login));

export function App() {
  const lang = useApp((s) => s.lang);
  const user = useApp((s) => s.user);
  const authChecked = useApp((s) => s.authChecked);
  const checkAuth = useApp((s) => s.checkAuth);
  const sessionExpired = useApp((s) => s.sessionExpired);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  useEffect(() => {
    void checkAuth().catch(() => undefined);
  }, [checkAuth]);

  const fallback = (
    <div role="status" className="flex min-h-[100dvh] items-center justify-center gap-2 bg-[var(--bg)] font-mono text-xs text-[var(--text-dim)]">
      <span className="spinner h-3.5 w-3.5 border-[var(--line-strong)] border-t-[var(--accent)]" />
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
    <Suspense fallback={fallback}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/workspace" element={<Workspace />} />
        <Route path="/studio" element={<Studio />} />
        <Route path="/studio/:projectId" element={<Studio />} />
        <Route path="/advanced" element={<Advanced />} />
        <Route path="/advanced/:fileId" element={<Advanced />} />
        <Route path="/slide/:fileId" element={<Slide />} />
        <Route path="/analysis" element={<AnalysisHub />} />
        <Route path="/analysis/comet" element={<CometTool />} />
        <Route path="/analysis/comet/:analysisId" element={<AnalysisDetail />} />
        <Route path="/analysis/edu" element={<EduTool />} />
        <Route path="/analysis/edu/:analysisId" element={<EduDetail />} />
        <Route path="/analysis/:analysisId" element={<AnalysisRedirect />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:section" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
