import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowsLeftRight,
  Check,
  Copy,
  Export as ExportIcon,
  Eye,
  File as FileIcon,
  FolderPlus,
  FolderSimplePlus,
  MagnifyingGlass,
  PencilSimple,
  SlidersHorizontal,
  Stack,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChannelToggles } from "../components/ChannelToggles";
import { ContextMenu, type MenuItem, type MenuState } from "../components/ContextMenu";
import { folderInputId } from "../components/DropZone";
import { ExportPanel } from "../components/ExportPanel";
import { countFilesIn, FileTree, orderedFiles, type TreeTarget } from "../components/FileTree";
import { ConfirmDialog, Modal, NameDialog } from "../components/Modal";
import { Glass } from "../components/Glass";
import { Guide } from "../components/Guide";
import { Shell } from "../components/Shell";
import { TransferDialog, type TransferSeed } from "../components/TransferDialog";
import { UploadBar } from "../components/UploadBar";
import { SlideLoading, SlideStage, SlideZoomControls, loadDisplay } from "../components/SlideStage";
import { ZoomStage } from "../components/ZoomStage";
import { t } from "../i18n";
import { createFolder, deleteFile, deleteFolder, fetchDisplay, getFile, prefetchDisplay, renameFolder, slideInfo, updateFile } from "../lib/api";
import { axisSize, baseName, detailMessage, fileExtension, formatUm, isSlide, joinPath, parentPath } from "../lib/format";
import { createPreviewLayers, drawPreview, unpackPlane } from "../lib/plane";
import { readPref, writePref } from "../lib/storage";
import type { SlideViewer, ViewState } from "../lib/slide";
import type { ExportTarget, FileSummary, LutSetting, PackedPlane, SlideInfo } from "../lib/types";
import { useApp } from "../store";

type WorkspaceTab = "identify" | "metadata" | "export";

interface LocalPreview {
  fileId: string;
  dimensions: Pick<PackedPlane, "width" | "height">;
  layers: ReturnType<typeof createPreviewLayers>;
}

type NameAction =
  | { mode: "newFolder"; parent: string }
  | { mode: "renameFolder"; path: string }
  | { mode: "renameFile"; file: FileSummary };

type DeleteAction = { type: "folder"; path: string } | { type: "file"; file: FileSummary };

const UPLOAD_INPUT = "workspace-nd2-upload";
const TREE_WIDTH_KEY = "nd2utils.treeWidth";
const TREE_WIDTH_DEFAULT = 340;
const TREE_WIDTH_MIN = 240;

function clampTreeWidth(width: number) {
  return Math.round(Math.min(Math.max(width, TREE_WIDTH_MIN), Math.max(TREE_WIDTH_MIN, window.innerWidth * 0.6)));
}

const WORKSPACE_TABS: { key: WorkspaceTab; label: WorkspaceTab }[] = [
  { key: "identify", label: "identify" },
  { key: "metadata", label: "metadata" },
  { key: "export", label: "export" },
];

