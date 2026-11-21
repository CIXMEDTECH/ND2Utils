import { useEffect, useState } from "react";
import { ArrowRight, Folder, SpinnerGap, Warning } from "@phosphor-icons/react";
import { t } from "../i18n";
import { organizeByMagnification, type OrganizeResult } from "../lib/api";
import { detailMessage } from "../lib/format";
import { showToast } from "../lib/moves";
import { useApp } from "../store";
import { ConfirmDialog, Modal } from "./Modal";

type Mode = "sort" | "regroup";

/** Preview and run "sort by magnification" for a folder; "regroup" sorts everything inside
 * again (old magnification folders are dissolved), after a second confirmation. */
export function OrganizeDialog({ folder, onClose }: { folder: string | null; onClose: () => void }) {
  const lang = useApp((s) => s.lang);
  const [mode, setMode] = useState<Mode>("sort");
  const [recursive, setRecursive] = useState(true);
  const [plan, setPlan] = useState<OrganizeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const regroup = mode === "regroup";

  useEffect(() => {
    if (folder === null) setMode("sort");
  }, [folder]);

  useEffect(() => {
    if (folder === null) return;
    let cancelled = false;
    setPlan(null);
    setError(null);
    void organizeByMagnification({ folder, recursive: recursive || regroup, regroup, unknown_label: t(lang, "unknownMag") })
      .then((res) => !cancelled && setPlan(res))
      .catch((err) => !cancelled && setError(detailMessage(err, lang)));
    return () => {
      cancelled = true;
    };
  }, [folder, lang, recursive, regroup]);

  async function apply() {
    if (folder === null) return;
    setBusy(true);
    try {
      const res = await organizeByMagnification({ folder, recursive: recursive || regroup, regroup, apply: true, unknown_label: t(lang, "unknownMag") });
      const app = useApp.getState();
      await app.refreshFiles();
      app.reveal(folder);
      showToast(`${t(lang, regroup ? "regroupDone" : "organizeDone")} ${res.moved ?? 0} ${t(lang, "nFiles")}`, res.undo ?? null);
      onClose();
    } catch (err) {
      setError(detailMessage(err, lang));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  const groups = plan?.groups ?? null;
  const tab = (active: boolean) =>
    `flex h-8 items-center justify-center rounded-lg px-3 text-sm transition-colors ${active ? "bg-[var(--bg-elev)] text-[var(--accent)] shadow-sm" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`;

  return (
    <>
      <Modal open={folder !== null} title={t(lang, "organizeTitle")} subtitle={`/${folder ?? ""}`} onClose={onClose} width={600}>
        <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-[var(--bg)] p-0.5">
          <button type="button" onClick={() => setMode("sort")} className={tab(!regroup)} aria-pressed={!regroup}>
            {t(lang, "organizeModeSort")}
          </button>
          <button type="button" onClick={() => setMode("regroup")} className={tab(regroup)} aria-pressed={regroup}>
            {t(lang, "organizeModeRegroup")}
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-[var(--text-dim)]">{t(lang, regroup ? "regroupIntro" : "organizeIntro")}</p>
        {regroup ? (
          <p className="mt-2 flex items-start gap-2 rounded-lg bg-[color-mix(in_srgb,#f59e0b_14%,transparent)] px-2.5 py-2 text-xs leading-5">
            <Warning size={15} className="mt-0.5 shrink-0 text-[#d97706]" />
            {t(lang, "regroupWarning")}
          </p>
        ) : (
          <label className="mt-3 inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
            {t(lang, "organizeIncludeSub")}
          </label>
        )}
        <div className="mt-3 max-h-[44vh] overflow-auto rounded-xl border border-[var(--line)]">
          {error ? (
            <p className="p-4 text-sm text-[var(--danger)]">{error}</p>
          ) : groups === null ? (
            <p className="flex items-center gap-2 p-4 text-sm text-[var(--text-dim)]">
              <SpinnerGap size={16} className="animate-spin" />…
            </p>
          ) : groups.length === 0 ? (
            <p className="p-4 text-sm text-[var(--text-dim)]">{t(lang, regroup ? "regroupNothing" : "organizeNothing")}</p>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {groups.map((group) => (
                <li key={`${group.source}→${group.target}`} className="px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    <Folder size={17} weight="duotone" className="shrink-0 text-[var(--accent)]" />
                    {regroup ? (
                      <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                        <span className="min-w-0 truncate text-[var(--text-dim)]">/{group.source}</span>
                        <ArrowRight size={12} className="shrink-0 text-[var(--text-dim)]" />
                        <span className="min-w-0 truncate rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-semibold text-[var(--accent)]">/{group.target}</span>
                      </span>
                    ) : (
                      <>
                        <span className="min-w-0 truncate font-mono text-xs text-[var(--text-dim)]">/{group.source ? `${group.source}/` : ""}</span>
                        <span className="shrink-0 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-xs font-semibold text-[var(--accent)]">{group.label}</span>
                      </>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-xs text-[var(--text-dim)]">
                      {group.count} {t(lang, "nFiles")}
                    </span>
                  </div>
                  <p className="mt-1 truncate pl-6 font-mono text-2xs text-[var(--text-dim)]">
                    {group.names.join(", ")}
                    {group.count > group.names.length ? " …" : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        {plan && (plan.unchanged > 0 || plan.folders_to_prune.length > 0) && (
          <p className="mt-2 text-xs leading-5 text-[var(--text-dim)]">
            {plan.unchanged > 0 && `${plan.unchanged} ${t(lang, "filesAlreadyRight")}`}
            {plan.unchanged > 0 && regroup && plan.folders_to_prune.length > 0 && " · "}
            {regroup && plan.folders_to_prune.length > 0 && `${plan.folders_to_prune.length} ${t(lang, "foldersToRemove")}: ${plan.folders_to_prune.map((f) => f.split("/").pop()).join(", ")}`}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
            {t(lang, "cancel")}
          </button>
          {regroup ? (
            <button
              type="button"
              disabled={busy || !groups?.length}
              onClick={() => setConfirming(true)}
              className="h-9 rounded-lg bg-[var(--danger)] px-4 text-sm font-semibold text-white disabled:opacity-40"
            >
              {t(lang, "regroupApply")}
            </button>
          ) : (
            <button type="button" disabled={busy || !groups?.length} onClick={() => void apply().catch(() => undefined)} className="primary-action min-h-9 px-4 disabled:opacity-50">
              {t(lang, "organizeApply")}
            </button>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={confirming && folder !== null}
        title={t(lang, "regroupConfirmTitle")}
        body={
          <>
            <p>
              {t(lang, "regroupConfirmMove")} <b className="text-[var(--text)]">{plan?.files ?? 0}</b> {t(lang, "nFiles")}
              {plan && plan.folders_to_prune.length > 0 && (
                <>
                  {t(lang, "regroupConfirmPrune")} <b className="text-[var(--text)]">{plan.folders_to_prune.length}</b> {t(lang, "regroupConfirmFolders")}
                </>
              )}
              {t(lang, "regroupConfirmEnd")}
            </p>
            <p className="mt-2 text-sm">{t(lang, "regroupConfirmUndo")}</p>
          </>
        }
        confirmLabel={t(lang, "regroupConfirm")}
        onConfirm={apply}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
