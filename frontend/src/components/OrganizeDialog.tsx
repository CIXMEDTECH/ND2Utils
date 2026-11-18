import { useEffect, useState } from "react";
import { Folder, SpinnerGap } from "@phosphor-icons/react";
import { t } from "../i18n";
import { organizeByMagnification, type OrganizeGroup } from "../lib/api";
import { detailMessage } from "../lib/format";
import { showToast } from "../lib/moves";
import { useApp } from "../store";
import { Modal } from "./Modal";

/** Preview and run "sort by magnification" for a folder. */
export function OrganizeDialog({ folder, onClose }: { folder: string | null; onClose: () => void }) {
  const lang = useApp((s) => s.lang);
  const [recursive, setRecursive] = useState(true);
  const [groups, setGroups] = useState<OrganizeGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (folder === null) return;
    let cancelled = false;
    setGroups(null);
    setError(null);
    void organizeByMagnification({ folder, recursive, unknown_label: t(lang, "unknownMag") })
      .then((res) => !cancelled && setGroups(res.groups))
      .catch((err) => !cancelled && setError(detailMessage(err, lang)));
    return () => {
      cancelled = true;
    };
  }, [folder, lang, recursive]);

  async function apply() {
    if (folder === null) return;
    setBusy(true);
    try {
      const res = await organizeByMagnification({ folder, recursive, apply: true, unknown_label: t(lang, "unknownMag") });
      const app = useApp.getState();
      await app.refreshFiles();
      app.reveal(folder);
      showToast(`${t(lang, "organizeDone")} ${res.moved ?? 0} ${t(lang, "nFiles")}`, res.undo ?? null);
      onClose();
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={folder !== null} title={t(lang, "organizeTitle")} subtitle={`/${folder ?? ""}`} onClose={onClose} width={560}>
      <p className="text-sm leading-6 text-[var(--text-dim)]">{t(lang, "organizeIntro")}</p>
      <label className="mt-3 inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
        {t(lang, "organizeIncludeSub")}
      </label>
      <div className="mt-3 max-h-[46vh] overflow-auto rounded-xl border border-[var(--line)]">
        {error ? (
          <p className="p-4 text-sm text-[var(--danger)]">{error}</p>
        ) : groups === null ? (
          <p className="flex items-center gap-2 p-4 text-sm text-[var(--text-dim)]">
            <SpinnerGap size={16} className="animate-spin" />…
          </p>
        ) : groups.length === 0 ? (
          <p className="p-4 text-sm text-[var(--text-dim)]">{t(lang, "organizeNothing")}</p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {groups.map((group) => (
              <li key={group.target} className="px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <Folder size={17} weight="duotone" className="shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 truncate font-mono text-xs text-[var(--text-dim)]">/{group.source ? `${group.source}/` : ""}</span>
                  <span className="shrink-0 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-xs font-semibold text-[var(--accent)]">{group.label}</span>
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
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
          {t(lang, "cancel")}
        </button>
        <button type="button" disabled={busy || !groups?.length} onClick={() => void apply()} className="primary-action min-h-9 px-4 disabled:opacity-50">
          {t(lang, "organizeApply")}
        </button>
      </div>
    </Modal>
  );
}
