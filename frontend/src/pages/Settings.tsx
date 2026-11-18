import { useEffect, useState, type ReactNode } from "react";
import { Navigate, NavLink, useParams } from "react-router-dom";
import { Check, Database, Gauge, IdentificationCard, Key, Palette, SlidersHorizontal } from "@phosphor-icons/react";
import { AdminCodes } from "../components/AdminCodes";
import { AdminPerformance } from "../components/AdminPerformance";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { t, type MsgKey } from "../i18n";
import { clientSettings, type ServerSettings } from "../lib/api";
import { detailMessage, formatBytes, formatDateTime } from "../lib/format";
import { clearLocal, subscribe, usage } from "../lib/previewCache";
import type { Lang } from "../lib/types";
import { useApp } from "../store";

type Section = "general" | "codes" | "performance";

const SECTIONS: { key: Section; path: string; label: MsgKey; Icon: typeof Gauge; admin?: boolean }[] = [
  { key: "general", path: "/settings", label: "settingsGeneral", Icon: SlidersHorizontal },
  { key: "codes", path: "/settings/codes", label: "adminTitle", Icon: Key, admin: true },
  { key: "performance", path: "/settings/performance", label: "perfTitle", Icon: Gauge, admin: true },
];

const segmented = (active: boolean) =>
  `h-8 rounded-lg text-sm transition-colors ${active ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`;

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Glass as="section" shape="card" className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold">{title}</h2>
          {children}
        </div>
      </div>
    </Glass>
  );
}

