import { memo, useMemo, useRef, useState } from "react";
import {
  CaretRight,
  Folder,
  HardDrives,
  ImageSquare,
  ListBullets,
  SpinnerGap,
  SquaresFour,
  WarningCircle,
} from "@phosphor-icons/react";
import { t } from "../i18n";
import { thumbUrl } from "../lib/api";
import { formatBytes, rgbCss } from "../lib/format";
import { canDropInto, endDrag, isInternalDrag, performMove, readDrop, selectionFor, startDrag } from "../lib/moves";
import { readPref, writePref } from "../lib/storage";
import { buildTree, type FolderNode } from "../lib/tree";
import type { FileSummary } from "../lib/types";
import { fromDataTransfer, useUploads } from "../lib/uploads";
import { useApp } from "../store";
import type { TreeTarget } from "./FileTree";

type Mode = "list" | "grid";
type SortKey = "name" | "acquired" | "size";
const MODE_KEY = "nd2utils.folderViewMode";

function findNode(root: FolderNode, path: string): FolderNode | null {
  if (!path) return root;
  let node: FolderNode | undefined = root;
  for (const part of path.split("/")) {
    node = node?.folders.find((f) => f.name === part);
    if (!node) return null;
  }
  return node ?? null;
}

function optics(file: FileSummary): string {
  const mag = file.magnification ? `${Number(file.magnification.toPrecision(3))}x` : "";
  const zoom = file.zoom && Math.abs(file.zoom - 1) > 0.05 ? ` · zoom ${Number(file.zoom.toFixed(2))}` : "";
  return mag ? mag + zoom : "–";
}

