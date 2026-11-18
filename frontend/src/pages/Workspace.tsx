import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsLeftRight,
  Binoculars,
  ClipboardText,
  ArrowElbowDownRight,
  FolderOpen,
  Scissors,
  Check,
  CheckCircle,
  Copy,
  Crop,
  Crosshair,
  Export as ExportIcon,
  Eye,
  File as FileIcon,
  FolderPlus,
  FolderSimplePlus,
  LockSimple,
  MagnifyingGlass,
  PencilSimple,
  SlidersHorizontal,
  Sparkle,
  SquaresFour,
  Stack,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { ChannelToggles } from "../components/ChannelToggles";
import { ContextMenu, type MenuItem, type MenuState } from "../components/ContextMenu";
import { CropOverlay, centerCropBoxAt, defaultCropBox, fitCropToAspect, type CropBox } from "../components/CropOverlay";
import { folderInputId } from "../components/DropZone";
import { ExportPanel } from "../components/ExportPanel";
import { FileTree, type TreeTarget } from "../components/FileTree";
import { FolderView } from "../components/FolderView";
import { MoveDialog } from "../components/MoveDialog";
import { MoveToast } from "../components/MoveToast";
import { OrganizeDialog } from "../components/OrganizeDialog";
import { ConfirmDialog, Modal, NameDialog } from "../components/Modal";
import { Glass } from "../components/Glass";
import { Guide } from "../components/Guide";
import { Shell } from "../components/Shell";
import { TransferDialog, type TransferSeed } from "../components/TransferDialog";
import { UploadBar } from "../components/UploadBar";
import { SlideLoading, SlideStage, SlideZoomControls, loadDisplay } from "../components/SlideStage";
import { ZoomStage } from "../components/ZoomStage";
import { t } from "../i18n";
import {
  clientSettings,
  createFolder,
  createProject,
  cropFile,
  deleteFile,
  deleteFolder,
  detectNuclei,
  getFile,
  listProjects,
  rebuildCache,
  renameFolder,
  resetFile,
  slideInfo,
  updateFile,
  updateProject,
} from "../lib/api";
import { forget as forgetPreviews, getDisplay, isPending, prefetch as prefetchPreviews } from "../lib/previewCache";
import { axisSize, baseName, detailMessage, fileExtension, formatUm, isSlide, joinPath, parentPath } from "../lib/format";
import { segmentNucleiFromPacked } from "../lib/nucleus";
import { createPreviewLayers, drawPreview, unpackPlane } from "../lib/plane";
import { autoScaleUm } from "../lib/scalebar";
import { readPref, writePref } from "../lib/storage";
import { countFilesIn, orderedFiles } from "../lib/tree";
import { currentSelection, performMove, selectionFor, type MoveSet } from "../lib/moves";
import type { Rect, SlideViewer, ViewState } from "../lib/slide";
import type { ExportTarget, FileSummary, LutSetting, NucleusResult, PackedPlane, SlideInfo } from "../lib/types";
import { useApp } from "../store";

type WorkspaceTab = "identify" | "metadata" | "export";

type AspectPreset = "free" | "1:1" | "2:1" | "1:2" | "4:3" | "3:4" | "16:9" | "custom";

const ASPECT_PRESETS: { key: AspectPreset; label?: string; ratio?: number }[] = [
  { key: "free" },
  { key: "1:1", label: "1:1", ratio: 1 },
  { key: "2:1", label: "2:1", ratio: 2 },
  { key: "1:2", label: "1:2", ratio: 0.5 },
  { key: "4:3", label: "4:3", ratio: 4 / 3 },
  { key: "3:4", label: "3:4", ratio: 3 / 4 },
  { key: "16:9", label: "16:9", ratio: 16 / 9 },
  { key: "custom" },
];

interface LocalPreview {
  fileId: string;
  dimensions: Pick<PackedPlane, "width" | "height">;
  layers: ReturnType<typeof createPreviewLayers>;
  packed: PackedPlane;
}

type NameAction =
  | { mode: "newFolder"; parent: string }
  | { mode: "renameFolder"; path: string }
  | { mode: "renameFile"; file: FileSummary };

type DeleteAction =
  | { type: "folder"; path: string }
  | { type: "file"; file: FileSummary }
  | { type: "selection"; items: MoveSet };

