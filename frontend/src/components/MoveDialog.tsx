import { useMemo, useState } from "react";
import { CaretRight, Folder, FolderOpen, FolderPlus, HardDrives } from "@phosphor-icons/react";
import { t } from "../i18n";
import type { MoveConflict } from "../lib/api";
import { joinPath } from "../lib/format";
import { performMove, type MoveSet } from "../lib/moves";
import { buildTree, type FolderNode } from "../lib/tree";
import { useApp } from "../store";
import { Modal } from "./Modal";

/** "Move to…": pick a destination folder (or type a new subfolder name) and a clash policy. */
export function MoveDialog({ items, onClose }: { items: MoveSet | null; onClose: () => void }) {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const folders = useApp((s) => s.folders);
  const tree = useMemo(() => buildTree(folders, files), [folders, files]);
  const [target, setTarget] = useState(() => useApp.getState().currentFolder);
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const [newName, setNewName] = useState("");
  const [conflict, setConflict] = useState<MoveConflict>("rename");
  const [busy, setBusy] = useState(false);

  const blocked = (path: string) => (items?.folders ?? []).some((f) => path === f || path.startsWith(`${f}/`));
  const count = (items?.file_ids.length ?? 0) + (items?.folders.length ?? 0);
  const destination = newName.trim() ? joinPath(target, newName.trim().replace(/[\\/]+/g, "_")) : target;

  function renderNode(node: FolderNode, depth: number): React.ReactNode {
    const isRoot = node.path === "";
    const expanded = isRoot || open.has(node.path);
    const disabled = blocked(node.path);
    const active = target === node.path;
    return (
      <li key={node.path || "/"}>
        <div
          className={`flex h-8 items-center gap-1 rounded-md pr-2 ${active ? "bg-[var(--accent-soft)] text-[var(--accent)]" : disabled ? "opacity-40" : "hover:bg-[var(--bg)]"}`}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {isRoot || !node.folders.length ? (
            <span className="w-4 shrink-0" />
          ) : (
            <button
              type="button"
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              }
              className="flex h-6 w-4 shrink-0 items-center justify-center text-[var(--text-dim)]"
              tabIndex={-1}
            >
              <CaretRight size={11} weight="bold" className={expanded ? "rotate-90" : ""} />
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setTarget(node.path)}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
          >
            {isRoot ? (
              <HardDrives size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
            ) : expanded ? (
              <FolderOpen size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
            ) : (
              <Folder size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
            )}
            <span className="truncate">{isRoot ? t(lang, "workspaceRoot") : node.name}</span>
          </button>
        </div>
        {expanded && node.folders.length > 0 && <ul>{node.folders.map((child) => renderNode(child, depth + 1))}</ul>}
      </li>
    );
  }

  async function submit() {
    if (!items || blocked(destination)) return;
    setBusy(true);
    const ok = await performMove(items, destination, conflict);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Modal open={Boolean(items)} title={t(lang, "moveToTitle")} subtitle={`${count} ${t(lang, "items")}`} onClose={onClose} width={480}>
      <div className="mt-1 max-h-[46vh] overflow-auto rounded-xl border border-[var(--line)] p-1.5">
        <ul>{renderNode(tree, 0)}</ul>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <FolderPlus size={17} className="shrink-0 text-[var(--text-dim)]" />
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t(lang, "newFolder")}
          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 text-sm focus:border-[var(--accent)] focus:outline-none"
        />
      </label>
      <label className="mt-3 grid gap-1.5 text-sm text-[var(--text-dim)]">
        {t(lang, "moveConflict")}
        <select
          value={conflict}
          onChange={(event) => setConflict(event.target.value as MoveConflict)}
          className="h-9 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-sm text-[var(--text)]"
        >
          <option value="rename">{t(lang, "conflictRename")}</option>
          <option value="skip">{t(lang, "conflictSkip")}</option>
          <option value="replace">{t(lang, "conflictReplace")}</option>
        </select>
      </label>
      <p className="mt-3 truncate font-mono text-xs text-[var(--text-dim)]">→ /{destination}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
          {t(lang, "cancel")}
        </button>
        <button type="button" disabled={busy || blocked(destination)} onClick={() => void submit()} className="primary-action min-h-9 px-4 disabled:opacity-50">
          {t(lang, "moveHere")}
        </button>
      </div>
    </Modal>
  );
}