export function Workspace() {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const selectedId = useApp((s) => s.selectedId);
  const detail = useApp((s) => s.detail);
  const checked = useApp((s) => s.checked);
  const select = useApp((s) => s.select);
  const setDetail = useApp((s) => s.setDetail);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const checkAll = useApp((s) => s.checkAll);
  const setCurrentFolder = useApp((s) => s.setCurrentFolder);
  const reveal = useApp((s) => s.reveal);
  const folders = useApp((s) => s.folders);
  const isAdmin = useApp((s) => s.user?.role === "admin");
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<WorkspaceTab>("identify");
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);
  const [composite, setComposite] = useState(true);
  const [scaleBar, setScaleBar] = useState(true);
  const [visible, setVisible] = useState<boolean[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const [nameAction, setNameAction] = useState<NameAction | null>(null);
  const [deleteAction, setDeleteAction] = useState<DeleteAction | null>(null);
  const [transferSeed, setTransferSeed] = useState<TransferSeed | null>(null);
  const [treeWidth, setTreeWidth] = useState(() => clampTreeWidth(Number(readPref(TREE_WIDTH_KEY)) || TREE_WIDTH_DEFAULT));
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [slide, setSlide] = useState<SlideInfo | null>(null);
  const [slideViewer, setSlideViewer] = useState<SlideViewer | null>(null);
  const [slideView, setSlideView] = useState<ViewState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    void refreshFiles().catch((err) => setError(detailMessage(err, lang)));
  }, [lang, refreshFiles]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setLoadingDetail(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    void getFile(selectedId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err) => {
        if (!cancelled) setError(detailMessage(err, lang));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang, selectedId, setDetail]);

  useEffect(() => {
    setPendingDelete(null);
  }, [selectedId]);

  const previewFileId = useRef<string | null>(null);
  useEffect(() => {
    if (previewFileId.current === selectedId) return;
    previewFileId.current = selectedId;
    const file = files.find((item) => item.id === selectedId);
    setVisible(file?.channels.map(() => true) ?? []);
    setComposite(true);
    setScaleBar(true);
  }, [files, selectedId]);

  const selected = files.find((file) => file.id === selectedId) ?? null;
  const channelVisible = useMemo(
    () => selected?.channels.map((_, index) => visible[index] ?? true) ?? [],
    [selected, visible],
  );
  const previewReady = Boolean(selected && localPreview?.fileId === selected.id);
  const selectedIsSlide = isSlide(selected);
  const slideReady = Boolean(selected && selectedIsSlide && slide?.id === selected.id && selected.prepare !== "pending");

  // Slides are shown with the tiled viewer, zoomable down to full resolution.
  useEffect(() => {
    if (!selected || !selectedIsSlide || selected.prepare === "pending") return;
    if (slide?.id === selected.id) return;
    let cancelled = false;
    void slideInfo(selected.id)
      .then((next) => {
        if (!cancelled) setSlide(next);
      })
      .catch((err) => {
        if (!cancelled) setError(detailMessage(err, lang));
      });
    return () => {
      cancelled = true;
    };
  }, [lang, selected, selectedIsSlide, slide?.id]);

  const slideDisplay = useMemo(
    () => (slideReady && slide ? loadDisplay(slide).map((d, i) => ({ ...d, visible: channelVisible[i] ?? true })) : []),
    [channelVisible, slide, slideReady],
  );

  useEffect(() => {
    if (!selected || isSlide(selected)) {
      setLocalPreview(null);
      setLoadingPreview(false);
      return;
    }
    let cancelled = false;
    const file = selected;
    setLoadingPreview(true);
    // The server prepared these 8-bit, auto-contrasted channels when the file was imported.
    void fetchDisplay(file.id)
      .then((buffer) => {
        if (cancelled) return;
        const packed = unpackPlane(buffer);
        const luts: LutSetting[] = packed.channels.map((channel, index) => ({
          min: 0,
          max: 255,
          gamma: 1,
          visible: true,
          color: file.channels[index]?.color ?? channel.color,
        }));
        const layers = createPreviewLayers(packed, luts);
        setLocalPreview({
          fileId: file.id,
          dimensions: { width: packed.width, height: packed.height },
          layers,
        });
      })
      .catch((err) => {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          setError(detailMessage(err, lang));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang, selected?.id]);

  // Warm up the neighbours so stepping through a folder does not wait for the network.
  const order = useMemo(() => orderedFiles(folders, files), [folders, files]);
  useEffect(() => {
    if (!previewReady || !selectedId) return;
    const at = order.findIndex((f) => f.id === selectedId);
    if (at < 0) return;
    const handle = window.setTimeout(() => {
      prefetchDisplay(
        [order[at + 1], order[at + 2], order[at - 1]]
          .filter((f): f is FileSummary => Boolean(f) && f.prepare === "ready")
          .map((f) => f.id),
      );
    }, 150);
    return () => window.clearTimeout(handle);
  }, [order, previewReady, selectedId]);

  // While files are still being prepared in the background, keep their status fresh.
  const preparing = files.some((f) => f.prepare === "pending");
  useEffect(() => {
    if (!preparing) return;
    const handle = window.setInterval(() => void refreshFiles().catch(() => undefined), 2500);
    return () => window.clearInterval(handle);
  }, [preparing, refreshFiles]);

  function resizeTree(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = treeWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let latest = startWidth;
    const move = (e: PointerEvent) => {
      latest = clampTreeWidth(startWidth + e.clientX - startX);
      setTreeWidth(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      writePref(TREE_WIDTH_KEY, String(latest));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function nudgeTree(delta: number) {
    const next = clampTreeWidth(treeWidth + delta);
    setTreeWidth(next);
    writePref(TREE_WIDTH_KEY, String(next));
  }

  useLayoutEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !selected || localPreview?.fileId !== selected.id) return;
    drawPreview(canvas, localPreview.dimensions, localPreview.layers, {
      composite,
      scaleBar,
      visible: channelVisible,
      umPerPixel: Number(selected.voxel_um?.[0] || 0),
    });
  }, [channelVisible, composite, localPreview, scaleBar, selected]);
  const selectedIds = files.filter((file) => checked[file.id]).map((file) => file.id);
  // Slides are exported from the slide viewer (by region / channel / resolution), not in batches.
  const exportIds = (selectedIds.length ? selectedIds : selected ? [selected.id] : []).filter(
    (id) => !isSlide(files.find((file) => file.id === id)),
  );
  const allChecked = files.length > 0 && files.every((file) => checked[file.id]);

  const metaBlob = useMemo(() => {
    if (!detail) return "";
    return JSON.stringify(
      {
        name: detail.name,
        version: detail.version,
        shape: detail.shape,
        channels: detail.channels,
        voxel_um: detail.voxel_um,
        objective: detail.objective,
        instrument: detail.instrument,
        software: detail.software,
        text_info: detail.text_info,
        groups: detail.groups,
        events: detail.events,
      },
      null,
      2,
    );
  }, [detail]);

  const filteredText = useMemo(() => {
    if (!detail) return [];
    const rows = Object.entries(detail.text_info || {}).map(([k, v]) => ({ k, v }));
    if (Object.keys(detail.groups ?? {}).length) {
      rows.push({ k: "groups", v: JSON.stringify(detail.groups, null, 2) });
    }
    const query = q.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => row.k.toLowerCase().includes(query) || row.v.toLowerCase().includes(query));
  }, [detail, q]);

  function toggleChannel(index: number) {
    setVisible((prev) => {
      const count = selected?.channels.length ?? prev.length;
      const next = Array.from({ length: count }, (_, i) => prev[i] ?? true);
      next[index] = !next[index];
      return next;
    });
  }

  function uploadInto(folder: string, pickFolder: boolean) {
    setCurrentFolder(folder);
    document.getElementById(pickFolder ? folderInputId(UPLOAD_INPUT) : UPLOAD_INPUT)?.click();
  }

  function exportFolder(path: string) {
    setExportTarget({ fileIds: [], folders: [path], label: path || t(lang, "workspaceRoot") });
  }

  function exportFiles(list: FileSummary[]) {
    setExportTarget({
      fileIds: list.map((f) => f.id),
      folders: [],
      label: list.length === 1 ? joinPath(list[0].folder, list[0].name) : `${list.length} ${t(lang, "nFiles")}`,
    });
  }

  function openMenu(target: TreeTarget, x: number, y: number) {
    const items: MenuItem[] = [];
    if (target.type === "folder") {
      const path = target.path;
      const count = countFilesIn(files, path);
      items.push(
        { key: "export", label: t(lang, "exportEllipsis"), icon: <ExportIcon size={15} />, disabled: count === 0, onSelect: () => exportFolder(path) },
        { key: "upload", label: t(lang, "uploadFilesHere"), icon: <UploadSimple size={15} />, separated: true, onSelect: () => uploadInto(path, false) },
        { key: "upload-dir", label: t(lang, "uploadFolderHere"), icon: <FolderSimplePlus size={15} />, onSelect: () => uploadInto(path, true) },
        { key: "mkdir", label: t(lang, "newFolder"), icon: <FolderPlus size={15} />, onSelect: () => setNameAction({ mode: "newFolder", parent: path }) },
      );
      if (isAdmin && count > 0) {
        items.push({
          key: "transfer",
          label: t(lang, "transferEllipsis"),
          icon: <ArrowsLeftRight size={15} />,
          onSelect: () => setTransferSeed({ fileIds: [], folders: [path] }),
        });
      }
      if (path) {
        items.push(
          { key: "rename", label: t(lang, "rename"), icon: <PencilSimple size={15} />, separated: true, onSelect: () => setNameAction({ mode: "renameFolder", path }) },
          { key: "delete", label: t(lang, "deleteFolder"), icon: <Trash size={15} />, danger: true, onSelect: () => setDeleteAction({ type: "folder", path }) },
        );
      }
      setMenu({ x, y, title: path || t(lang, "workspaceRoot"), items });
      return;
    }
    const file = target.file;
    const checkedFiles = files.filter((f) => checked[f.id]);
    const exportChecked = checked[file.id] && checkedFiles.length > 1;
    items.push(
      { key: "open", label: t(lang, "open"), icon: <Eye size={15} />, onSelect: () => select(file.id) },
      isSlide(file)
        ? { key: "slide", label: t(lang, "openSlide"), icon: <Stack size={15} />, onSelect: () => nav(`/slide/${file.id}`) }
        : { key: "advanced", label: t(lang, "openAdvanced"), icon: <SlidersHorizontal size={15} />, onSelect: () => nav(`/advanced/${file.id}`) },
      {
        key: "export",
        label: exportChecked ? `${t(lang, "exportSelected")} (${checkedFiles.length})` : t(lang, "exportEllipsis"),
        icon: <ExportIcon size={15} />,
        separated: true,
        onSelect: () => exportFiles(exportChecked ? checkedFiles : [file]),
      },
      ...(isAdmin
        ? [
            {
              key: "transfer",
              label: t(lang, "transferEllipsis"),
              icon: <ArrowsLeftRight size={15} />,
              onSelect: () => setTransferSeed({ fileIds: (exportChecked ? checkedFiles : [file]).map((f) => f.id), folders: [] }),
            },
          ]
        : []),
      { key: "rename", label: t(lang, "rename"), icon: <PencilSimple size={15} />, separated: true, onSelect: () => setNameAction({ mode: "renameFile", file }) },
      { key: "delete", label: t(lang, "delete"), icon: <Trash size={15} />, danger: true, onSelect: () => setDeleteAction({ type: "file", file }) },
    );
    setMenu({ x, y, title: joinPath(file.folder, file.name), items });
  }

  async function submitName(value: string) {
    if (!nameAction) return;
    if (nameAction.mode === "newFolder") {
      const created = await createFolder(joinPath(nameAction.parent, value));
      setCurrentFolder(created.path);
      reveal(created.path);
    } else if (nameAction.mode === "renameFolder") {
      const renamed = await renameFolder(nameAction.path, joinPath(parentPath(nameAction.path), value));
      const current = useApp.getState().currentFolder;
      if (current === nameAction.path || current.startsWith(`${nameAction.path}/`)) {
        setCurrentFolder(renamed.path + current.slice(nameAction.path.length));
      }
      reveal(renamed.path);
    } else {
      // Images of a LIF project are named by LAS X and have no extension ("Series 1.5x" is not ".5x").
      const ext = nameAction.file.format === "lif" ? "" : fileExtension(nameAction.file.name) || ".nd2";
      const name = !ext || value.toLowerCase().endsWith(ext.toLowerCase()) ? value : `${value}${ext}`;
      await updateFile(nameAction.file.id, { name });
    }
    await refreshFiles();
  }

  async function submitDelete() {
    if (!deleteAction) return;
    if (deleteAction.type === "folder") {
      await deleteFolder(deleteAction.path);
      if (useApp.getState().currentFolder.startsWith(deleteAction.path)) setCurrentFolder(parentPath(deleteAction.path));
    } else {
      await deleteFile(deleteAction.file.id);
    }
    await refreshFiles();
  }

  async function confirmDelete() {
    if (!selected) return;
    try {
      setError(null);
      await deleteFile(selected.id);
      setPendingDelete(null);
      await refreshFiles();
    } catch (err) {
      setError(detailMessage(err, lang));
    }
  }

  return (
    <Shell dense>
      <div
        className="grid min-h-[calc(100dvh-4rem)] grid-cols-1 lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:grid-cols-[var(--tree-w)_minmax(0,1fr)_340px]"
        style={{ "--tree-w": `${treeWidth}px` } as React.CSSProperties}
      >
        <Glass as="aside" shape="panel" className="relative flex min-h-0 flex-col overflow-visible border-b lg:border-b-0">
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t(lang, "resizePanel")}
            aria-valuenow={treeWidth}
            tabIndex={0}
            title={t(lang, "resizePanel")}
            onPointerDown={resizeTree}
            onDoubleClick={() => nudgeTree(TREE_WIDTH_DEFAULT - treeWidth)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") nudgeTree(-24);
              if (event.key === "ArrowRight") nudgeTree(24);
            }}
            className="group absolute inset-y-0 -right-1.5 z-10 hidden w-3 cursor-col-resize touch-none lg:block"
          >
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--accent)] group-focus-visible:bg-[var(--accent)] group-active:bg-[var(--accent)]" />
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-[12px] text-[var(--text-dim)]">
            <span className="inline-flex items-center gap-2">
              {t(lang, "files")}
              <span className="font-mono text-[10px]">{files.length}</span>
            </span>
            <span className="flex items-center gap-0.5">
              {files.length > 0 && (
                <button
                  type="button"
                  onClick={() => checkAll(!allChecked)}
                  className="rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
                >
                  {t(lang, allChecked ? "clearSelection" : "selectAll")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setNameAction({ mode: "newFolder", parent: useApp.getState().currentFolder })}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
                aria-label={t(lang, "newFolder")}
                title={t(lang, "newFolder")}
              >
                <FolderPlus size={16} />
              </button>
            </span>
          </div>
          <div className="px-3 pb-2.5">
            <UploadBar inputId={UPLOAD_INPUT} />
          </div>

          <AnimatePresence>
            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mx-3 mb-2 overflow-hidden text-[12px] leading-5 text-[var(--danger)]"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          <div className="min-h-0 flex-1 overflow-auto border-t border-[var(--line)] max-lg:max-h-[70dvh]">
            <FileTree onMenu={openMenu} />
            {files.length === 0 && (
              <p className="mx-3 mb-3 rounded-xl border border-dashed border-[var(--line)] px-4 py-6 text-center text-[12px] leading-5 text-[var(--text-dim)]">
                <FileIcon size={22} weight="duotone" className="mx-auto mb-2 text-[var(--accent)]" />
                {t(lang, "emptyFiles")}
              </p>
            )}
          </div>
          <p className="border-t border-[var(--line)] px-3 py-2 text-[11px] leading-4 text-[var(--text-dim)]">{t(lang, "treeHint")}</p>
        </Glass>

        <main className="min-h-[430px] bg-[var(--well)]">
          {selected && selectedIsSlide ? (
            <div className="flex h-full min-h-[430px] flex-col">
              <div className="flex min-h-11 items-center gap-1 border-b border-white/[0.06] bg-black/20 px-3 text-[11px] text-white/58">
                <SlideZoomControls viewer={slideViewer} view={slideReady ? slideView : null} />
                <button
                  type="button"
                  onClick={() => nav(`/slide/${selected.id}`)}
                  className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg px-2 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Stack size={14} /> {t(lang, "openSlide")}
                </button>
              </div>
              {slideReady && slide && slideDisplay.length === slide.channels.length ? (
                <SlideStage
                  info={slide}
                  display={slideDisplay}
                  scaleBar={scaleBar}
                  onViewer={setSlideViewer}
                  onView={setSlideView}
                >
                  <Glass tone="dark" shape="chip" className="absolute left-3 top-3 z-20 flex gap-1 overflow-visible p-1">
                    <button
                      type="button"
                      onClick={() => setScaleBar((value) => !value)}
                      aria-pressed={scaleBar}
                      className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-[11px] transition-all duration-200 ${scaleBar ? "bg-white text-black shadow-sm" : "text-white/65 hover:bg-white/10 hover:text-white"}`}
                    >
                      {t(lang, "scaleBar")}
                    </button>
                  </Glass>
                  {selected.channels.length > 0 && (
                    <Glass tone="dark" shape="chip" className="absolute bottom-3 left-3 z-20 max-w-[min(100%-10rem,32rem)] overflow-visible p-1">
                      <ChannelToggles channels={selected.channels} visible={channelVisible} onToggle={toggleChannel} />
                    </Glass>
                  )}
                </SlideStage>
              ) : (
                <SlideLoading preparing={selected.prepare === "pending"} />
              )}
            </div>
          ) : (
          <ZoomStage
            src={null}
            alt={t(lang, "previewAlt")}
            mediaReady={previewReady}
            mediaLoading={loadingPreview}
            media={
              <canvas
                ref={previewCanvasRef}
                role="img"
                aria-label={t(lang, "previewAlt")}
                className="block max-h-none max-w-none"
              />
            }
          >
            <Glass tone="dark" shape="chip" className="absolute left-3 top-3 flex gap-1 overflow-visible p-1">
              {([
                ["overlay", composite, () => setComposite(true)],
                ["split", !composite, () => setComposite(false)],
                ["scaleBar", scaleBar, () => setScaleBar((value) => !value)],
              ] as const).map(([key, active, action]) => (
                <button
                  key={key}
                  type="button"
                  onClick={action}
                  aria-pressed={active}
                  className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-[11px] transition-all duration-200 ${active ? "bg-white text-black shadow-sm" : "text-white/65 hover:bg-white/10 hover:text-white"}`}
                >
                  {t(lang, key)}
                </button>
              ))}
            </Glass>
            {selected && selected.channels.length > 0 && (
              <Glass tone="dark" shape="chip" className="absolute bottom-3 left-3 max-w-[min(100%-1.5rem,32rem)] overflow-visible p-1">
                <ChannelToggles channels={selected.channels} visible={channelVisible} onToggle={toggleChannel} />
              </Glass>
            )}
          </ZoomStage>
          )}
        </main>

        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-t lg:border-l lg:border-t-0">
          <div className="flex gap-1 border-b border-[var(--line)] p-2 text-[12px]" role="tablist">
            {WORKSPACE_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`relative flex-1 rounded-lg px-2 py-2 transition-colors ${tab === key ? "text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
              >
                {tab === key && (
                  <motion.span
                    layoutId="workspace-tab"
                    className="absolute inset-0 rounded-lg bg-[var(--text)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative z-[1]">{t(lang, label)}</span>
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selected && (
              <div className="flex min-h-44 flex-col items-center justify-center text-center text-[13px] leading-5 text-[var(--text-dim)]">
                <FileIcon size={24} weight="duotone" className="mb-3 text-[var(--accent)]" />
                <p className="max-w-[27ch]">{t(lang, "noneSelected")}</p>
              </div>
            )}

            {selected && (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={tab}
                  initial={reduce ? false : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? undefined : { opacity: 0, x: -6 }}
                  transition={{ duration: 0.2 }}
                >
                  {tab === "identify" && (
                    <>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px]">
                        {isSlide(selected) ? (
                          <>
                            <dt className="text-[var(--text-dim)]">{t(lang, "format")}</dt>
                            <dd className="font-mono tabular-nums">
                              {selected.format === "tiff" ? "TIFF" : "OME-TIFF"}
                              {selected.levels?.length ? ` · ${selected.levels.length} ${t(lang, "pyramidLevels")}` : ""}
                            </dd>
                          </>
                        ) : selected.format === "lif" ? (
                          <>
                            <dt className="text-[var(--text-dim)]">{t(lang, "format")}</dt>
                            <dd className="font-mono tabular-nums">Leica LIF</dd>
                          </>
                        ) : (
                          <>
                            <dt className="text-[var(--text-dim)]">{t(lang, "version")}</dt>
                            <dd className="font-mono tabular-nums">{selected.version?.join(".") ?? "–"}</dd>
                          </>
                        )}
                        <dt className="text-[var(--text-dim)]">{t(lang, "dtype")}</dt>
                        <dd className="font-mono tabular-nums">
                          {selected.dtype ?? "–"} {selected.bits_significant ? `(${selected.bits_significant}-bit)` : ""}
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "shape")}</dt>
                        <dd className="break-words font-mono tabular-nums">
                          {selected.axes?.map((axis) => `${axis.name}${axis.size}`).join(" ") || selected.shape.join("×")}
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "channels")}</dt>
                        <dd>
                          <ChannelToggles
                            variant="list"
                            channels={selected.channels}
                            visible={channelVisible}
                            onToggle={toggleChannel}
                          />
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "objective")}</dt>
                        <dd>
                          {selected.objective ?? "–"}
                          {selected.na ? ` · NA ${selected.na}` : ""}
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "voxel")}</dt>
                        <dd className="font-mono tabular-nums">{formatUm(selected.voxel_um?.[0])}/px</dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "instrument")}</dt>
                        <dd>{selected.instrument ?? "–"}</dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "software")}</dt>
                        <dd>{selected.software ?? "–"}</dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "acquired")}</dt>
                        <dd className="font-mono text-[11px] tabular-nums">{selected.acquired ?? "–"}</dd>
                      </dl>

                      <div className="mt-7 flex flex-wrap gap-2">
                        {isSlide(selected) ? (
                          <button type="button" onClick={() => nav(`/slide/${selected.id}`)} className="primary-action min-h-9 px-4 text-[12px]">
                            {t(lang, "openSlide")}
                          </button>
                        ) : (
                          <button type="button" onClick={() => nav(`/advanced/${selected.id}`)} className="primary-action min-h-9 px-4 text-[12px]">
                            {t(lang, "openAdvanced")}
                          </button>
                        )}
                        {pendingDelete !== selected.id && (
                          <button
                            type="button"
                            onClick={() => setPendingDelete(selected.id)}
                            className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12px] text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_9%,transparent)]"
                          >
                            <Trash size={14} /> {t(lang, "delete")}
                          </button>
                        )}
                      </div>

                      <AnimatePresence>
                        {pendingDelete === selected.id && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, height: 0 }}
                            animate={{ opacity: 1, y: 0, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="mt-4 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--danger)_28%,var(--line))] bg-[color-mix(in_srgb,var(--danger)_6%,var(--bg))] p-3"
                          >
                            <p className="text-[12px] leading-5 text-[var(--text-dim)]">{t(lang, "deleteHint")}</p>
                            <div className="mt-3 flex gap-2">
                              <button type="button" onClick={() => void confirmDelete()} className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--danger)] px-3 text-[11px] font-medium text-white">
                                <Check size={13} /> {t(lang, "confirmDelete")}
                              </button>
                              <button type="button" onClick={() => setPendingDelete(null)} className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-[11px] text-[var(--text-dim)] hover:bg-[var(--bg)]">
                                <X size={13} /> {t(lang, "cancel")}
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  )}

                  {tab === "metadata" && (
                    <div className="flex flex-col gap-3">
                      {loadingDetail && <p className="text-[12px] text-[var(--text-dim)]">{t(lang, "loadingFile")}</p>}
                      {!loadingDetail && detail && (
                        <>
                          <label className="relative block">
                            <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
                            <input
                              value={q}
                              onChange={(event) => setQ(event.target.value)}
                              placeholder={t(lang, "searchMeta")}
                              className="h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] pl-9 pr-3 text-[13px] transition-colors focus:border-[var(--accent)]"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={async () => {
                              await navigator.clipboard.writeText(metaBlob);
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1200);
                            }}
                            className="inline-flex min-h-8 items-center gap-1.5 self-start rounded-lg px-2 text-[12px] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                          >
                            {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
                            {copied ? t(lang, "copied") : t(lang, "copyJson")}
                          </button>

                          {filteredText.map((row) => (
                            <section key={row.k}>
                              <h3 className="text-[12px] font-semibold text-[var(--text-dim)]">{row.k}</h3>
                              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg)] p-2.5 font-mono text-[10px] leading-relaxed">
                                {row.v}
                              </pre>
                            </section>
                          ))}
                          {detail.events?.length ? (
                            <section>
                              <h3 className="text-[12px] font-semibold text-[var(--text-dim)]">{t(lang, "events")}</h3>
                              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg)] p-2.5 font-mono text-[10px] leading-relaxed">
                                {JSON.stringify(detail.events, null, 2)}
                              </pre>
                            </section>
                          ) : null}
                          {filteredText.length === 0 && !detail.events?.length && (
                            <p className="py-6 text-center text-[12px] text-[var(--text-dim)]">
                              {t(lang, q ? "noSearchResults" : "noMetadata")}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {tab === "export" && (
                    <>
                      <p className="mb-3 truncate text-[12px] text-[var(--text-dim)]" title={exportIds.length === 1 ? joinPath(selected.folder, selected.name) : undefined}>
                        {selectedIds.length
                          ? `${t(lang, "checkedCount")} ${selectedIds.length} ${t(lang, "nFiles")}`
                          : joinPath(selected.folder, selected.name)}
                      </p>
                      {exportIds.length > 0 ? (
                        <ExportPanel fileIds={exportIds} />
                      ) : (
                        <div className="flex flex-col gap-3">
                          <Guide title="export" body="slideExportHint" />
                          {isSlide(selected) && (
                            <button type="button" onClick={() => nav(`/slide/${selected.id}`)} className="primary-action min-h-9 self-start px-4 text-[12px]">
                              {t(lang, "openSlide")}
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {selected && (
            <p className="border-t border-[var(--line)] px-4 py-2.5 font-mono text-[10px] text-[var(--text-dim)] tabular-nums">
              T{axisSize(selected.axes, "T")} · Z{axisSize(selected.axes, "Z")} · C{axisSize(selected.axes, "C")} · P{axisSize(selected.axes, "P")}
            </p>
          )}
        </Glass>
      </div>

      <ContextMenu menu={menu} onClose={closeMenu} />

      {isAdmin && (
        <TransferDialog
          open={Boolean(transferSeed)}
          seed={transferSeed}
          onClose={() => setTransferSeed(null)}
          onDone={() => void refreshFiles()}
        />
      )}

      <Modal
        open={Boolean(exportTarget)}
        title={exportTarget?.folders.length ? t(lang, "exportTargetFolder") : t(lang, "exportTargetFiles")}
        subtitle={
          exportTarget && (
            <>
              <span className="block truncate font-mono text-[11px] text-[var(--text)]">/{exportTarget.label}</span>
              {t(lang, "exportStructureHint")}
            </>
          )
        }
        onClose={() => setExportTarget(null)}
        width={460}
      >
        {exportTarget && (
          <ExportPanel
            fileIds={exportTarget.fileIds}
            folders={exportTarget.folders}
            fileCount={exportTarget.folders.reduce((sum, f) => sum + countFilesIn(files, f), exportTarget.fileIds.length)}
          />
        )}
      </Modal>

      <NameDialog
        open={Boolean(nameAction)}
        title={t(lang, nameAction?.mode === "newFolder" ? "newFolder" : "rename")}
        label={t(lang, nameAction?.mode === "renameFile" ? "fileName" : "folderName")}
        initial={
          nameAction?.mode === "renameFolder"
            ? baseName(nameAction.path)
            : nameAction?.mode === "renameFile"
              ? nameAction.file.name
              : ""
        }
        onSubmit={submitName}
        onClose={() => setNameAction(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteAction)}
        title={t(lang, deleteAction?.type === "folder" ? "deleteFolder" : "delete")}
        body={
          deleteAction && (
            <>
              <span className="mb-1 block truncate font-mono text-[11px] text-[var(--text)]">
                /{deleteAction.type === "folder" ? deleteAction.path : joinPath(deleteAction.file.folder, deleteAction.file.name)}
              </span>
              {t(lang, deleteAction.type === "folder" ? "deleteFolderHint" : "deleteHint")}
              {deleteAction.type === "folder" && ` (${countFilesIn(files, deleteAction.path)} ${t(lang, "nFiles")})`}
            </>
          )
        }
        confirmLabel={t(lang, "confirmDelete")}
        onConfirm={submitDelete}
        onClose={() => setDeleteAction(null)}
      />
    </Shell>
  );
}
