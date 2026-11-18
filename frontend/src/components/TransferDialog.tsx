import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CaretRight, Folder, HardDrives, WarningCircle } from "@phosphor-icons/react";
import { t } from "../i18n";
import { adminTransfer, adminWorkspace, listCodes } from "../lib/api";
import { detailMessage, formatBytes } from "../lib/format";
import type { AccessCode, FileSummary } from "../lib/types";
import { useApp } from "../store";
import { buildTree, type FolderNode } from "../lib/tree";
import { Modal } from "./Modal";

/** Pre-selection when the dialog is opened from a workspace or a code row. */
export interface TransferSeed {
  source?: string;
  fileIds: string[];
  folders: string[];
}

interface Workspace {
  files: FileSummary[];
  folders: string[];
}

const fieldClass =
  "h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none";

function codeName(code: AccessCode, lang: "zh" | "en") {
  const label = code.label || code.code;
  return code.role === "admin" ? `${label} (${t(lang, "roleAdmin")})` : label;
}

function underFolder(folder: string, root: string) {
  return !root || folder === root || folder.startsWith(`${root}/`);
}

function SelectTree({
  workspace,
  folders,
  fileIds,
  onToggleFolder,
  onToggleFile,
}: {
  workspace: Workspace;
  folders: Set<string>;
  fileIds: Set<string>;
  onToggleFolder: (path: string) => void;
  onToggleFile: (id: string) => void;
}) {
  const lang = useApp((s) => s.lang);
  const tree = useMemo(() => buildTree(workspace.folders, workspace.files), [workspace]);
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const coveredBy = (path: string) => [...folders].some((f) => f !== path && underFolder(path, f));

  function toggleOpen(path: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderFolder(node: FolderNode, depth: number): React.ReactNode {
    const isOpen = open.has(node.path);
    const inherited = coveredBy(node.path);
    const isRoot = node.path === "";
    return (
      <li key={`d:${node.path}`}>
        <div className="flex h-8 items-center gap-1.5 pr-2 hover:bg-[var(--bg)]" style={{ paddingLeft: 6 + depth * 14 }}>
          <button
            type="button"
            onClick={() => toggleOpen(node.path)}
            className="flex h-6 w-5 shrink-0 items-center justify-center text-[var(--text-dim)]"
            aria-label={node.path || t(lang, "workspaceRoot")}
            aria-expanded={isOpen}
          >
            <CaretRight size={11} weight="bold" className={`transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
          </button>
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={inherited || folders.has(node.path)}
              disabled={inherited || node.total === 0}
              onChange={() => onToggleFolder(node.path)}
            />
            {isRoot ? (
              <HardDrives size={15} weight="duotone" className="shrink-0 text-[var(--accent)]" />
            ) : (
              <Folder size={15} weight="duotone" className="shrink-0 text-[var(--accent)]" />
            )}
            <span className={`truncate text-sm ${isRoot ? "font-semibold" : "font-medium"}`}>
              {isRoot ? t(lang, "workspaceRoot") : node.name}
            </span>
            <span className="ml-auto shrink-0 font-mono text-2xs text-[var(--text-dim)]">{node.total}</span>
          </label>
        </div>
        {isOpen && (
          <ul>
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.files.map((file) => {
              const viaFolder = inherited || folders.has(node.path);
              return (
                <li key={file.id}>
                  <label
                    className="flex h-7 cursor-pointer items-center gap-1.5 pr-2 hover:bg-[var(--bg)]"
                    style={{ paddingLeft: 6 + (depth + 1) * 14 + 26 }}
                  >
                    <input
                      type="checkbox"
                      checked={viaFolder || fileIds.has(file.id)}
                      disabled={viaFolder}
                      onChange={() => onToggleFile(file.id)}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-[var(--text-dim)]">{formatBytes(file.size_bytes, lang)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  }

  return <ul className="py-1">{renderFolder(tree, 0)}</ul>;
}

export function TransferDialog({
  open,
  seed,
  onClose,
  onDone,
}: {
  open: boolean;
  seed: TransferSeed | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const me = useApp((s) => s.user);
  const [codes, setCodes] = useState<AccessCode[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [sourceWs, setSourceWs] = useState<Workspace | null>(null);
  const [targetWs, setTargetWs] = useState<Workspace | null>(null);
  const [folders, setFolders] = useState<Set<string>>(new Set());
  const [fileIds, setFileIds] = useState<Set<string>>(new Set());
  const [targetFolder, setTargetFolder] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [conflict, setConflict] = useState<"skip" | "replace">("skip");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // (Re)initialise whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    const initialSource = seed?.source ?? me?.id ?? "";
    setSource(initialSource);
    setTarget("");
    setFolders(new Set(seed?.folders ?? []));
    setFileIds(new Set(seed?.fileIds ?? []));
    setTargetFolder("");
    setMode("copy");
    setConflict("skip");
    setError(null);
    setResult(null);
    void listCodes()
      .then((res) => {
        setCodes(res.codes);
        setTarget(res.codes.find((c) => c.id !== initialSource)?.id ?? initialSource);
      })
      .catch((err) => setError(detailMessage(err, lang)));
  }, [open, seed, me?.id, lang]);

  useEffect(() => {
    if (!open || !source) return;
    setSourceWs(null);
    void adminWorkspace(source)
      .then(setSourceWs)
      .catch((err) => setError(detailMessage(err, lang)));
  }, [open, source, lang]);

  useEffect(() => {
    if (!open || !target) return;
    setTargetWs(null);
    void adminWorkspace(target)
      .then(setTargetWs)
      .catch((err) => setError(detailMessage(err, lang)));
  }, [open, target, lang]);

  const selectedCount = useMemo(() => {
    if (!sourceWs) return 0;
    return sourceWs.files.filter((f) => fileIds.has(f.id) || [...folders].some((root) => underFolder(f.folder, root))).length;
  }, [sourceWs, folders, fileIds]);

  function changeSource(id: string) {
    setSource(id);
    setFolders(new Set());
    setFileIds(new Set());
    setResult(null);
  }

  function toggleIn<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) {
    setResult(null);
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function run() {
    if (!selectedCount || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // The root ("") stands for the whole workspace.
      const res = await adminTransfer({
        source,
        target,
        file_ids: [...fileIds],
        folders: [...folders],
        target_folder: targetFolder.trim(),
        mode,
        conflict,
      });
      const parts = [
        res.copied && `${t(lang, "resultCopied")} ${res.copied}`,
        res.moved && `${t(lang, "resultMoved")} ${res.moved}`,
        res.replaced && `${t(lang, "resultReplaced")} ${res.replaced}`,
        res.skipped && `${t(lang, "resultSkipped")} ${res.skipped}`,
      ].filter(Boolean);
      setResult(`${t(lang, "transferDone")} ${parts.join(" · ") || "0"}`);
      setFolders(new Set());
      setFileIds(new Set());
      const [nextSource, nextTarget] = await Promise.all([adminWorkspace(source), adminWorkspace(target)]);
      setSourceWs(nextSource);
      setTargetWs(nextTarget);
      onDone?.();
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  const label = "grid gap-1 text-xs font-medium text-[var(--text-dim)]";

  return (
    <Modal open={open} title={t(lang, "transferTitle")} subtitle={t(lang, "transferIntro")} onClose={onClose} width={620}>
      <div className="grid gap-4">
        <label className={label}>
          {t(lang, "transferSource")}
          <select value={source} onChange={(event) => changeSource(event.target.value)} className={fieldClass}>
            {codes.map((code) => (
              <option key={code.id} value={code.id}>
                {codeName(code, lang)} · {code.usage.files} {t(lang, "nFiles")}
              </option>
            ))}
          </select>
        </label>

        <div>
          <p className="mb-1 text-xs font-medium text-[var(--text-dim)]">{t(lang, "transferPick")}</p>
          <div className="max-h-[38dvh] min-h-24 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--bg)]/40">
            {sourceWs ? (
              <SelectTree
                workspace={sourceWs}
                folders={folders}
                fileIds={fileIds}
                onToggleFolder={(path) => toggleIn(setFolders, path)}
                onToggleFile={(id) => toggleIn(setFileIds, id)}
              />
            ) : (
              <div className="m-2 h-20 animate-pulse rounded-md bg-[var(--bg)]" aria-hidden />
            )}
          </div>
          <p className="mt-1 font-mono text-2xs text-[var(--text-dim)]">
            {t(lang, "selected")} {selectedCount} {t(lang, "nFiles")}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            {t(lang, "transferTarget")}
            <select value={target} onChange={(event) => setTarget(event.target.value)} className={fieldClass}>
              {codes.map((code) => (
                <option key={code.id} value={code.id}>
                  {codeName(code, lang)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t(lang, "targetFolder")}
            <input
              value={targetFolder}
              onChange={(event) => setTargetFolder(event.target.value)}
              list="transfer-target-folders"
              placeholder="/"
              className={fieldClass}
            />
            <datalist id="transfer-target-folders">
              {targetWs?.folders.map((folder) => <option key={folder} value={folder} />)}
            </datalist>
          </label>
          <p className="-mt-1.5 text-xs leading-4 text-[var(--text-dim)] sm:col-span-2">{t(lang, "targetFolderHint")}</p>

          <div className={label}>
            {t(lang, "transferMode")}
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--bg)] p-1">
              {(["copy", "move"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={`h-7 rounded-md text-xs transition-colors ${mode === value ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
                >
                  {t(lang, value === "copy" ? "modeCopy" : "modeMove")}
                </button>
              ))}
            </div>
          </div>
          <label className={label}>
            {t(lang, "conflictLabel")}
            <select value={conflict} onChange={(event) => setConflict(event.target.value as typeof conflict)} className={fieldClass}>
              <option value="skip">{t(lang, "conflictSkip")}</option>
              <option value="replace">{t(lang, "conflictReplace")}</option>
            </select>
          </label>
        </div>

        {mode === "move" && <p className="text-xs leading-5 text-[var(--text-dim)]">{t(lang, "moveHint")}</p>}

        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-sm leading-5 text-[var(--danger)]">
            <WarningCircle size={15} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
        {result && (
          <p role="status" className="rounded-lg bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] px-3 py-2 text-sm text-[var(--ok)]">
            {result}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
            {t(lang, "close")}
          </button>
          <button
            type="button"
            disabled={busy || !selectedCount || !target}
            onClick={() => void run()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-40"
          >
            {t(lang, mode === "copy" ? "modeCopy" : "modeMove")} {selectedCount} {t(lang, "nFiles")}
            <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </Modal>
  );
}