function Rows({ rows, mono = false }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <dl className={`mt-3 grid gap-2 rounded-xl bg-[var(--bg)]/50 p-3 text-sm ${mono ? "font-mono text-xs tabular-nums" : ""}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-4">
          <dt className="text-[var(--text-dim)]">{k}</dt>
          <dd className="truncate text-right font-mono text-xs tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What this browser keeps of the workspace previews (see lib/previewCache). */
function LocalCache({ lang, info }: { lang: Lang; info: ServerSettings }) {
  const [stored, setStored] = useState<{ count: number; bytes: number } | null>(null);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const update = () =>
      void usage().then((next) => {
        if (!cancelled) setStored(next);
      });
    update();
    const unsubscribe = subscribe(update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="mt-5 border-t border-[var(--line)] pt-4">
      <h3 className="text-sm font-medium">{t(lang, "localCacheTitle")}</h3>
      <p className="mt-1 text-sm leading-5 text-[var(--text-dim)]">
        {info.local_cache
          ? `${t(lang, "localCacheOn")}${info.local_cache_auto ? ` ${t(lang, "localCacheAutoOn")}` : ""}`
          : t(lang, "localCacheOff")}
      </p>
      {info.local_cache && (
        <>
          <Rows
            mono
            rows={[
              [t(lang, "localCacheStored"), stored ? `${stored.count} ${t(lang, "nFiles")} · ${formatBytes(stored.bytes, lang)}` : "…"],
              [t(lang, "localCacheLimit"), formatBytes(info.local_cache_bytes, lang)],
            ]}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={!stored?.count}
              onClick={() =>
                void clearLocal().then(() => {
                  setCleared(true);
                  window.setTimeout(() => setCleared(false), 2000);
                })
              }
              className="inline-flex h-8 items-center rounded-lg border border-[var(--line)] px-3 text-sm transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
            >
              {t(lang, "localCacheClear")}
            </button>
            {cleared && (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--accent)]" aria-live="polite">
                <Check size={13} weight="bold" /> {t(lang, "localCacheCleared")}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function General({ info, error }: { info: ServerSettings | null; error: string | null }) {
  const lang = useApp((s) => s.lang);
  const theme = useApp((s) => s.theme);
  const setLang = useApp((s) => s.setLang);
  const setTheme = useApp((s) => s.setTheme);
  const textSize = useApp((s) => s.textSize);
  const setTextSize = useApp((s) => s.setTextSize);
  const user = useApp((s) => s.user);

  return (
    <div className="grid gap-4">
      {user && (
        <Card icon={<IdentificationCard size={18} weight="duotone" />} title={t(lang, "accountTitle")}>
          <Rows
            rows={[
              [t(lang, "codeLabel"), user.label || "—"],
              [t(lang, "codeKind"), `${t(lang, user.role === "admin" ? "roleAdmin" : "roleUser")} · ${t(lang, user.kind === "permanent" ? "kindPermanent" : "kindTemporary")}`],
              [t(lang, "expiresAt"), user.expires_at ? formatDateTime(user.expires_at, lang) : t(lang, "expiresNever")],
              [t(lang, "usage"), `${user.usage.files} ${t(lang, "nFiles")} · ${formatBytes(user.usage.bytes, lang)}`],
            ]}
          />
          <p className="mt-3 text-sm leading-5 text-[var(--text-dim)]">
            {user.kind === "permanent"
              ? t(lang, "permanentNote")
              : `${t(lang, "temporaryNote")} ${info?.ttl_hours ?? "…"} ${t(lang, "temporaryNoteTail")}`}
          </p>
        </Card>
      )}

      <Card icon={<Palette size={18} weight="duotone" />} title={t(lang, "settingsDisplay")}>
        <p className="mt-1 text-sm leading-5 text-[var(--text-dim)]">{t(lang, "settingsIntro")}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[5rem_minmax(0,1fr)] sm:items-center">
          <span className="text-sm text-[var(--text-dim)]">{t(lang, "settingsLang")}</span>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--bg)]/50 p-1">
            {(["zh", "en"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={lang === key} onClick={() => setLang(key)} className={segmented(lang === key)}>
                {key === "zh" ? "中文" : "English"}
              </button>
            ))}
          </div>
          <span className="text-sm text-[var(--text-dim)]">{t(lang, "settingsTheme")}</span>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--bg)]/50 p-1">
            {(["light", "dark", "system"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={theme === key} onClick={() => setTheme(key)} className={segmented(theme === key)}>
                {t(lang, key === "light" ? "themeLight" : key === "dark" ? "themeDark" : "themeSystem")}
              </button>
            ))}
          </div>
          <span className="text-sm text-[var(--text-dim)]">{t(lang, "settingsTextSize")}</span>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--bg)]/50 p-1">
            {(["normal", "large", "xlarge"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={textSize === key} onClick={() => setTextSize(key)} className={segmented(textSize === key)}>
                {t(lang, key === "normal" ? "textSizeNormal" : key === "large" ? "textSizeLarge" : "textSizeXLarge")}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card icon={<Database size={18} weight="duotone" />} title={t(lang, "settingsStorage")}>
        <p className="mt-1 text-sm leading-5 text-[var(--text-dim)]">{t(lang, "settingsStorageHint")}</p>
        {info ? (
          <>
            <Rows
              mono
              rows={[
                [t(lang, "maxUpload"), formatBytes(info.max_upload_bytes, lang)],
                [t(lang, "retention"), `${info.ttl_hours} ${t(lang, "hours")}`],
              ]}
            />
            <LocalCache lang={lang} info={info} />
          </>
        ) : !error ? (
          <div className="mt-3 grid gap-2" aria-hidden>
            <span className="h-9 animate-pulse rounded-xl bg-[var(--bg)]/50" />
            <span className="h-9 animate-pulse rounded-xl bg-[var(--bg)]/50" />
          </div>
        ) : null}
      </Card>
    </div>
  );
}

export function Settings() {
  const lang = useApp((s) => s.lang);
  const isAdmin = useApp((s) => s.user?.role === "admin");
  const { section: param } = useParams();
  const [info, setInfo] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void clientSettings()
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

  const sections = SECTIONS.filter((s) => !s.admin || isAdmin);
  const current = sections.find((s) => s.key === param);
  if (param && !current) return <Navigate to="/settings" replace />;
  const section: Section = current?.key ?? "general";

  return (
    <Shell dense>
      <main className={`mx-auto px-5 py-10 sm:py-14 ${sections.length > 1 ? "max-w-5xl" : "max-w-2xl"}`}>
        <div className="border-b border-[var(--line)] pb-6">
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-[var(--accent)]">{t(lang, "settingsEyebrow")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">{t(lang, "settings")}</h1>
        </div>

        <div className={`mt-7 ${sections.length > 1 ? "grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]" : ""}`}>
          {sections.length > 1 && (
            <nav aria-label={t(lang, "settings")} className="md:sticky md:top-24 md:self-start">
              <ul className="flex gap-1 overflow-x-auto md:flex-col">
                {sections.map(({ key, path, label, Icon }) => (
                  <li key={key} className="shrink-0">
                    <NavLink
                      to={path}
                      end
                      className={({ isActive }) =>
                        `flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
                          isActive ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:bg-[var(--bg-elev)] hover:text-[var(--text)]"
                        }`
                      }
                    >
                      <Icon size={15} />
                      {t(lang, label)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="min-w-0">
            {section === "general" && <General info={info} error={error} />}
            {section === "codes" && <AdminCodes />}
            {section === "performance" && <AdminPerformance />}
            {error && (
              <p role="alert" className="mt-5 text-sm text-[var(--danger)]">
                {error}
              </p>
            )}
          </div>
        </div>

        <p className="mx-auto mt-10 max-w-lg text-center text-xs leading-5 text-[var(--text-dim)]">{t(lang, "legal")}</p>
      </main>
    </Shell>
  );
}
