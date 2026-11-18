import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import { canDropInto, endDrag, isInternalDrag, performMove, readDrop, selectionFor, startDrag } from "../lib/moves";
import { buildTree, orderedFiles, type FolderNode } from "../lib/tree";
import type { FileSummary, Lang } from "../lib/types";
import { fromDataTransfer, useUploads } from "../lib/uploads";
import { useApp } from "../store";

export type TreeTarget = { type: "folder"; path: string } | { type: "file"; file: FileSummary };

/** "a/b/c" -> ["a", "a/b", "a/b/c"] */
function pathAndAncestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

const INDENT = 14;
const HOVER_EXPAND_MS = 650;
const rowBase = "group relative flex h-8 items-center gap-1 pr-1 transition-colors";

/** Callbacks shared by every row; one stable object so memoised rows do not re-render. */
interface RowActions {
  clickFile: (file: FileSummary, event: ReactMouseEvent) => void;
  checkFile: (file: FileSummary, value: boolean, event: ReactMouseEvent | React.ChangeEvent) => void;
  clickFolder: (path: string, event: ReactMouseEvent) => void;
  toggleFolder: (path: string) => void;
  checkFolder: (path: string, value: boolean) => void;
  menu: (event: ReactMouseEvent, target: TreeTarget) => void;
  dragStart: (event: React.DragEvent, item: { file?: string; folder?: string }, label: string) => void;
  dragOver: (event: React.DragEvent, path: string, collapsed: boolean) => void;
  dragLeave: (event: React.DragEvent) => void;
  drop: (event: React.DragEvent, path: string) => void;
}

function MoreButton({ lang, label, onClick }: { lang: Lang; label: string; onClick: (event: ReactMouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-opacity hover:bg-[var(--bg)] hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-70"
      aria-label={`${t(lang, "moreActions")}: ${label}`}
      aria-haspopup="menu"
    >
      <DotsThree size={16} weight="bold" />
    </button>
  );
}

const FileRow = memo(function FileRow({
  file,
  depth,
  active,
  checked,
  showPath,
  lang,
  actions,
}: {
  file: FileSummary;
  depth: number;
  active: boolean;
  checked: boolean;
  showPath: boolean;
  lang: Lang;
  actions: RowActions;
}) {
  const target: TreeTarget = { type: "file", file };
  return (
    <li role="treeitem" aria-selected={active}>
      <div
        draggable
        onDragStart={(event) => actions.dragStart(event, { file: file.id }, file.name)}
        onDragEnd={endDrag}
        onDragOver={(event) => actions.dragOver(event, file.folder, false)}
        onDragLeave={actions.dragLeave}
        onDrop={(event) => actions.drop(event, file.folder)}
        onContextMenu={(event) => actions.menu(event, target)}
        className={`${rowBase} ${showPath ? "h-12" : ""} ${active ? "bg-[var(--accent-soft)]" : checked ? "bg-[color-mix(in_srgb,var(--accent-soft)_55%,transparent)]" : "hover:bg-[var(--bg)]"}`}
        style={{ paddingLeft: 6 + depth * INDENT }}
      >
        {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r-full bg-[var(--accent)]" aria-hidden />}
        <label className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-black/5" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            aria-label={`${t(lang, "selectFile")} ${file.name}`}
            onClick={(event) => {
              if (event.shiftKey) {
                event.preventDefault();
                actions.checkFile(file, true, event);
              }
            }}
            onChange={(event) => actions.checkFile(file, event.target.checked, event)}
          />
        </label>
        <button
          type="button"
          onClick={(event) => actions.clickFile(file, event)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
          title={`${joinPath(file.folder, file.name)} · ${file.width ?? "–"}×${file.height ?? "–"} · ${formatBytes(file.size_bytes, lang)}`}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm">{file.name}</span>
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
            <SpinnerGap size={13} className="shrink-0 animate-spin text-[var(--text-dim)]" aria-label={t(lang, "preparing")} />
          )}
          {file.prepare === "error" && <WarningCircle size={13} className="shrink-0 text-[var(--danger)]" aria-label={t(lang, "prepareFailed")} />}
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
          <span className="hidden w-14 shrink-0 text-right font-mono text-2xs text-[var(--text-dim)] @[280px]:block">
            {formatBytes(file.size_bytes, lang)}
          </span>
        </button>
        <MoreButton lang={lang} label={file.name} onClick={(event) => actions.menu(event, target)} />
      </div>
    </li>
  );
});

const FolderRow = memo(function FolderRow({
  node,
  depth,
  open,
  active,
  checked,
  dropActive,
  lang,
  actions,
}: {
  node: FolderNode;
  depth: number;
  open: boolean;
  active: boolean;
  checked: boolean;
  dropActive: boolean;
  lang: Lang;
  actions: RowActions;
}) {
  const isRoot = node.path === "";
  const label = isRoot ? t(lang, "workspaceRoot") : node.name;
  const target: TreeTarget = { type: "folder", path: node.path };
  return (
    <div
      draggable={!isRoot}
      onDragStart={(event) => actions.dragStart(event, { folder: node.path }, label)}
      onDragEnd={endDrag}
      onDragOver={(event) => actions.dragOver(event, node.path, !open)}
      onDragLeave={actions.dragLeave}
      onDrop={(event) => actions.drop(event, node.path)}
      onContextMenu={(event) => actions.menu(event, target)}
      className={`${rowBase} ${
        dropActive
          ? "bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]"
          : active
            ? "bg-[color-mix(in_srgb,var(--accent-soft)_65%,transparent)]"
            : checked
              ? "bg-[color-mix(in_srgb,var(--accent-soft)_45%,transparent)]"
              : "hover:bg-[var(--bg)]"
      }`}
      style={{ paddingLeft: 6 + depth * INDENT }}
    >
      {isRoot ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <HardDrives size={16} weight="duotone" className="text-[var(--accent)]" />
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={() => actions.toggleFolder(node.path)}
            className="flex h-6 w-4 shrink-0 items-center justify-center text-[var(--text-dim)] hover:text-[var(--text)]"
            aria-label={open ? t(lang, "collapseAll") : t(lang, "expandAll")}
            tabIndex={-1}
          >
            <CaretRight size={11} weight="bold" className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          </button>
          <label className="flex h-6 w-5 shrink-0 cursor-pointer items-center justify-center" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={checked}
              aria-label={`${t(lang, "selectFolder")} ${label}`}
              onChange={(event) => actions.checkFolder(node.path, event.target.checked)}
            />
          </label>
        </>
      )}
      <button
        type="button"
        onClick={(event) => actions.clickFolder(node.path, event)}
        onDoubleClick={() => !isRoot && actions.toggleFolder(node.path)}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        title={node.path || label}
      >
        {!isRoot &&
          (open ? (
            <FolderOpen size={17} weight="duotone" className="shrink-0 text-[var(--accent)]" />
          ) : (
            <Folder size={17} weight="duotone" className="shrink-0 text-[var(--accent)]" />
          ))}
        <span className={`truncate text-sm ${isRoot ? "font-semibold" : "font-medium"}`}>{label}</span>
        <span className="ml-auto shrink-0 pl-2 font-mono text-2xs text-[var(--text-dim)]">{node.total}</span>
      </button>
      <MoreButton lang={lang} label={label} onClick={(event) => actions.menu(event, target)} />
    </div>
  );
});

