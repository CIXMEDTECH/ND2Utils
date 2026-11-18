import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  CaretRight,
  Crop,
  DotsThree,
  Folder,
  FolderOpen,
  HardDrives,
  MagnifyingGlass,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { t } from "../i18n";
import { formatBytes, joinPath, rgbCss } from "../lib/format";
import { buildTree, orderedFiles, type FolderNode } from "../lib/tree";
import type { FileSummary } from "../lib/types";
import { fromDataTransfer, useUploads } from "../lib/uploads";
import { useApp } from "../store";

export type TreeTarget = { type: "folder"; path: string } | { type: "file"; file: FileSummary };

/** "a/b/c" -> ["a", "a/b", "a/b/c"] */
function pathAndAncestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

const INDENT = 14;

export function FileTree({ onMenu }: { onMenu: (target: TreeTarget, x: number, y: number) => void }) {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const folders = useApp((s) => s.folders);
  const selectedId = useApp((s) => s.selectedId);
  const checked = useApp((s) => s.checked);
  const currentFolder = useApp((s) => s.currentFolder);
  const revealRequest = useApp((s) => s.revealRequest);
  const select = useApp((s) => s.select);
  const setCurrentFolder = useApp((s) => s.setCurrentFolder);
  const toggleChecked = useApp((s) => s.toggleChecked);
  const upload = useUploads((s) => s.upload);
  const uploading = useUploads((s) => Boolean(s.progress));
  // Folders start collapsed. They open only when the user toggles them or something asks to reveal
  // a path (selection, new folder, upload). Opening a folder never happens as a side effect of
  // clicking another one - that used to shift rows under the pointer.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const tree = useMemo(() => buildTree(folders, files), [folders, files]);

  function expandPath(path: string) {
    const wanted = pathAndAncestors(path);
    setExpanded((prev) => {
      if (wanted.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      wanted.forEach((p) => next.add(p));
      return next;
    });
  }

  const selectedFolder = files.find((f) => f.id === selectedId)?.folder;
  // Reveal a newly selected file (also after upload or when coming from another page). Collapsing
  // its folder afterwards changes neither value, so the folder stays collapsed.
  useEffect(() => {
    if (selectedFolder) expandPath(selectedFolder);
  }, [selectedId, selectedFolder]);

  useEffect(() => {
    if (revealRequest) expandPath(revealRequest.path);
  }, [revealRequest]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        // Collapsing a folder also collapses everything below it.
        for (const p of prev) if (p === path || p.startsWith(`${path}/`)) next.delete(p);
      } else next.add(path);
      return next;
    });
  }

  function openMenu(event: ReactMouseEvent, target: TreeTarget) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "contextmenu") {
      onMenu(target, event.clientX, event.clientY);
    } else {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      onMenu(target, box.right - 4, box.bottom + 4);
    }
  }

  function dropProps(path: string) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (uploading || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(path);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setDropTarget(null);
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        setCurrentFolder(path);
        const items = fromDataTransfer(event.dataTransfer);
        void items.then((list) => upload(list, path));
      },
    };
  }

  const rowBase = "group relative flex h-8 items-center gap-1 pr-1 transition-colors";
  const moreButton = (target: TreeTarget, label: string) => (
    <button
      type="button"
      onClick={(event) => openMenu(event, target)}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-opacity hover:bg-[var(--bg)] hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-70"
      aria-label={`${t(lang, "moreActions")}: ${label}`}
      aria-haspopup="menu"
    >
      <DotsThree size={16} weight="bold" />
    </button>
  );

  function renderFolder(node: FolderNode, depth: number): React.ReactNode {
    const isRoot = node.path === "";
    const open = isRoot || expanded.has(node.path);
    const active = currentFolder === node.path;
    const label = isRoot ? t(lang, "workspaceRoot") : node.name;
    const target: TreeTarget = { type: "folder", path: node.path };
    return (
      <li key={`d:${node.path}`} role="treeitem" aria-expanded={isRoot ? undefined : open} aria-selected={active}>
        <div
          {...dropProps(node.path)}
          onContextMenu={(event) => openMenu(event, target)}
          className={`${rowBase} ${dropTarget === node.path ? "bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]" : active ? "bg-[color-mix(in_srgb,var(--accent-soft)_65%,transparent)]" : "hover:bg-[var(--bg)]"}`}
          style={{ paddingLeft: 6 + depth * INDENT }}
        >
          <button
            type="button"
            onClick={() => {
              setCurrentFolder(node.path);
              if (!isRoot) toggle(node.path);
            }}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
            title={node.path || label}
          >
            {isRoot ? (
              <HardDrives size={15} weight="duotone" className="ml-[18px] shrink-0 text-[var(--accent)]" />
            ) : (
              <>
                <CaretRight
                  size={11}
                  weight="bold"
                  className={`mx-[2.5px] shrink-0 text-[var(--text-dim)] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                />
                {open ? (
                  <FolderOpen size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
                ) : (
                  <Folder size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
                )}
              </>
            )}
            <span className={`truncate text-sm ${isRoot ? "font-semibold" : "font-medium"}`}>{label}</span>
            <span className="ml-auto shrink-0 pl-2 font-mono text-2xs text-[var(--text-dim)]">{node.total}</span>
          </button>
          {moreButton(target, label)}
        </div>
        {open && (
          <ul role="group">
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.files.map((file) => renderFile(file, depth + 1))}
            {!isRoot && node.total === 0 && (
              <li className="flex h-7 items-center text-xs italic text-[var(--text-dim)]" style={{ paddingLeft: 6 + (depth + 1) * INDENT + 22 }}>
                {t(lang, "emptyFolder")}
              </li>
            )}
          </ul>
        )}
      </li>
    );
  }

  function renderFile(file: FileSummary, depth: number, showPath = false) {
    const active = selectedId === file.id;
    const target: TreeTarget = { type: "file", file };
    return (
      <li key={`f:${file.id}`} role="treeitem" aria-selected={active}>
        <div
          {...dropProps(file.folder)}
          onContextMenu={(event) => openMenu(event, target)}
          className={`${rowBase} ${showPath ? "h-11" : ""} ${active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--bg)]"}`}
          style={{ paddingLeft: 6 + depth * INDENT }}
        >
          {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r-full bg-[var(--accent)]" aria-hidden />}
          <label className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-black/5">
            <input
              type="checkbox"
              checked={Boolean(checked[file.id])}
              aria-label={`${t(lang, "selectFile")} ${file.name}`}
              onChange={(event) => toggleChecked(file.id, event.target.checked)}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              select(file.id);
              setCurrentFolder(file.folder);
            }}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
            title={`${joinPath(file.folder, file.name)} · ${file.width ?? "–"}×${file.height ?? "–"} · ${formatBytes(file.size_bytes, lang)}`}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm tracking-[-0.01em]">{file.name}</span>
                {file.cropped && (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 rounded bg-[var(--accent-soft)] px-1 py-0.5 font-mono text-2xs font-medium text-[var(--accent)]"
                    title={`${t(lang, "croppedBadge")}${file.crop ? ` · ${file.crop.w}×${file.crop.h}` : ""}`}
                  >
                    <Crop size={10} weight="bold" />
                    {t(lang, "croppedBadge")}
                  </span>
                )}
              </span>
              {showPath && <span className="block truncate font-mono text-2xs text-[var(--text-dim)]">/{file.folder}</span>}
            </span>
            {file.prepare === "pending" && (
              <SpinnerGap size={12} className="shrink-0 animate-spin text-[var(--text-dim)]" aria-label={t(lang, "preparing")} />
            )}
            {file.prepare === "error" && (
              <WarningCircle size={12} className="shrink-0 text-[var(--danger)]" aria-label={t(lang, "prepareFailed")} />
            )}
            <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
              {file.channels?.map((channel) => (
                <span
                  key={channel.index}
                  className="h-2 w-2 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.15)]"
                  style={{ background: rgbCss(channel.color) }}
                  title={channel.name}
                />
              ))}
            </span>
            <span className="hidden w-12 shrink-0 text-right font-mono text-2xs text-[var(--text-dim)] @[260px]:block">
              {formatBytes(file.size_bytes, lang)}
            </span>
          </button>
          {moreButton(target, file.name)}
        </div>
      </li>
    );
  }

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    return orderedFiles(folders, files).filter((f) => joinPath(f.folder, f.name).toLowerCase().includes(needle));
  }, [needle, folders, files]);

  const iconButton = "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]";

  return (
    <div className="@container">
      <div className="sticky top-0 z-[1] flex items-center gap-1 border-b border-[var(--line)] bg-[var(--bg-elev)]/85 px-2 py-1.5 backdrop-blur">
        <label className="relative min-w-0 flex-1">
          <MagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            placeholder={t(lang, "searchFiles")}
            aria-label={t(lang, "searchFiles")}
            className="h-7 w-full rounded-md border border-[var(--line)] bg-[var(--bg)] pl-7 pr-6 text-sm focus:border-[var(--accent)] focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--text-dim)] hover:text-[var(--text)]"
              aria-label={t(lang, "cancel")}
            >
              <X size={11} />
            </button>
          )}
        </label>
        <button type="button" onClick={() => setExpanded(new Set(folders))} className={iconButton} title={t(lang, "expandAll")} aria-label={t(lang, "expandAll")}>
          <ArrowsOutLineVertical size={15} />
        </button>
        <button type="button" onClick={() => setExpanded(new Set())} className={iconButton} title={t(lang, "collapseAll")} aria-label={t(lang, "collapseAll")}>
          <ArrowsInLineVertical size={15} />
        </button>
      </div>

      {needle ? (
        <ul role="tree" aria-label={t(lang, "files")} className="pb-3">
          <li className="px-3 py-1.5 font-mono text-2xs text-[var(--text-dim)]">
            {matches.length ? `${matches.length} ${t(lang, "nFiles")}` : t(lang, "noMatches")}
          </li>
          {matches.slice(0, 500).map((file) => renderFile(file, 0, true))}
        </ul>
      ) : (
        <ul role="tree" aria-label={t(lang, "files")} className="pb-3" {...dropProps(currentFolder)}>
          {renderFolder(tree, 0)}
        </ul>
      )}
    </div>
  );
}
