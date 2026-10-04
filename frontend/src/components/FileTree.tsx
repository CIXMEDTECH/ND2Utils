import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CaretRight, DotsThree, Folder, FolderOpen, HardDrives } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { t } from "../i18n";
import { formatBytes, joinPath, parentPath, rgbCss } from "../lib/format";
import type { FileSummary } from "../lib/types";
import { fromDataTransfer, useUploads } from "../lib/uploads";
import { useApp } from "../store";

export type TreeTarget = { type: "folder"; path: string } | { type: "file"; file: FileSummary };

interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  files: FileSummary[];
  /** ND2 files in this folder and all subfolders. */
  total: number;
}

function buildTree(folders: string[], files: FileSummary[]): FolderNode {
  const root: FolderNode = { path: "", name: "", folders: [], files: [], total: 0 };
  const nodes = new Map<string, FolderNode>([["", root]]);
  const ensure = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: FolderNode = { path, name: path.slice(path.lastIndexOf("/") + 1), folders: [], files: [], total: 0 };
    nodes.set(path, node);
    ensure(parentPath(path)).folders.push(node);
    return node;
  };
  folders.forEach(ensure);
  for (const file of files) ensure(file.folder || "").files.push(file);
  const finish = (node: FolderNode): number => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.total = node.files.length + node.folders.reduce((sum, child) => sum + finish(child), 0);
    return node.total;
  };
  finish(root);
  return root;
}

export function countFilesIn(files: FileSummary[], folder: string): number {
  if (!folder) return files.length;
  return files.filter((f) => f.folder === folder || f.folder.startsWith(`${folder}/`)).length;
}

function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function FileTree({ onMenu }: { onMenu: (target: TreeTarget, x: number, y: number) => void }) {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const folders = useApp((s) => s.folders);
  const selectedId = useApp((s) => s.selectedId);
  const checked = useApp((s) => s.checked);
  const currentFolder = useApp((s) => s.currentFolder);
  const select = useApp((s) => s.select);
  const setCurrentFolder = useApp((s) => s.setCurrentFolder);
  const toggleChecked = useApp((s) => s.toggleChecked);
  const upload = useUploads((s) => s.upload);
  const uploading = useUploads((s) => Boolean(s.progress));
  const reduce = useReducedMotion();
  // Folders start collapsed; only the path to the current folder / selected file is opened.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(folders, files), [folders, files]);

  // Whatever becomes current (new folder, upload target, selected file) must be visible.
  const selectedFolder = files.find((f) => f.id === selectedId)?.folder ?? "";
  useEffect(() => {
    const reveal = [...ancestorsOf(parentPath(currentFolder)), ...ancestorsOf(selectedFolder)];
    setExpanded((prev) => {
      if (reveal.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      reveal.forEach((p) => next.add(p));
      return next;
    });
  }, [currentFolder, selectedFolder]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
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

  const rowBase = "group relative flex min-h-9 items-center gap-1.5 pr-1.5 transition-colors";
  const moreButton = (target: TreeTarget, label: string) => (
    <button
      type="button"
      onClick={(event) => openMenu(event, target)}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] opacity-60 transition-opacity hover:bg-[var(--bg)] hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      aria-label={`${t(lang, "moreActions")}: ${label}`}
      aria-haspopup="menu"
    >
      <DotsThree size={18} weight="bold" />
    </button>
  );

  function renderFolder(node: FolderNode, depth: number): React.ReactNode {
    const isRoot = node.path === "";
    const open = isRoot || expanded.has(node.path);
    const active = currentFolder === node.path;
    const label = isRoot ? t(lang, "workspaceRoot") : node.name;
    const target: TreeTarget = { type: "folder", path: node.path };
    return (
      <li key={`d:${node.path}`} role="treeitem" aria-expanded={open} aria-selected={active}>
        <div
          {...dropProps(node.path)}
          onContextMenu={(event) => openMenu(event, target)}
          className={`${rowBase} ${dropTarget === node.path ? "bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]" : active ? "bg-[color-mix(in_srgb,var(--accent-soft)_65%,transparent)]" : "hover:bg-[var(--bg)]"}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <button
            type="button"
            onClick={() => {
              setCurrentFolder(node.path);
              if (!isRoot && (active || !open)) toggle(node.path);
            }}
            onDoubleClick={() => !isRoot && toggle(node.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
            title={node.path || label}
          >
            {isRoot ? (
              <HardDrives size={15} weight="duotone" className="ml-[18px] shrink-0 text-[var(--accent)]" />
            ) : (
              <>
                <motion.span
                  animate={{ rotate: open ? 90 : 0 }}
                  transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 32 }}
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-dim)]"
                >
                  <CaretRight size={11} weight="bold" />
                </motion.span>
                {open ? (
                  <FolderOpen size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
                ) : (
                  <Folder size={16} weight="duotone" className="shrink-0 text-[var(--accent)]" />
                )}
              </>
            )}
            <span className={`truncate text-[12.5px] ${isRoot ? "font-semibold" : "font-medium"}`}>{label}</span>
            <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-[var(--text-dim)]">{node.total}</span>
          </button>
          {moreButton(target, label)}
        </div>
        {open && (
          <ul role="group">
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.files.map((file) => renderFile(file, depth + 1))}
            {!isRoot && node.total === 0 && (
              <li className="py-1.5 text-[11px] italic text-[var(--text-dim)]" style={{ paddingLeft: 8 + (depth + 1) * 14 + 22 }}>
                {t(lang, "emptyFolder")}
              </li>
            )}
          </ul>
        )}
      </li>
    );
  }

  function renderFile(file: FileSummary, depth: number) {
    const active = selectedId === file.id;
    const target: TreeTarget = { type: "file", file };
    return (
      <li key={`f:${file.id}`} role="treeitem" aria-selected={active}>
        <div
          {...dropProps(file.folder)}
          onContextMenu={(event) => openMenu(event, target)}
          className={`${rowBase} ${active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--bg)]"}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {active && (
            <motion.span
              layoutId="selected-file"
              className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-[var(--accent)]"
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            />
          )}
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
            className="min-w-0 flex-1 py-1.5 text-left"
            title={joinPath(file.folder, file.name)}
          >
            <span className="block truncate text-[12.5px] font-medium tracking-[-0.01em]">{file.name}</span>
            <span className="mt-1 flex items-center gap-1 overflow-hidden">
              {file.channels?.map((channel) => (
                <span
                  key={channel.index}
                  className="shrink-0 rounded px-1 py-px font-mono text-[8.5px] font-medium text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
                  style={{ background: rgbCss(channel.color) }}
                >
                  {channel.name}
                </span>
              ))}
              <span className="ml-1 truncate font-mono text-[9.5px] text-[var(--text-dim)]">
                {file.width ?? "–"}×{file.height ?? "–"} · {formatBytes(file.size_bytes, lang)}
              </span>
            </span>
          </button>
          {moreButton(target, file.name)}
        </div>
      </li>
    );
  }

  return (
    <ul role="tree" aria-label={t(lang, "files")} className="pb-3" {...dropProps(currentFolder)}>
      {renderFolder(tree, 0)}
    </ul>
  );
}