const UPLOAD_INPUT = "workspace-nd2-upload";
const TREE_WIDTH_KEY = "nd2utils.treeWidth";
const TREE_WIDTH_DEFAULT = 330;
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
  const channelLocked = useApp((s) => s.channelLocked);
  const lockedChannels = useApp((s) => s.lockedChannels);
  const resolveVisibleChannels = useApp((s) => s.resolveVisibleChannels);
  const updateLockedChannels = useApp((s) => s.updateLockedChannels);

  const nav = useNavigate();
  const [mayRebuild, setMayRebuild] = useState(false);
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
  const [moveDialog, setMoveDialog] = useState<MoveSet | null>(null);
  const [organizeFolder, setOrganizeFolder] = useState<string | null>(null);
  const folderView = useApp((s) => s.folderView);
  const checkedFolders = useApp((s) => s.checkedFolders);
  const clipboard = useApp((s) => s.clipboard);
  const [transferSeed, setTransferSeed] = useState<TransferSeed | null>(null);
  const [treeWidth, setTreeWidth] = useState(() => clampTreeWidth(Number(readPref(TREE_WIDTH_KEY)) || TREE_WIDTH_DEFAULT));
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [slide, setSlide] = useState<SlideInfo | null>(null);
  const [slideViewer, setSlideViewer] = useState<SlideViewer | null>(null);
  const [slideView, setSlideView] = useState<ViewState | null>(null);

  // Crop tool state
  const [cropping, setCropping] = useState(false);
  const [cropBox, setCropBox] = useState<CropBox>({ x: 0, y: 0, w: 100, h: 100 });
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>("1:1");
  const [customRatioW, setCustomRatioW] = useState<number>(2);
  const [customRatioH, setCustomRatioH] = useState<number>(1);
  const [cropName, setCropName] = useState("");
  const [croppingBusy, setCroppingBusy] = useState(false);
  const [cropToast, setCropToast] = useState<FileSummary | null>(null);
  const [nucleiResult, setNucleiResult] = useState<NucleusResult | null>(null);
  const [activeNucleusId, setActiveNucleusId] = useState<number | null>(null);
  const [detectingNucleus, setDetectingNucleus] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const closeMenu = useCallback(() => setMenu(null), []);
  const secondaryAction =
    "inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-sm font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]";

  useEffect(() => {
    void refreshFiles().catch((err) => setError(detailMessage(err, lang)));
  }, [lang, refreshFiles]);

  useEffect(() => {
    void clientSettings()
      .then((s) => setMayRebuild(s.cache_rebuild))
      .catch(() => undefined);
  }, []);

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

  const selected = useMemo(() => files.find((file) => file.id === selectedId) ?? null, [files, selectedId]);

  // Apply channel visibility on file switch or when channel lock changes. Depends on the
  // selected file object, which the store keeps while that file is unchanged.
  const previewFileId = useRef<string | null>(null);
  useEffect(() => {
    const file = selected;
    if (!file) {
      previewFileId.current = null;
      setVisible([]);
      return;
    }
    if (previewFileId.current !== selectedId) {
      previewFileId.current = selectedId;
      setVisible(resolveVisibleChannels(file.channels));
      setCropping(false);
      setNucleiResult(null);
      setActiveNucleusId(null);
    } else if (channelLocked) {
      setVisible(resolveVisibleChannels(file.channels));
    }
  }, [channelLocked, selected, lockedChannels, resolveVisibleChannels, selectedId]);

  const channelVisible = useMemo(
    () => selected?.channels.map((_, index) => visible[index] ?? true) ?? [],
    [selected, visible],
  );
  const previewReady = Boolean(selected && localPreview?.fileId === selected.id);
  const selectedIsSlide = isSlide(selected);
  const slideReady = Boolean(selected && selectedIsSlide && slide?.id === selected.id && selected.prepare !== "pending");

  // Compute active numeric aspect ratio for cropping
  const activeAspectRatio = useMemo<number | null>(() => {
    if (aspectPreset === "free") return null;
    if (aspectPreset === "custom") {
      const w = Number(customRatioW);
      const h = Number(customRatioH);
      return w > 0 && h > 0 ? w / h : null;
    }
    return ASPECT_PRESETS.find((p) => p.key === aspectPreset)?.ratio ?? null;
  }, [aspectPreset, customRatioW, customRatioH]);

  const activeRatioLabel = useMemo(() => {
    if (aspectPreset === "free") return "";
    if (aspectPreset === "custom") return `${customRatioW}:${customRatioH}`;
    return aspectPreset;
  }, [aspectPreset, customRatioW, customRatioH]);

  // True image pixel dimensions for cropping
  const imageDimensions = useMemo(() => {
    if (selectedIsSlide && slide && slide.id === selected?.id) {
      return { width: slide.width, height: slide.height };
    }
    if (selected && localPreview?.fileId === selected.id) {
      return localPreview.dimensions;
    }
    return {
      width: selected?.width ?? 0,
      height: selected?.height ?? 0,
    };
  }, [localPreview, selected, selectedIsSlide, slide]);

  // Initialize or adjust crop box when entering crop mode or changing aspect ratio
  useEffect(() => {
    if (!cropping || imageDimensions.width <= 0 || imageDimensions.height <= 0) return;
    setCropBox((prev) => {
      if (prev.w <= 0 || prev.h <= 0 || prev.x + prev.w > imageDimensions.width || prev.y + prev.h > imageDimensions.height) {
        return defaultCropBox(imageDimensions.width, imageDimensions.height, activeAspectRatio);
      }
      if (activeAspectRatio && activeAspectRatio > 0) {
        return fitCropToAspect(prev, imageDimensions.width, imageDimensions.height, activeAspectRatio);
      }
      return prev;
    });
  }, [activeAspectRatio, cropping, imageDimensions.height, imageDimensions.width]);

  function startCropping() {
    if (!selected) return;
    const w = imageDimensions.width;
    const h = imageDimensions.height;
    if (w <= 0 || h <= 0) return;
    if (!selectedIsSlide && !composite) {
      setComposite(true);
    }
    setCropBox(defaultCropBox(w, h, activeAspectRatio));
    setCropName("");
    setNucleiResult(null);
    setActiveNucleusId(null);
    setCropping(true);
  }

  function resetCropBox() {
    if (imageDimensions.width <= 0 || imageDimensions.height <= 0) return;
    setCropBox(defaultCropBox(imageDimensions.width, imageDimensions.height, activeAspectRatio));
    setActiveNucleusId(null);
  }

  async function handleDetectNucleus() {
    if (!selected || detectingNucleus) return;
    setDetectingNucleus(true);
    setError(null);
    try {
      let res: NucleusResult;
      if (localPreview && localPreview.fileId === selected.id && localPreview.packed) {
        res = segmentNucleiFromPacked(
          localPreview.packed,
          selected.channels,
          Number(selected.voxel_um?.[0] || 0),
          undefined,
          imageDimensions,
        );
      } else {
        res = await detectNuclei(selected.id);
      }
      setNucleiResult(res);
      const first = res.nuclei[0];
      if (first && imageDimensions.width > 0 && imageDimensions.height > 0) {
        setActiveNucleusId(first.id);
        setCropBox((prev) =>
          centerCropBoxAt(
            first.cx,
            first.cy,
            prev.w,
            prev.h,
            imageDimensions.width,
            imageDimensions.height,
            activeAspectRatio,
          ),
        );
      } else {
        setActiveNucleusId(null);
      }
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setDetectingNucleus(false);
    }
  }

  function handleSelectNucleus(id: number) {
    const nuc = nucleiResult?.nuclei.find((n) => n.id === id);
    if (!nuc || imageDimensions.width <= 0 || imageDimensions.height <= 0) return;
    setActiveNucleusId(id);
    setCropBox((prev) =>
      centerCropBoxAt(
        nuc.cx,
        nuc.cy,
        prev.w,
        prev.h,
        imageDimensions.width,
        imageDimensions.height,
        activeAspectRatio,
      ),
    );
  }

  async function handleCreateCrop(mode: "new" | "inplace" = "new") {
    if (!selected || croppingBusy) return;
    setCroppingBusy(true);
    setError(null);
    try {
      const created = await cropFile(selected.id, {
        x: Math.round(cropBox.x),
        y: Math.round(cropBox.y),
        w: Math.round(cropBox.w),
        h: Math.round(cropBox.h),
        ratio_label: activeRatioLabel,
        name: mode === "new" ? cropName.trim() || undefined : undefined,
        mode,
      });
      if (mode === "inplace") {
        forgetPreviews([selected.id]);
      }
      await refreshFiles();
      if (mode === "inplace") {
        void getFile(selected.id)
          .then(setDetail)
          .catch(() => undefined);
      }
      setCropping(false);
      setCropToast(created);
      select(created.id);
      window.setTimeout(() => {
        setCropToast((current) => (current?.id === created.id ? null : current));
      }, 5000);
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setCroppingBusy(false);
    }
  }

  async function handleRestoreOriginal(fileId: string) {
    if (restoring) return;
    setRestoring(true);
    setError(null);
    try {
      await resetFile(fileId);
      forgetPreviews([fileId]);
      await refreshFiles();
      if (selectedId === fileId) {
        const next = await getFile(fileId);
        setDetail(next);
      }
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setRestoring(false);
    }
  }

  async function handleOpenInStudio(ids: string[], projectId?: string) {
    const targetIds = ids.filter((id) => Boolean(files.find((f) => f.id === id)));
    if (targetIds.length === 0) return;
    try {
      setError(null);
      if (projectId) {
        const existing = (await listProjects()).find((p) => p.id === projectId);
        const merged = [...new Set([...(existing?.file_ids ?? []), ...targetIds])];
        await updateProject(projectId, { file_ids: merged });
        nav(`/studio/${projectId}`);
        return;
      }
      const proj = await createProject({
        name: `${t(lang, "newProject")} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        file_ids: targetIds,
      });
      nav(`/studio/${proj.id}`);
    } catch (err) {
      setError(detailMessage(err, lang));
    }
  }

  /** "Add to project": pick one of the recent projects or start a new one (it used to create a
   * new project on every click). */
  function openProjectPicker(event: React.MouseEvent, ids: string[]) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    void listProjects()
      .catch(() => [])
      .then((projects) => {
        const items: MenuItem[] = [
          {
            key: "new",
            label: t(lang, "newProject"),
            icon: <FolderSimplePlus size={15} />,
            onSelect: () => void handleOpenInStudio(ids),
          },
          ...projects.slice(0, 8).map((project, index) => ({
            key: project.id,
            label: `${project.name} · ${project.file_ids.length}`,
            icon: <SquaresFour size={15} />,
            separated: index === 0,
            onSelect: () => void handleOpenInStudio(ids, project.id),
          })),
        ];
        setMenu({ x: box.left, y: box.bottom + 6, title: t(lang, "addToProject"), items });
      });
  }

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

  const channelsKey = useMemo(() => JSON.stringify(selected?.channels ?? null), [selected?.channels]);

  useEffect(() => {
    if (!selected || isSlide(selected)) {
      setLocalPreview(null);
      setLoadingPreview(false);
      return;
    }
    let cancelled = false;
    let pending = false;
    const file = selected;
    setLoadingPreview(true);
    void getDisplay(file)
      .then((buffer) => {
        if (cancelled) return;
        const packed = unpackPlane(buffer);
        const luts: LutSetting[] = packed.channels.map((channel, index) => {
          const chMeta = file.channels[index];
          const minPct = typeof chMeta?.min_pct === "number" ? chMeta.min_pct : 0;
          const maxPct = typeof chMeta?.max_pct === "number" ? chMeta.max_pct : 100;
          const span = Math.max(1, (channel.suggestedMax || 255) - (channel.suggestedMin || 0));
          const minVal = (channel.suggestedMin || 0) + (minPct / 100) * span;
          const maxVal = Math.max(minVal + 1, (channel.suggestedMin || 0) + (maxPct / 100) * span);
          return {
            min: minVal,
            max: maxVal,
            gamma: typeof chMeta?.lut_gamma === "number" && chMeta.lut_gamma > 0 ? chMeta.lut_gamma : 1,
            brightness: typeof chMeta?.brightness === "number" ? chMeta.brightness : 1,
            visible: chMeta?.visible ?? true,
            color: chMeta?.color ?? channel.color,
          };
        });
        const layers = createPreviewLayers(packed, luts);
        setLocalPreview({
          fileId: file.id,
          dimensions: {
            width: file.width && file.width > 0 ? file.width : packed.width,
            height: file.height && file.height > 0 ? file.height : packed.height,
          },
          layers,
          packed,
        });
      })
      .catch((err) => {
        // Still being prepared: keep the loading state; the file list refresh that reports
        // `prepare: "ready"` changes prepared_at and runs this effect again.
        if (isPending(err)) {
          pending = true;
          return;
        }
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          setError(detailMessage(err, lang));
        }
      })
      .finally(() => {
        if (!cancelled && !pending) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
    // channelsKey, not the channels array: a file-list refresh creates a new array even when
    // nothing changed, and re-decoding the preview on every poll is what made imports janky.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, channelsKey, selected?.height, selected?.id, selected?.prepared_at, selected?.prepare, selected?.width]);

  // Ordered files for keyboard navigation and neighbour prefetching
  const allOrdered = useMemo(() => orderedFiles(folders, files), [folders, files]);
  const order = useMemo(() => allOrdered.filter((f) => !isSlide(f)), [allOrdered]);

  useEffect(() => {
    if (!previewReady || !selectedId) return;
    const at = order.findIndex((f) => f.id === selectedId);
    if (at < 0) return;
    const handle = window.setTimeout(() => {
      prefetchPreviews(
        [order[at + 1], order[at + 2], order[at - 1]].filter((f): f is FileSummary => Boolean(f) && f.prepare === "ready"),
      );
    }, 120);
    return () => window.clearTimeout(handle);
  }, [order, previewReady, selectedId]);

  // Ctrl/⌘+X cut, Ctrl/⌘+V paste into the current folder, Esc clears the selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const app = useApp.getState();
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "x") {
        const items = currentSelection();
        if (!items.file_ids.length && !items.folders.length && app.selectedId) items.file_ids.push(app.selectedId);
        if (!items.file_ids.length && !items.folders.length) return;
        event.preventDefault();
        app.setClipboard(items);
      } else if (mod && event.key.toLowerCase() === "v" && app.clipboard) {
        event.preventDefault();
        const items = app.clipboard;
        app.setClipboard(null);
        void performMove(items, app.currentFolder);
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        if (app.clipboard) app.setClipboard(null);
        else app.clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ArrowUp / ArrowDown continuous file stepping
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) {
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (allOrdered.length === 0) return;
      event.preventDefault();
      const idx = allOrdered.findIndex((f) => f.id === selectedId);
      const nextIdx =
        event.key === "ArrowDown"
          ? idx < 0
            ? 0
            : Math.min(allOrdered.length - 1, idx + 1)
          : idx <= 0
            ? 0
            : idx - 1;
      const nextFile = allOrdered[nextIdx];
      if (nextFile && nextFile.id !== selectedId) {
        select(nextFile.id);
        setCurrentFolder(nextFile.folder);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allOrdered, select, selectedId, setCurrentFolder]);

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
      composite: cropping ? true : composite,
      // When cropping is active, the CropOverlay renders its own adaptive scale bar inside the crop box
      scaleBar: cropping ? false : scaleBar && selected.calibrated !== false,
      visible: channelVisible,
      umPerPixel: Number(selected.voxel_um?.[0] || 0),
      optics: selected,
    });
  }, [channelVisible, composite, cropping, localPreview, scaleBar, selected]);

  const selectedIds = files.filter((file) => checked[file.id]).map((file) => file.id);
  const pickedCount = selectedIds.length + Object.values(checkedFolders).filter(Boolean).length;
  const barButton =
    "inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-sm text-[var(--text)] transition-colors hover:bg-[var(--bg-elev)]";
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
      if (selected) {
        updateLockedChannels(selected.channels, next);
      }
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
      const picked = selectionFor({ folder: path });
      items.push(
        { key: "open-folder", label: t(lang, "openFolder"), icon: <FolderOpen size={15} />, onSelect: () => useApp.getState().openFolderView(path) },
        ...(path
          ? [
              { key: "cut", label: t(lang, "cut"), icon: <Scissors size={15} />, onSelect: () => useApp.getState().setClipboard(picked) },
              { key: "move", label: t(lang, "moveTo"), icon: <ArrowElbowDownRight size={15} />, onSelect: () => setMoveDialog(picked) },
            ]
          : []),
        ...(clipboard
          ? [
              {
                key: "paste",
                label: `${t(lang, "pasteHere")} (${clipboard.file_ids.length + clipboard.folders.length})`,
                icon: <ClipboardText size={15} />,
                onSelect: () => {
                  useApp.getState().setClipboard(null);
                  void performMove(clipboard, path);
                },
              },
            ]
          : []),
        { key: "organize", label: t(lang, "organizeByMag"), icon: <Binoculars size={15} />, disabled: count === 0, onSelect: () => setOrganizeFolder(path) },
        { key: "export", label: t(lang, "exportEllipsis"), icon: <ExportIcon size={15} />, separated: true, disabled: count === 0, onSelect: () => exportFolder(path) },
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
      if (mayRebuild && count > 0) {
        items.push({
          key: "rebuild",
          label: t(lang, "rebuildCache"),
          icon: <ArrowClockwise size={15} />,
          onSelect: () => void rebuild({ folders: [path] }, files.filter((f) => !path || f.folder === path || f.folder.startsWith(`${path}/`))),
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
      {
        key: "crop",
        label: t(lang, "cropTitle"),
        icon: <Crop size={15} />,
        onSelect: () => {
          select(file.id);
          window.setTimeout(() => startCropping(), 80);
        },
      },
      {
        key: "studio",
        label: exportChecked ? `${t(lang, "addToProject")} (${checkedFiles.length})` : t(lang, "addToProject"),
        icon: <SquaresFour size={15} />,
        onSelect: () => void handleOpenInStudio((exportChecked ? checkedFiles : [file]).map((f) => f.id)),
      },
      isSlide(file)
        ? { key: "slide", label: t(lang, "openSlide"), icon: <Stack size={15} />, onSelect: () => nav(`/slide/${file.id}`) }
        : { key: "advanced", label: t(lang, "openAdvanced"), icon: <SlidersHorizontal size={15} />, onSelect: () => nav(`/advanced/${file.id}`) },
      ...(file.cropped || file.edited
        ? [
            {
              key: "restore",
              label: t(lang, "restoreOriginal"),
              icon: <ArrowCounterClockwise size={15} />,
              onSelect: () => void handleRestoreOriginal(file.id),
            },
          ]
        : []),
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
      ...(mayRebuild
        ? [
            {
              key: "rebuild",
              label: exportChecked ? `${t(lang, "rebuildCache")} (${checkedFiles.length})` : t(lang, "rebuildCache"),
              icon: <ArrowClockwise size={15} />,
              disabled: !exportChecked && file.prepare === "pending",
              onSelect: () => {
                const list = exportChecked ? checkedFiles : [file];
                void rebuild({ file_ids: list.map((f) => f.id) }, list);
              },
            },
          ]
        : []),
      { key: "cut", label: t(lang, "cut"), icon: <Scissors size={15} />, separated: true, onSelect: () => useApp.getState().setClipboard(selectionFor({ file: file.id })) },
      { key: "move", label: t(lang, "moveTo"), icon: <ArrowElbowDownRight size={15} />, onSelect: () => setMoveDialog(selectionFor({ file: file.id })) },
      { key: "rename", label: t(lang, "rename"), icon: <PencilSimple size={15} />, onSelect: () => setNameAction({ mode: "renameFile", file }) },
      { key: "delete", label: t(lang, "delete"), icon: <Trash size={15} />, danger: true, onSelect: () => setDeleteAction({ type: "file", file }) },
    );
    setMenu({ x, y, title: joinPath(file.folder, file.name), items });
  }

  // A stable callback for the memoised tree (openMenu itself changes on every render).
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;
  const stableOpenMenu = useCallback((target: TreeTarget, x: number, y: number) => openMenuRef.current(target, x, y), []);

  async function rebuild(body: { file_ids?: string[]; folders?: string[] }, affected: FileSummary[]) {
    try {
      setError(null);
      forgetPreviews(affected.map((f) => f.id));
      await rebuildCache(body);
      await refreshFiles();
    } catch (err) {
      setError(detailMessage(err, lang));
    }
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
      const ext = nameAction.file.format === "lif" ? "" : fileExtension(nameAction.file.name) || ".nd2";
      const name = !ext || value.toLowerCase().endsWith(ext.toLowerCase()) ? value : `${value}${ext}`;
      await updateFile(nameAction.file.id, { name });
    }
    await refreshFiles();
  }

  async function submitDelete() {
    if (!deleteAction) return;
    if (deleteAction.type === "selection") {
      // Folders first (their files go with them), then loose files that are still there.
      for (const path of deleteAction.items.folders) await deleteFolder(path).catch(() => undefined);
      const remaining = new Set(useApp.getState().files.map((f) => f.id));
      for (const id of deleteAction.items.file_ids) if (remaining.has(id)) await deleteFile(id).catch(() => undefined);
      useApp.getState().clearSelection();
    } else if (deleteAction.type === "folder") {
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

  const umPerPx = Number(selected?.voxel_um?.[0] || slide?.um_per_px || 0);
  const newScaleBarUm = autoScaleUm(umPerPx, cropBox.w, selected ?? undefined)?.[0] ?? 0;

  // Shared Crop Control Bar rendered when cropping is active
  const cropToolbar = cropping && selected && (
    <div
      data-no-pan
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="fade-in absolute inset-x-3 top-14 z-30 mx-auto max-w-3xl"
    >
      <Glass tone="dark" shape="island" className="flex flex-col gap-2.5 p-3 text-xs text-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-sky-400/20 text-sky-300">
              <Crop size={14} weight="bold" />
            </span>
            <span className="font-semibold tracking-tight">{t(lang, "cropTitle")}</span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-2xs tabular-nums text-sky-200">
              {Math.round(cropBox.w)} × {Math.round(cropBox.h)} px
            </span>
            {newScaleBarUm > 0 && (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-2xs tabular-nums text-emerald-300">
                {t(lang, "cropNewScale")}: {formatUm(newScaleBarUm)}
              </span>
            )}
          </div>
          <span className="hidden text-xs text-white/50 sm:inline">{t(lang, "cropRegionInfo")}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-white/60">{t(lang, "cropRatio")}:</span>
          {ASPECT_PRESETS.map((preset) => {
            const active = aspectPreset === preset.key;
            const label =
              preset.key === "free"
                ? t(lang, "cropFree")
                : preset.key === "custom"
                  ? t(lang, "cropCustom")
                  : preset.label;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => setAspectPreset(preset.key)}
                aria-pressed={active}
                className={`cursor-pointer rounded-md px-2 py-1 font-mono text-xs transition-colors ${
                  active
                    ? "bg-sky-400 font-semibold text-slate-950 shadow-sm"
                    : "bg-white/8 text-white/75 hover:bg-white/15 hover:text-white"
                }`}
              >
                {label}
              </button>
            );
          })}

          {aspectPreset === "custom" && (
            <div className="ml-1 inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/40 px-1.5 py-0.5 font-mono text-xs">
              <input
                type="number"
                min={0.1}
                step="any"
                value={customRatioW}
                onChange={(e) => setCustomRatioW(Math.max(0.1, Number(e.target.value) || 1))}
                aria-label={t(lang, "cropWidthRatio")}
                className="w-11 bg-transparent text-center text-white focus:outline-none"
              />
              <span className="text-white/40">:</span>
              <input
                type="number"
                min={0.1}
                step="any"
                value={customRatioH}
                onChange={(e) => setCustomRatioH(Math.max(0.1, Number(e.target.value) || 1))}
                aria-label={t(lang, "cropHeightRatio")}
                className="w-11 bg-transparent text-center text-white focus:outline-none"
              />
            </div>
          )}

          <span className="mx-1 h-4 w-px bg-white/15" aria-hidden />
          <button
            type="button"
            disabled={detectingNucleus}
            onClick={() => void handleDetectNucleus()}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-emerald-400/20 px-2.5 py-1 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-400/30 disabled:opacity-50"
            title={t(lang, "autoNucleusCenter")}
          >
            <Crosshair size={13} weight="bold" />
            {detectingNucleus ? t(lang, "applyingChanges") : t(lang, "autoNucleusCenter")}
          </button>

          {nucleiResult && nucleiResult.nuclei.length > 0 && (
            <div className="inline-flex items-center gap-1">
              {nucleiResult.nuclei.slice(0, 6).map((nuc) => {
                const isTarget = nuc.id === activeNucleusId;
                return (
                  <button
                    key={nuc.id}
                    type="button"
                    onClick={() => handleSelectNucleus(nuc.id)}
                    className={`cursor-pointer rounded px-1.5 py-0.5 font-mono text-2xs transition-colors ${
                      isTarget
                        ? "bg-emerald-400 font-bold text-slate-950"
                        : "bg-white/10 text-emerald-200 hover:bg-white/20"
                    }`}
                  >
                    #{nuc.id}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
          <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-white/12 bg-black/35 px-2.5 py-1">
            <span className="shrink-0 text-xs text-white/55">{t(lang, "fileName")}</span>
            <input
              type="text"
              value={cropName}
              onChange={(e) => setCropName(e.target.value)}
              placeholder={`${selected.name.replace(/\.[^.]+$/, "")}_crop_${Math.round(cropBox.w)}x${Math.round(cropBox.h)}`}
              aria-label={t(lang, "cropNamePlaceholder")}
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-white placeholder:text-white/30 focus:outline-none"
            />
          </label>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={resetCropBox}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-white/8 px-2.5 text-xs text-white/75 transition-colors hover:bg-white/15 hover:text-white"
            >
              <ArrowCounterClockwise size={13} />
              {t(lang, "cropReset")}
            </button>
            <button
              type="button"
              onClick={() => setCropping(false)}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-white/8 px-2.5 text-xs text-white/75 transition-colors hover:bg-white/15 hover:text-white"
            >
              <X size={13} />
              {t(lang, "cropCancel")}
            </button>
            <button
              type="button"
              disabled={croppingBusy}
              onClick={() => void handleCreateCrop("inplace")}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-emerald-400/20 px-2.5 text-xs font-semibold text-emerald-200 transition-all hover:bg-emerald-400/30 disabled:opacity-50"
            >
              <Check size={13} weight="bold" />
              {croppingBusy ? t(lang, "applyingChanges") : t(lang, "applyInplace")}
            </button>
            <button
              type="button"
              disabled={croppingBusy}
              onClick={() => void handleCreateCrop("new")}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-sky-400 px-3 text-xs font-semibold text-slate-950 shadow-sm transition-all hover:bg-sky-300 disabled:opacity-50"
            >
              <Sparkle size={13} weight="fill" />
              {croppingBusy ? t(lang, "cropCreating") : t(lang, "cropSaveNew")}
            </button>
          </div>
        </div>
      </Glass>
    </div>
  );

  return (
    <Shell dense>
      <div
        className="grid min-h-[calc(100dvh-3.35rem)] grid-cols-1 lg:h-[calc(100dvh-3.35rem)] lg:min-h-0 lg:grid-cols-[var(--tree-w)_minmax(0,1fr)_350px]"
        style={{ "--tree-w": `${treeWidth}px` } as React.CSSProperties}
      >
        {/* Left Pane: File Tree */}
        <Glass as="aside" shape="panel" className="relative flex min-h-0 flex-col overflow-visible border-b lg:border-b-0 lg:border-r">
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
          {pickedCount > 0 && (
            <div className="flex flex-wrap items-center gap-1 border-b border-[var(--line)] bg-[var(--accent-soft)] px-2 py-1.5 text-sm">
              <span className="mr-auto px-1 font-medium text-[var(--accent)]">
                {t(lang, "selectedItems")} {pickedCount} {t(lang, "items")}
              </span>
              <button type="button" onClick={() => setMoveDialog(currentSelection())} className={barButton} title={t(lang, "moveTo")}>
                <ArrowElbowDownRight size={15} className="shrink-0" />
                {t(lang, "moveTo")}
              </button>
              {selectedIds.length > 0 && (
                <button type="button" onClick={(event) => openProjectPicker(event, selectedIds)} className={barButton} title={t(lang, "addToProject")}>
                  <SquaresFour size={15} className="shrink-0" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const sel = currentSelection();
                  setExportTarget({ fileIds: sel.file_ids, folders: sel.folders, label: `${pickedCount} ${t(lang, "items")}` });
                }}
                className={barButton}
                title={t(lang, "exportSelected")}
              >
                <ExportIcon size={15} className="shrink-0" />
              </button>
              <button type="button" onClick={() => setDeleteAction({ type: "selection", items: currentSelection() })} className={`${barButton} text-[var(--danger)]`} title={t(lang, "deleteSelected")}>
                <Trash size={15} className="shrink-0" />
              </button>
              <button type="button" onClick={() => useApp.getState().clearSelection()} className={barButton} title={t(lang, "clearSelection")}>
                <X size={14} className="shrink-0" />
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm text-[var(--text-dim)]">
            <span className="inline-flex items-center gap-2 font-medium text-[var(--text)]">
              {t(lang, "files")}
              <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-2xs font-semibold text-[var(--accent)]">
                {files.length}
              </span>
            </span>
            <span className="flex items-center gap-0.5">
              {(selectedIds.length > 0 || selected) && (
                <button
                  type="button"
                  onClick={() => void handleOpenInStudio(selectedIds.length > 0 ? selectedIds : selected ? [selected.id] : [])}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-1 text-xs font-medium text-[var(--accent)] transition-colors hover:opacity-90"
                  title={t(lang, "addToProject")}
                >
                  <SquaresFour size={13} weight="duotone" />
                  {t(lang, "studio")}
                  {selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
                </button>
              )}
              {files.length > 0 && (
                <button
                  type="button"
                  onClick={() => checkAll(!allChecked)}
                  className="rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
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

          {error && (
            <p role="alert" className="mx-3 mb-2 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-2.5 py-1.5 text-sm leading-5 text-[var(--danger)]">
              {error}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-auto border-t border-[var(--line)] max-lg:max-h-[70dvh]">
            <FileTree onMenu={stableOpenMenu} />
            {files.length === 0 && (
              <p className="mx-3 my-4 rounded-xl border border-dashed border-[var(--line)] px-4 py-8 text-center text-sm leading-5 text-[var(--text-dim)]">
                <FileIcon size={24} weight="duotone" className="mx-auto mb-2 text-[var(--accent)]" />
                {t(lang, "emptyFiles")}
              </p>
            )}
          </div>
          <p className="border-t border-[var(--line)] px-3 py-2 text-xs leading-4 text-[var(--text-dim)]">
            {clipboard ? `${t(lang, "cut")}: ${clipboard.file_ids.length + clipboard.folders.length} ${t(lang, "items")} · Ctrl/⌘+V` : t(lang, "dragHint")}
          </p>
        </Glass>

        {/* Center Pane: Optical Viewport */}
        <main className="relative min-h-[450px] bg-[var(--well)]">
          {cropToast && (
            <div className="fade-in absolute right-3 top-14 z-30 flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-slate-950/90 px-3 py-2 text-sm text-emerald-200 shadow-xl backdrop-blur">
              <CheckCircle size={16} weight="fill" className="shrink-0 text-emerald-400" />
              <span>
                {t(lang, "cropSuccess")}: <strong className="font-mono text-white">{cropToast.name}</strong>
              </span>
              <button
                type="button"
                onClick={() => {
                  select(cropToast.id);
                  setTab("export");
                  setCropToast(null);
                }}
                className="ml-1 rounded-md bg-emerald-400/20 px-2 py-0.5 text-xs font-medium text-emerald-200 hover:bg-emerald-400/30"
              >
                {t(lang, "export")}
              </button>
              <button
                type="button"
                onClick={() => setCropToast(null)}
                className="text-white/50 hover:text-white"
                aria-label={t(lang, "close")}
              >
                <X size={13} />
              </button>
            </div>
          )}

          {folderView !== null ? (
            <FolderView path={folderView} onMenu={stableOpenMenu} />
          ) : selected && selectedIsSlide ? (
            <div className="flex h-full min-h-[450px] flex-col">
              <div className="flex min-h-10 items-center gap-1.5 border-b border-white/[0.07] bg-black/30 px-3 text-xs text-white/65">
                <SlideZoomControls viewer={slideViewer} view={slideReady ? slideView : null} />
                <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
                <button
                  type="button"
                  onClick={() => (cropping ? setCropping(false) : startCropping())}
                  aria-pressed={cropping}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                    cropping ? "bg-sky-400 text-slate-950 shadow-sm" : "text-white/75 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <Crop size={14} weight="bold" />
                  {t(lang, "cropTool")}
                </button>
                <button
                  type="button"
                  onClick={() => nav(`/slide/${selected.id}`)}
                  className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Stack size={14} /> {t(lang, "openSlide")}
                </button>
              </div>
              {slideReady && slide && slideDisplay.length === slide.channels.length ? (
                <SlideStage
                  info={slide}
                  display={slideDisplay}
                  scaleBar={scaleBar}
                  tool={cropping ? "select" : "pan"}
                  selection={cropping ? (cropBox as Rect) : null}
                  onSelection={(rect) => {
                    if (!rect) return;
                    const nextBox: CropBox = {
                      x: Math.round(rect.x),
                      y: Math.round(rect.y),
                      w: Math.max(8, Math.round(rect.w)),
                      h: Math.max(8, Math.round(rect.h)),
                    };
                    setCropBox(
                      activeAspectRatio
                        ? fitCropToAspect(nextBox, slide.width, slide.height, activeAspectRatio)
                        : nextBox,
                    );
                  }}
                  onViewer={setSlideViewer}
                  onView={setSlideView}
                >
                  <Glass tone="dark" shape="chip" className="absolute left-3 top-3 z-20 flex gap-1 overflow-visible p-1">
                    <button
                      type="button"
                      onClick={() => setScaleBar((value) => !value)}
                      aria-pressed={scaleBar}
                      className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        scaleBar ? "bg-sky-400 text-slate-950 shadow-sm" : "text-white/70 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {t(lang, "scaleBar")}
                    </button>
                  </Glass>
                  {cropToolbar}
                  {selected.channels.length > 0 && (
                    <Glass tone="dark" shape="chip" className="absolute bottom-3 left-3 z-20 max-w-[min(100%-10rem,34rem)] overflow-visible p-1">
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
              mediaOverlay={
                cropping && previewReady && imageDimensions.width > 0 && imageDimensions.height > 0 ? (
                  <CropOverlay
                    imageWidth={imageDimensions.width}
                    imageHeight={imageDimensions.height}
                    umPerPixel={umPerPx}
                    optics={selected ?? undefined}
                    crop={cropBox}
                    aspectRatio={activeAspectRatio}
                    scaleBar={scaleBar}
                    nuclei={nucleiResult?.nuclei}
                    activeNucleusId={activeNucleusId}
                    onSelectNucleus={(nuc) => handleSelectNucleus(nuc.id)}
                    onChange={setCropBox}
                  />
                ) : null
              }
            >
              <Glass tone="dark" shape="chip" className="absolute left-3 top-3 z-20 flex flex-wrap items-center gap-1 overflow-visible p-1">
                {(
                  [
                    ["overlay", composite, () => setComposite(true)],
                    [
                      "split",
                      !composite,
                      () => {
                        setCropping(false);
                        setComposite(false);
                      },
                    ],
                    ["scaleBar", scaleBar, () => setScaleBar((value) => !value)],
                  ] as const
                ).map(([key, active, action]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={action}
                    aria-pressed={active}
                    className={`cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      active ? "bg-white text-slate-950 shadow-sm" : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    {t(lang, key)}
                  </button>
                ))}
                {selected && previewReady && (
                  <>
                    <span className="mx-0.5 h-4 w-px bg-white/15" aria-hidden />
                    <button
                      type="button"
                      onClick={() => (cropping ? setCropping(false) : startCropping())}
                      aria-pressed={cropping}
                      className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        cropping
                          ? "bg-sky-400 text-slate-950 shadow-sm"
                          : "text-sky-300 hover:bg-sky-400/15 hover:text-sky-200"
                      }`}
                      title={t(lang, "cropTitle")}
                    >
                      <Crop size={13} weight="bold" />
                      {t(lang, "cropTool")}
                    </button>
                  </>
                )}
              </Glass>

              {cropToolbar}

              {selected && selected.channels.length > 0 && (
                <Glass tone="dark" shape="chip" className="absolute bottom-3 left-3 z-20 max-w-[min(100%-1.5rem,36rem)] overflow-visible p-1">
                  <ChannelToggles channels={selected.channels} visible={channelVisible} onToggle={toggleChannel} />
                </Glass>
              )}
            </ZoomStage>
          )}
        </main>

        {/* Right Pane: Inspector & Export */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-t lg:border-l lg:border-t-0">
          <div className="flex gap-1 border-b border-[var(--line)] p-2 text-sm" role="tablist">
            {WORKSPACE_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-lg px-2 py-1.5 font-medium transition-colors ${
                  tab === key
                    ? "bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_28%,transparent)]"
                    : "text-[var(--text-dim)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
                }`}
              >
                {t(lang, label)}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selected && (
              <div className="flex min-h-48 flex-col items-center justify-center text-center text-base leading-5 text-[var(--text-dim)]">
                <FileIcon size={26} weight="duotone" className="mb-3 text-[var(--accent)]" />
                <p className="max-w-[27ch]">{t(lang, "noneSelected")}</p>
              </div>
            )}

            {selected && (
              <div>
                {tab === "identify" && (
                  <>
                    {/* Header Summary Card */}
                    <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--bg)]/60 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="truncate text-base font-semibold tracking-tight text-[var(--text)]" title={selected.name}>
                          {selected.name}
                        </h2>
                        <div className="flex shrink-0 items-center gap-1">
                          {selected.edited && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-2xs font-medium text-amber-500">
                              <SlidersHorizontal size={11} weight="bold" />
                              {t(lang, "editedBadge")}
                            </span>
                          )}
                          {selected.cropped && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-2xs font-medium text-[var(--accent)]">
                              <Crop size={11} weight="bold" />
                              {t(lang, "croppedBadge")}
                              {selected.crop?.ratio_label ? ` ${selected.crop.ratio_label}` : ""}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 font-mono text-xs tabular-nums text-[var(--text-dim)]">
                        {selected.width ?? "–"} × {selected.height ?? "–"} px
                        {selected.voxel_um?.[0]
                          ? ` · ${formatUm((selected.width ?? 0) * selected.voxel_um[0])} × ${formatUm((selected.height ?? 0) * selected.voxel_um[0])}`
                          : ""}
                      </p>
                    </div>

                    {/* Channels Card with Lock */}
                    <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--bg)]/40 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-semibold text-[var(--text-dim)]">{t(lang, "channels")}</span>
                        {channelLocked && (
                          <span className="inline-flex items-center gap-1 font-mono text-2xs text-amber-500">
                            <LockSimple size={11} weight="fill" />
                            {t(lang, "channelsLocked")}
                          </span>
                        )}
                      </div>
                      <ChannelToggles
                        variant="list"
                        channels={selected.channels}
                        visible={channelVisible}
                        onToggle={toggleChannel}
                      />
                    </div>

                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--bg)]/30 p-3 text-sm">
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
                      ) : selected.format === "ome-tiff" || selected.format === "tiff" ? (
                        <>
                          <dt className="text-[var(--text-dim)]">{t(lang, "format")}</dt>
                          <dd className="font-mono tabular-nums">{selected.format === "tiff" ? "TIFF" : "OME-TIFF"}</dd>
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
                      <dt className="text-[var(--text-dim)]">{t(lang, "objective")}</dt>
                      <dd>
                        {selected.objective ?? "–"}
                        {selected.na ? ` · NA ${selected.na}` : ""}
                        {selected.zoom && Math.abs(selected.zoom - 1) > 0.05 ? ` · zoom ${Number(selected.zoom.toFixed(2))}×` : ""}
                      </dd>
                      <dt className="text-[var(--text-dim)]">{t(lang, "voxel")}</dt>
                      <dd className="font-mono tabular-nums">
                        {selected.calibrated === false ? t(lang, "uncalibrated") : `${formatUm(selected.voxel_um?.[0])}/px`}
                      </dd>
                      <dt className="text-[var(--text-dim)]">{t(lang, "scaleBar")}</dt>
                      <dd className="font-mono tabular-nums">
                        {(() => {
                          const bar = selected.calibrated === false ? null : autoScaleUm(Number(selected.voxel_um?.[0] || 0), Number(selected.width || 0), selected);
                          if (!bar) return "–";
                          return `${bar[0]} µm ${t(lang, selected.magnification ? "scaleBarAutoMag" : "scaleBarAutoWidth")}`;
                        })()}
                      </dd>
                      <dt className="text-[var(--text-dim)]">{t(lang, "instrument")}</dt>
                      <dd>{selected.instrument ?? "–"}</dd>
                      <dt className="text-[var(--text-dim)]">{t(lang, "software")}</dt>
                      <dd>{selected.software ?? "–"}</dd>
                      <dt className="text-[var(--text-dim)]">{t(lang, "acquired")}</dt>
                      <dd className="font-mono text-xs tabular-nums">{selected.acquired ?? "–"}</dd>
                    </dl>

                    <div className="mt-5 grid gap-2">
                      {isSlide(selected) ? (
                        <button type="button" onClick={() => nav(`/slide/${selected.id}`)} className="primary-action w-full min-h-10 px-3">
                          <Stack size={18} className="shrink-0" />
                          {t(lang, "openSlide")}
                        </button>
                      ) : (
                        <button type="button" onClick={() => nav(`/advanced/${selected.id}`)} className="primary-action w-full min-h-10 px-3">
                          <SlidersHorizontal size={18} className="shrink-0" />
                          {t(lang, "openAdvanced")}
                        </button>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => (cropping ? setCropping(false) : startCropping())}
                          className={secondaryAction}
                        >
                          <Crop size={16} weight="bold" className="shrink-0" />
                          <span className="truncate">{t(lang, "cropTool")}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(event) => openProjectPicker(event, selectedIds.length > 0 ? selectedIds : [selected.id])}
                          className={secondaryAction}
                          title={t(lang, "addToProject")}
                          aria-haspopup="menu"
                        >
                          <SquaresFour size={16} weight="duotone" className="shrink-0" />
                          <span className="truncate">{t(lang, "studio")}</span>
                        </button>
                      </div>
                      {(selected.cropped || selected.edited) && (
                        <button
                          type="button"
                          disabled={restoring}
                          onClick={() => void handleRestoreOriginal(selected.id)}
                          className={`${secondaryAction} text-[var(--text-dim)] disabled:opacity-50`}
                          title={t(lang, "restoreOriginal")}
                        >
                          <ArrowCounterClockwise size={16} className="shrink-0" />
                          <span className="truncate">{t(lang, "restoreOriginal")}</span>
                        </button>
                      )}
                      {pendingDelete !== selected.id && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => setPendingDelete(selected.id)}
                            className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 text-sm text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]"
                          >
                            <Trash size={16} className="shrink-0" />
                            {t(lang, "delete")}
                          </button>
                        </div>
                      )}
                    </div>

                    {pendingDelete === selected.id && (
                      <div className="mt-4 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--danger)_28%,var(--line))] bg-[color-mix(in_srgb,var(--danger)_6%,var(--bg))] p-3">
                        <p className="text-sm leading-5 text-[var(--text-dim)]">{t(lang, "deleteHint")}</p>
                        <div className="mt-3 flex gap-2">
                          <button type="button" onClick={() => void confirmDelete()} className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--danger)] px-3 text-xs font-medium text-white">
                            <Check size={13} /> {t(lang, "confirmDelete")}
                          </button>
                          <button type="button" onClick={() => setPendingDelete(null)} className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs text-[var(--text-dim)] hover:bg-[var(--bg)]">
                            <X size={13} /> {t(lang, "cancel")}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {tab === "metadata" && (
                  <div className="flex flex-col gap-3">
                    {loadingDetail && <p className="text-sm text-[var(--text-dim)]">{t(lang, "loadingFile")}</p>}
                    {!loadingDetail && detail && (
                      <>
                        <label className="relative block">
                          <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
                          <input
                            value={q}
                            onChange={(event) => setQ(event.target.value)}
                            placeholder={t(lang, "searchMeta")}
                            className="h-9 w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] pl-9 pr-3 text-sm transition-colors focus:border-[var(--accent)] focus:outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(metaBlob);
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1200);
                          }}
                          className="inline-flex min-h-8 items-center gap-1.5 self-start rounded-lg px-2 text-sm text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                        >
                          {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
                          {copied ? t(lang, "copied") : t(lang, "copyJson")}
                        </button>

                        {filteredText.map((row) => (
                          <section key={row.k}>
                            <h3 className="text-xs font-semibold text-[var(--text-dim)]">{row.k}</h3>
                            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--line)] bg-[var(--bg)] p-2.5 font-mono text-2xs leading-relaxed">
                              {row.v}
                            </pre>
                          </section>
                        ))}
                        {detail.events?.length ? (
                          <section>
                            <h3 className="text-xs font-semibold text-[var(--text-dim)]">{t(lang, "events")}</h3>
                            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--line)] bg-[var(--bg)] p-2.5 font-mono text-2xs leading-relaxed">
                              {JSON.stringify(detail.events, null, 2)}
                            </pre>
                          </section>
                        ) : null}
                        {filteredText.length === 0 && !detail.events?.length && (
                          <p className="py-6 text-center text-sm text-[var(--text-dim)]">
                            {t(lang, q ? "noSearchResults" : "noMetadata")}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {tab === "export" && (
                  <>
                    <p className="mb-3 truncate font-mono text-xs text-[var(--text-dim)]" title={exportIds.length === 1 ? joinPath(selected.folder, selected.name) : undefined}>
                      {selectedIds.length
                        ? `${t(lang, "checkedCount")} ${selectedIds.length} ${t(lang, "nFiles")}`
                        : joinPath(selected.folder, selected.name)}
                    </p>
                    {exportIds.length > 0 ? (
                      <ExportPanel fileIds={exportIds} visible={channelVisible} />
                    ) : (
                      <div className="flex flex-col gap-3">
                        <Guide title="export" body="slideExportHint" />
                        {isSlide(selected) && (
                          <button type="button" onClick={() => nav(`/slide/${selected.id}`)} className="primary-action min-h-9 self-start px-4 text-sm">
                            {t(lang, "openSlide")}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {selected && (
            <p className="border-t border-[var(--line)] px-4 py-2 font-mono text-2xs text-[var(--text-dim)] tabular-nums">
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
              <span className="block truncate font-mono text-xs text-[var(--text)]">/{exportTarget.label}</span>
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
            visible={channelVisible}
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
        title={t(lang, deleteAction?.type === "folder" ? "deleteFolder" : deleteAction?.type === "selection" ? "deleteSelected" : "delete")}
        body={
          deleteAction?.type === "selection" ? (
            <>
              <span className="mb-1 block font-mono text-xs text-[var(--text)]">
                {deleteAction.items.file_ids.length} {t(lang, "nFiles")} · {deleteAction.items.folders.length} {t(lang, "subfolders")}
              </span>
              {t(lang, "deleteSelectedHint")}
            </>
          ) : deleteAction && (
            <>
              <span className="mb-1 block truncate font-mono text-xs text-[var(--text)]">
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
      {moveDialog && <MoveDialog items={moveDialog} onClose={() => setMoveDialog(null)} />}
      <OrganizeDialog folder={organizeFolder} onClose={() => setOrganizeFolder(null)} />
      <MoveToast />
    </Shell>
  );
}