const Thumb = memo(function Thumb({ file }: { file: FileSummary }) {
  const [failed, setFailed] = useState(false);
  if (file.prepare === "pending") {
    return (
      <span className="flex h-full w-full items-center justify-center text-white/50">
        <SpinnerGap size={20} className="animate-spin" />
      </span>
    );
  }
  if (failed || file.prepare === "error") {
    return (
      <span className="flex h-full w-full items-center justify-center text-white/40">
        <ImageSquare size={26} weight="duotone" />
      </span>
    );
  }
  return <img src={thumbUrl(file)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain" />;
});

/** File-manager view of one workspace folder (centre pane when a folder is opened). */
export function FolderView({ path, onMenu }: { path: string; onMenu: (target: TreeTarget, x: number, y: number) => void }) {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const folders = useApp((s) => s.folders);
  const checked = useApp((s) => s.checked);
  const checkedFolders = useApp((s) => s.checkedFolders);
  const [mode, setMode] = useState<Mode>(() => (readPref(MODE_KEY) === "grid" ? "grid" : "list"));
  const [sort, setSort] = useState<SortKey>("name");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);

  const node = useMemo(() => findNode(buildTree(folders, files), path), [files, folders, path]);
  const subfolders = node?.folders ?? [];
  const items = useMemo(() => {
    const list = [...(node?.files ?? [])];
    if (sort === "acquired") list.sort((a, b) => (b.acquired ?? "").localeCompare(a.acquired ?? ""));
    if (sort === "size") list.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
    return list;
  }, [node, sort]);

  const app = () => useApp.getState();
  const crumbs = path ? path.split("/") : [];

  function setMode2(next: Mode) {
    setMode(next);
    writePref(MODE_KEY, next);
  }

  function clickFile(file: FileSummary, event: React.MouseEvent) {
    if (event.shiftKey && anchor.current) {
      const from = items.findIndex((f) => f.id === anchor.current);
      const to = items.findIndex((f) => f.id === file.id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        app().setChecked(items.slice(a, b + 1).map((f) => f.id), true);
        return;
      }
    }
    anchor.current = file.id;
    if (event.metaKey || event.ctrlKey) {
      app().toggleChecked(file.id);
      return;
    }
    app().clearSelection();
    app().setChecked([file.id], true);
  }

  function clickFolder(folder: string, event: React.MouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      app().toggleFolderChecked(folder);
      return;
    }
    app().clearSelection();
    app().toggleFolderChecked(folder, true);
  }

  function menu(event: React.MouseEvent, target: TreeTarget) {
    event.preventDefault();
    event.stopPropagation();
    onMenu(target, event.clientX, event.clientY);
  }

  function dragProps(target: string) {
    return {
      onDragOver: (event: React.DragEvent) => {
        const internal = isInternalDrag(event);
        if (!internal && !event.dataTransfer.types.includes("Files")) return;
        if (internal && !canDropInto(target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = internal ? "move" : "copy";
        setDropTarget(target);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setDropTarget(null);
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        if (isInternalDrag(event)) {
          const moving = readDrop(event);
          endDrag();
          if (moving) void performMove(moving, target);
          return;
        }
        if (useUploads.getState().progress) return;
        const list = fromDataTransfer(event.dataTransfer);
        void list.then((pending) => useUploads.getState().upload(pending, target));
      },
    };
  }

  const head = "px-3 py-2 text-left text-xs font-medium text-[var(--text-dim)]";
  const empty = !subfolders.length && !items.length;

  return (
    <div className="flex h-full min-h-[450px] flex-col bg-[var(--bg)]" {...dragProps(path)}>
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--bg-elev)] px-4 py-2">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm" aria-label="breadcrumb">
          <button type="button" onClick={() => app().openFolderView("")} className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg)]">
            <HardDrives size={16} weight="duotone" className="text-[var(--accent)]" />
            {t(lang, "workspaceRoot")}
          </button>
          {crumbs.map((part, i) => {
            const target = crumbs.slice(0, i + 1).join("/");
            return (
              <span key={target} className="inline-flex min-w-0 items-center gap-1">
                <CaretRight size={11} className="shrink-0 text-[var(--text-dim)]" />
                <button
                  type="button"
                  onClick={() => app().openFolderView(target)}
                  {...dragProps(target)}
                  className={`truncate rounded-md px-1.5 py-1 hover:bg-[var(--bg)] ${i === crumbs.length - 1 ? "font-semibold" : ""} ${dropTarget === target ? "bg-[var(--accent-soft)]" : ""}`}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </nav>
        <span className="font-mono text-xs text-[var(--text-dim)]">
          {items.length} {t(lang, "nFiles")}
          {subfolders.length ? ` · ${subfolders.length} ${t(lang, "subfolders")}` : ""}
        </span>
        <div className="flex gap-0.5 rounded-lg bg-[var(--bg)] p-0.5">
          {(["list", "grid"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode2(key)}
              aria-pressed={mode === key}
              title={t(lang, key === "list" ? "viewList" : "viewGrid")}
              className={`flex h-7 w-8 items-center justify-center rounded-md ${mode === key ? "bg-[var(--bg-elev)] text-[var(--accent)] shadow-sm" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
            >
              {key === "list" ? <ListBullets size={16} /> : <SquaresFour size={16} />}
            </button>
          ))}
        </div>
      </div>

      <div className={`min-h-0 flex-1 overflow-auto ${dropTarget === path ? "ring-2 ring-inset ring-[var(--accent)]" : ""}`}>
        {empty ? (
          <p className="mx-auto mt-16 max-w-sm px-6 text-center text-sm leading-6 text-[var(--text-dim)]">{t(lang, "folderEmpty")}</p>
        ) : mode === "list" ? (
          <table className="w-full table-fixed border-collapse text-sm">
            <thead className="sticky top-0 z-[1] bg-[var(--bg)]">
              <tr className="border-b border-[var(--line)]">
                <th className={`${head} w-10`} />
                <th className={head}>
                  <button type="button" onClick={() => setSort("name")} className={sort === "name" ? "text-[var(--text)]" : ""}>
                    {t(lang, "colName")}
                  </button>
                </th>
                <th className={`${head} hidden w-36 md:table-cell`}>{t(lang, "colOptics")}</th>
                <th className={`${head} hidden w-48 lg:table-cell`}>
                  <button type="button" onClick={() => setSort("size")} className={sort === "size" ? "text-[var(--text)]" : ""}>
                    {t(lang, "colSize")}
                  </button>
                </th>
                <th className={`${head} hidden w-56 xl:table-cell`}>
                  <button type="button" onClick={() => setSort("acquired")} className={sort === "acquired" ? "text-[var(--text)]" : ""}>
                    {t(lang, "colAcquired")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {subfolders.map((folder) => (
                <tr
                  key={`d:${folder.path}`}
                  draggable
                  onDragStart={(event) => startDrag(event, selectionFor({ folder: folder.path }), folder.name)}
                  onDragEnd={endDrag}
                  {...dragProps(folder.path)}
                  onClick={(event) => clickFolder(folder.path, event)}
                  onDoubleClick={() => app().openFolderView(folder.path)}
                  onContextMenu={(event) => menu(event, { type: "folder", path: folder.path })}
                  className={`cursor-default border-b border-[var(--line)]/60 ${dropTarget === folder.path ? "bg-[var(--accent-soft)]" : checkedFolders[folder.path] ? "bg-[color-mix(in_srgb,var(--accent-soft)_60%,transparent)]" : "hover:bg-[var(--bg-elev)]"}`}
                >
                  <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={Boolean(checkedFolders[folder.path])} onChange={(event) => app().toggleFolderChecked(folder.path, event.target.checked)} aria-label={`${t(lang, "selectFolder")} ${folder.name}`} />
                  </td>
                  <td className="px-3 py-2" colSpan={4}>
                    <span className="flex items-center gap-2 font-medium">
                      <Folder size={18} weight="duotone" className="shrink-0 text-[var(--accent)]" />
                      <span className="truncate">{folder.name}</span>
                      <span className="font-mono text-2xs text-[var(--text-dim)]">{folder.total}</span>
                    </span>
                  </td>
                </tr>
              ))}
              {items.map((file) => (
                <tr
                  key={file.id}
                  draggable
                  onDragStart={(event) => startDrag(event, selectionFor({ file: file.id }), file.name)}
                  onDragEnd={endDrag}
                  onClick={(event) => clickFile(file, event)}
                  onDoubleClick={() => app().select(file.id)}
                  onContextMenu={(event) => menu(event, { type: "file", file })}
                  className={`cursor-default border-b border-[var(--line)]/60 ${checked[file.id] ? "bg-[color-mix(in_srgb,var(--accent-soft)_60%,transparent)]" : "hover:bg-[var(--bg-elev)]"}`}
                >
                  <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={Boolean(checked[file.id])} onChange={(event) => app().toggleChecked(file.id, event.target.checked)} aria-label={`${t(lang, "selectFile")} ${file.name}`} />
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex shrink-0 gap-0.5" aria-hidden>
                        {file.channels?.map((channel) => (
                          <span key={channel.index} className="h-2 w-2 rounded-full" style={{ background: rgbCss(channel.color) }} />
                        ))}
                      </span>
                      <span className="truncate">{file.name}</span>
                      {file.prepare === "pending" && <SpinnerGap size={13} className="shrink-0 animate-spin text-[var(--text-dim)]" />}
                      {file.prepare === "error" && <WarningCircle size={13} className="shrink-0 text-[var(--danger)]" />}
                    </span>
                  </td>
                  <td className="hidden truncate whitespace-nowrap px-3 py-2 font-mono text-xs md:table-cell">{optics(file)}</td>
                  <td className="hidden truncate whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--text-dim)] lg:table-cell">
                    {file.width ?? "–"}×{file.height ?? "–"} · {formatBytes(file.size_bytes, lang)}
                  </td>
                  <td className="hidden truncate whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--text-dim)] xl:table-cell">{file.acquired ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3 p-4">
            {subfolders.map((folder) => (
              <button
                key={`d:${folder.path}`}
                type="button"
                draggable
                onDragStart={(event) => startDrag(event, selectionFor({ folder: folder.path }), folder.name)}
                onDragEnd={endDrag}
                {...dragProps(folder.path)}
                onClick={(event) => clickFolder(folder.path, event)}
                onDoubleClick={() => app().openFolderView(folder.path)}
                onContextMenu={(event) => menu(event, { type: "folder", path: folder.path })}
                className={`flex flex-col items-center gap-2 rounded-xl border p-3 text-sm ${dropTarget === folder.path ? "border-[var(--accent)] bg-[var(--accent-soft)]" : checkedFolders[folder.path] ? "border-[var(--accent)]" : "border-[var(--line)] hover:border-[var(--line-strong)]"}`}
              >
                <Folder size={56} weight="duotone" className="text-[var(--accent)]" />
                <span className="w-full truncate text-center font-medium">{folder.name}</span>
                <span className="font-mono text-2xs text-[var(--text-dim)]">{folder.total}</span>
              </button>
            ))}
            {items.map((file) => (
              <button
                key={file.id}
                type="button"
                draggable
                onDragStart={(event) => startDrag(event, selectionFor({ file: file.id }), file.name)}
                onDragEnd={endDrag}
                onClick={(event) => clickFile(file, event)}
                onDoubleClick={() => app().select(file.id)}
                onContextMenu={(event) => menu(event, { type: "file", file })}
                className={`flex flex-col gap-1.5 rounded-xl border p-1.5 text-left text-sm ${checked[file.id] ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)] hover:border-[var(--line-strong)]"}`}
              >
                <span className="aspect-square w-full overflow-hidden rounded-lg bg-[var(--well)]">
                  <Thumb file={file} />
                </span>
                <span className="truncate px-1">{file.name}</span>
                <span className="truncate px-1 font-mono text-2xs text-[var(--text-dim)]">{optics(file)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