export const FileTree = memo(function FileTree({ onMenu }: { onMenu: (target: TreeTarget, x: number, y: number) => void }) {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const folders = useApp((s) => s.folders);
  const selectedId = useApp((s) => s.selectedId);
  const checked = useApp((s) => s.checked);
  const checkedFolders = useApp((s) => s.checkedFolders);
  const currentFolder = useApp((s) => s.currentFolder);
  const revealRequest = useApp((s) => s.revealRequest);
  // Folders start collapsed. They open only when the user toggles them or something asks to reveal
  // a path (selection, new folder, upload, a drag hovering over them).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const hoverTimer = useRef<{ path: string; handle: number } | null>(null);
  const anchor = useRef<string | null>(null);

  const tree = useMemo(() => buildTree(folders, files), [folders, files]);

  const expandPath = useCallback((path: string) => {
    const wanted = pathAndAncestors(path);
    setExpanded((prev) => {
      if (wanted.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      wanted.forEach((p) => next.add(p));
      return next;
    });
  }, []);

  const selectedFolder = useMemo(() => files.find((f) => f.id === selectedId)?.folder, [files, selectedId]);
  useEffect(() => {
    if (selectedFolder) expandPath(selectedFolder);
  }, [selectedId, selectedFolder, expandPath]);

  useEffect(() => {
    if (revealRequest) expandPath(revealRequest.path);
  }, [revealRequest, expandPath]);

  // Files in the order they are drawn (Shift-click range selection).
  const visibleFiles = useMemo(() => {
    const out: FileSummary[] = [];
    const walk = (node: FolderNode) => {
      if (node.path !== "" && !expanded.has(node.path)) return;
      node.folders.forEach(walk);
      out.push(...node.files);
    };
    walk(tree);
    return out;
  }, [expanded, tree]);
  const visibleRef = useRef(visibleFiles);
  visibleRef.current = visibleFiles;
  const onMenuRef = useRef(onMenu);
  onMenuRef.current = onMenu;

  const actions = useMemo<RowActions>(() => {
    const app = () => useApp.getState();
    const rangeTo = (file: FileSummary) => {
      const list = visibleRef.current;
      const from = list.findIndex((f) => f.id === anchor.current);
      const to = list.findIndex((f) => f.id === file.id);
      if (from < 0 || to < 0) return [file.id];
      const [a, b] = from < to ? [from, to] : [to, from];
      return list.slice(a, b + 1).map((f) => f.id);
    };
    const clearHover = () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current.handle);
      hoverTimer.current = null;
    };
    return {
      clickFile: (file, event) => {
        if (event.shiftKey && anchor.current) {
          app().setChecked(rangeTo(file), true);
          return;
        }
        if (event.metaKey || event.ctrlKey) {
          app().toggleChecked(file.id);
          anchor.current = file.id;
          return;
        }
        anchor.current = file.id;
        app().select(file.id);
        app().setCurrentFolder(file.folder);
      },
      checkFile: (file, value, event) => {
        if ("shiftKey" in event && event.shiftKey && anchor.current) app().setChecked(rangeTo(file), true);
        else app().toggleChecked(file.id, value);
        anchor.current = file.id;
      },
      clickFolder: (path, event) => {
        if ((event.metaKey || event.ctrlKey) && path) {
          app().toggleFolderChecked(path);
          return;
        }
        app().openFolderView(path);
        if (path) expandPath(path);
      },
      toggleFolder: (path) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(path)) {
            // Collapsing a folder also collapses everything below it.
            for (const p of prev) if (p === path || p.startsWith(`${path}/`)) next.delete(p);
          } else next.add(path);
          return next;
        });
      },
      checkFolder: (path, value) => app().toggleFolderChecked(path, value),
      menu: (event, target) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "contextmenu") onMenuRef.current(target, event.clientX, event.clientY);
        else {
          const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
          onMenuRef.current(target, box.right - 4, box.bottom + 4);
        }
      },
      dragStart: (event, item, label) => {
        const items = selectionFor(item);
        const count = items.file_ids.length + items.folders.length;
        startDrag(event, items, count > 1 ? `${count} ${t(app().lang, "items")}` : label);
      },
      dragOver: (event, path, collapsed) => {
        const internal = isInternalDrag(event);
        const upload = event.dataTransfer.types.includes("Files");
        if (!internal && (!upload || useUploads.getState().progress)) return;
        if (internal && !canDropInto(path)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = internal ? "move" : "copy";
        setDropTarget(path);
        if (collapsed && path && hoverTimer.current?.path !== path) {
          clearHover();
          hoverTimer.current = { path, handle: window.setTimeout(() => expandPath(path), HOVER_EXPAND_MS) };
        }
      },
      dragLeave: (event) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
          setDropTarget(null);
          clearHover();
        }
      },
      drop: (event, path) => {
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        clearHover();
        if (isInternalDrag(event)) {
          const items = readDrop(event);
          endDrag();
          if (items) void performMove(items, path);
          return;
        }
        app().setCurrentFolder(path);
        const items = fromDataTransfer(event.dataTransfer);
        void items.then((list) => useUploads.getState().upload(list, path));
      },
    };
  }, [expandPath]);

  function renderFolder(node: FolderNode, depth: number): React.ReactNode {
    const isRoot = node.path === "";
    const open = isRoot || expanded.has(node.path);
    return (
      <li key={`d:${node.path}`} role="treeitem" aria-expanded={isRoot ? undefined : open} aria-selected={currentFolder === node.path}>
        <FolderRow
          node={node}
          depth={depth}
          open={open}
          active={currentFolder === node.path}
          checked={Boolean(checkedFolders[node.path])}
          dropActive={dropTarget === node.path}
          lang={lang}
          actions={actions}
        />
        {open && (
          <ul role="group">
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.files.map((file) => (
              <FileRow
                key={`f:${file.id}`}
                file={file}
                depth={depth + 1}
                active={selectedId === file.id}
                checked={Boolean(checked[file.id])}
                showPath={false}
                lang={lang}
                actions={actions}
              />
            ))}
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
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            placeholder={t(lang, "searchFiles")}
            aria-label={t(lang, "searchFiles")}
            className="h-8 w-full rounded-md border border-[var(--line)] bg-[var(--bg)] pl-7 pr-6 text-sm focus:border-[var(--accent)] focus:outline-none"
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
          {matches.slice(0, 500).map((file) => (
            <FileRow
              key={`f:${file.id}`}
              file={file}
              depth={0}
              active={selectedId === file.id}
              checked={Boolean(checked[file.id])}
              showPath
              lang={lang}
              actions={actions}
            />
          ))}
        </ul>
      ) : (
        <ul
          role="tree"
          aria-label={t(lang, "files")}
          className="min-h-24 pb-3"
          onDragOver={(event) => actions.dragOver(event, isInternalDrag(event) ? "" : currentFolder, false)}
          onDragLeave={actions.dragLeave}
          onDrop={(event) => actions.drop(event, isInternalDrag(event) ? "" : currentFolder)}
        >
          {renderFolder(tree, 0)}
        </ul>
      )}
    </div>
  );
});
