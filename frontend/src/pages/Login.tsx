import { useState } from "react";
import { ArrowRight, Key, Translate, WarningCircle } from "@phosphor-icons/react";
import { Glass } from "../components/Glass";
import { Mark } from "../components/Mark";
import { t } from "../i18n";
import { login } from "../lib/api";
import { detailMessage } from "../lib/format";
import { useApp } from "../store";

export function Login({ sessionEnded = false }: { sessionEnded?: boolean }) {
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const setUser = useApp((s) => s.setUser);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(sessionEnded ? t(lang, "sessionEnded") : null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await login(code.trim());
      setUser(res.user);
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-4 py-10 text-[var(--text)]">
      <div className="app-grain" aria-hidden />
      <div className="ambient-orb ambient-orb-left" aria-hidden />
      <div className="ambient-orb ambient-orb-right" aria-hidden />

      <button
        type="button"
        onClick={() => setLang(lang === "zh" ? "en" : "zh")}
        className="icon-action language-action absolute right-4 top-4 z-[2] gap-1.5 px-2.5"
        aria-label={t(lang, "switchLanguage")}
      >
        <Translate size={16} />
        <span className="text-[12px]">{t(lang, "lang")}</span>
      </button>

      <div className="relative z-[1] w-full max-w-[420px]">
        <Glass as="section" shape="card" className="p-7 sm:p-9">
          <div className="flex items-center gap-2.5 text-[var(--accent)]">
            <Mark />
            <span className="font-semibold tracking-[-0.025em] text-[var(--text)]">ND2Utils</span>
          </div>
          <p className="mt-9 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">{t(lang, "loginEyebrow")}</p>
          <h1 className="mt-2 text-[1.75rem] font-semibold leading-tight tracking-[-0.04em]">{t(lang, "loginTitle")}</h1>
          <p className="mt-3 text-[13px] leading-6 text-[var(--text-dim)]">{t(lang, "loginIntro")}</p>

          <form onSubmit={(event) => void submit(event)} className="mt-7 grid gap-3">
            <label className="grid gap-1.5 text-[11px] font-medium text-[var(--text-dim)]">
              {t(lang, "accessCode")}
              <span className="relative">
                <Key size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  aria-invalid={Boolean(error)}
                  className="h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] pl-10 pr-3 font-mono text-[15px] uppercase tracking-[0.12em] text-[var(--text)] transition-colors placeholder:tracking-[0.12em] placeholder:text-[var(--text-dim)]/50 focus:border-[var(--accent)] focus:outline-none"
                />
              </span>
            </label>

            {error && (
              <p role="alert" className="flex items-start gap-1.5 overflow-hidden text-[12px] leading-5 text-[var(--danger)]">
                <WarningCircle size={15} className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}

            <button type="submit" disabled={busy || !code.trim()} className="primary-action group mt-1 w-full disabled:opacity-45">
              {busy ? t(lang, "signingIn") : t(lang, "signIn")}
              <ArrowRight size={15} className="transition-transform duration-300 group-hover:translate-x-0.5" />
            </button>
          </form>

          <p className="mt-6 text-[12px] leading-5 text-[var(--text-dim)]">{t(lang, "loginHint")}</p>
        </Glass>
        <p className="mx-auto mt-6 max-w-sm text-center text-[11px] leading-5 text-[var(--text-dim)]">{t(lang, "legal")}</p>
      </div>
    </div>
  );
}
