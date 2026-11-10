import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowCounterClockwise,
  Check,
  CheckCircle,
  CirclesFour,
  Crosshair,
  Crop,
  Export as ExportIcon,
  Eye,
  EyeSlash,
  FolderOpen,
  GearSix,
  LockSimple,
  LockSimpleOpen,
  Plus,
  SlidersHorizontal,
  Sparkle,
  SquaresFour,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  CropOverlay,
  centerCropBoxAt,
  defaultCropBox,
  fitCropToAspect,
  type CropBox,
} from "../components/CropOverlay";
import { ExportPanel } from "../components/ExportPanel";
import { Glass } from "../components/Glass";
import { ConfirmDialog, Modal, NameDialog } from "../components/Modal";
import { Shell } from "../components/Shell";
import { t } from "../i18n";
import {
  batchApply,
  createProject,
  deleteProject,
  listProjects,
  resetFile,
  updateProject,
} from "../lib/api";
import { detailMessage, formatUm, isSlide, joinPath } from "../lib/format";
import {
  DEFAULT_NUCLEUS_PARAMS,
  identifyNucleusChannel,
  segmentNucleiFromPacked,
} from "../lib/nucleus";
import {
  createPreviewLayers,
  drawCroppedPreview,
  drawPreview,
  niceScaleUm,
  unpackPlane,
  type PreviewLayer,
} from "../lib/plane";
import { forget as forgetPreviews, getDisplay } from "../lib/previewCache";
import type {
  ChannelEdit,
  FileSummary,
  LutSetting,
  NucleusParams,
  NucleusResult,
  NucleusRoi,
  PackedPlane,
  ProjectInfo,
  ThresholdMethod,
} from "../lib/types";
import { useApp } from "../store";

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

const THRESHOLD_METHODS: ThresholdMethod[] = [
  "Otsu",
  "Li",
  "Triangle",
  "Huang",
  "IsoData",
  "Mean",
  "Moments",
];

const COLOR_SWATCHES: { name: string; rgb: [number, number, number] }[] = [
  { name: "Blue", rgb: [64, 156, 255] },
  { name: "Cyan", rgb: [0, 230, 255] },
  { name: "Green", rgb: [50, 235, 100] },
  { name: "Yellow", rgb: [255, 220, 40] },
  { name: "Red", rgb: [255, 68, 68] },
  { name: "Magenta", rgb: [245, 70, 230] },
  { name: "White", rgb: [245, 248, 252] },
];

export interface ChannelAdjustment {
  index: number;
  name: string;
  color: number[];
  visible: boolean;
  /** 0.0 .. 2.0 (1.0 = 100% default) */
  brightness: number;
  /** 0 .. 95 (% of display range) */
  min_pct: number;
  /** 5 .. 100 (% of display range) */
  max_pct: number;
  /** 0.2 .. 3.0 */
  gamma: number;
}

function defaultAdjustmentsFromFile(file: FileSummary | undefined): ChannelAdjustment[] {
  if (!file || !file.channels.length) return [];
  return file.channels.map((ch, idx) => ({
    index: idx,
    name: ch.name || `Channel ${idx + 1}`,
    color: ch.color?.length >= 3 ? [...ch.color] : [255, 255, 255],
    visible: ch.visible ?? true,
    brightness: ch.brightness !== undefined ? Number(ch.brightness) : 1.0,
    min_pct: ch.min_pct !== undefined ? Number(ch.min_pct) : 0,
    max_pct: ch.max_pct !== undefined ? Number(ch.max_pct) : 100,
    gamma: ch.lut_gamma && ch.lut_gamma > 0 ? Number(ch.lut_gamma) : 1.0,
  }));
}

function adjustmentsToChannelEdits(adjs: ChannelAdjustment[]): ChannelEdit[] {
  return adjs.map((a) => ({
    index: a.index,
    name: a.name,
    brightness: Number(a.brightness.toFixed(3)),
    min_pct: Number(a.min_pct.toFixed(1)),
    max_pct: Number(a.max_pct.toFixed(1)),
    gamma: Number(a.gamma.toFixed(2)),
    visible: a.visible,
    color: a.color,
  }));
}

interface StudioCardCanvasProps {
  file: FileSummary;
  packed: PackedPlane | undefined;
  adjustments: ChannelAdjustment[];
  crop: CropBox;
  aspectRatio: number | null;
  viewMode: "box" | "cropped";
  scaleBar: boolean;
  nucleiResult: NucleusResult | undefined;
  activeNucleusId: number | null;
  selected: boolean;
  hasOverride: boolean;
  onSelect: () => void;
  onCropChange: (next: CropBox) => void;
  onSelectNucleus: (nuc: NucleusRoi) => void;
  onAutoNucleusSingle: () => void;
  onResetOriginal?: () => void;
}

function StudioImageCard({
  file,
  packed,
  adjustments,
  crop,
  aspectRatio,
  viewMode,
  scaleBar,
  nucleiResult,
  activeNucleusId,
  selected,
  hasOverride,
  onSelect,
  onCropChange,
  onSelectNucleus,
  onAutoNucleusSingle,
  onResetOriginal,
}: StudioCardCanvasProps) {
  const lang = useApp((s) => s.lang);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const imgW = Math.max(file.width ?? 0, packed?.width ?? 0, 2);
  const imgH = Math.max(file.height ?? 0, packed?.height ?? 0, 2);
  const umPerPx = Number(file.voxel_um?.[0] || 0);

  const { layers, visible } = useMemo<{ layers: PreviewLayer[]; visible: boolean[] }>(() => {
    if (!packed) return { layers: [], visible: [] };
    const luts: LutSetting[] = packed.channels.map((ch, idx) => {
      const adj = adjustments[idx];
      const baseColor = adj?.color ?? file.channels[idx]?.color ?? ch.color;
      const minPct = adj?.min_pct ?? 0;
      const maxPct = adj?.max_pct ?? 100;
      const span = Math.max(1, (ch.suggestedMax || 255) - (ch.suggestedMin || 0));
      const minVal = (ch.suggestedMin || 0) + (minPct / 100) * span;
      const maxVal = Math.max(minVal + 1, (ch.suggestedMin || 0) + (maxPct / 100) * span);
      return {
        min: minVal,
        max: maxVal,
        gamma: adj?.gamma ?? 1,
        brightness: adj?.brightness ?? 1,
        visible: adj?.visible ?? true,
        color: baseColor,
      };
    });
    return {
      layers: createPreviewLayers(packed, luts),
      visible: luts.map((l) => l.visible),
    };
  }, [adjustments, file.channels, packed]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !packed || !layers.length) return;
    const dims = { width: imgW, height: imgH };
    if (viewMode === "cropped") {
      drawCroppedPreview(canvas, dims, layers, crop, {
        scaleBar,
        visible,
        umPerPixel: umPerPx,
      });
    } else {
      drawPreview(canvas, dims, layers, {
        composite: true,
        scaleBar: false,
        visible,
        umPerPixel: umPerPx,
      });
    }
  }, [crop, imgH, imgW, layers, packed, scaleBar, umPerPx, viewMode, visible]);

  const [newScaleUm] = umPerPx > 0 && crop.w > 0 ? niceScaleUm(umPerPx, crop.w) : [0, 0];
  const nuclei = nucleiResult?.nuclei ?? [];

  return (
    <div
      onClick={onSelect}
      className={`group flex flex-col overflow-hidden rounded-2xl border transition-all ${
        selected
          ? "border-sky-400 bg-slate-900/90 shadow-[0_0_0_1px_rgba(56,189,248,0.4),0_12px_32px_-8px_rgba(2,132,199,0.28)]"
          : "border-white/10 bg-slate-950/75 hover:border-white/25"
      }`}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between gap-2 border-b border-white/8 bg-black/35 px-3 py-2 text-[11.5px]">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              selected ? "bg-sky-400 shadow-[0_0_8px_#38bdf8]" : "bg-white/25"
            }`}
          />
          <span className="truncate font-medium text-white" title={file.name}>
            {file.name}
          </span>
          {file.cropped && (
            <span className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-sky-300">
              {t(lang, "croppedBadge")}
            </span>
          )}
          {file.edited && !file.cropped && (
            <span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-emerald-300">
              {t(lang, "editedBadge")}
            </span>
          )}
          {hasOverride && (
            <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-amber-300">
              {t(lang, "individualOverride")}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAutoNucleusSingle();
            }}
            title={t(lang, "autoNucleusCenter")}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-amber-400/15 px-2 font-mono text-[10px] font-medium text-amber-300 transition-colors hover:bg-amber-400/25"
          >
            <Crosshair size={12} weight="bold" />
            {nuclei.length > 0 ? `${nuclei.length}` : t(lang, "auto")}
          </button>
          {(file.edited || file.cropped) && onResetOriginal && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onResetOriginal();
              }}
              title={t(lang, "restoreOriginal")}
              className="inline-flex h-6 items-center gap-1 rounded-md bg-white/8 px-1.5 text-[10px] text-white/70 transition-colors hover:bg-white/15 hover:text-white"
            >
              <ArrowCounterClockwise size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Viewport */}
      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-[#05070b] p-2">
        {!packed ? (
          <div className="flex items-center gap-2 font-mono text-[11px] text-white/50">
            <span className="spinner h-3.5 w-3.5 border-white/25 border-t-sky-400" />
            {t(lang, "previewLoading")}
          </div>
        ) : (
          <div
            className="relative inline-flex max-h-full max-w-full items-center justify-center"
            style={{
              aspectRatio:
                viewMode === "cropped" ? `${Math.max(1, crop.w)} / ${Math.max(1, crop.h)}` : `${imgW} / ${imgH}`,
            }}
          >
            <canvas
              ref={canvasRef}
              className="block max-h-full max-w-full rounded-sm object-contain shadow-lg"
            />
            {viewMode === "box" && (
              <CropOverlay
                imageWidth={imgW}
                imageHeight={imgH}
                umPerPixel={umPerPx}
                crop={crop}
                aspectRatio={aspectRatio}
                scaleBar={scaleBar}
                nuclei={nuclei}
                activeNucleusId={activeNucleusId}
                onSelectNucleus={onSelectNucleus}
                compact
                onChange={onCropChange}
              />
            )}
          </div>
        )}
      </div>

      {/* Card Footer: Crop & Scale Readout + Nucleus Switcher Pills */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-white/8 bg-black/40 px-3 py-2 font-mono text-[10px] text-white/70">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sky-300">
            {crop.w}×{crop.h}px
          </span>
          {umPerPx > 0 && (
            <span className="text-white/50">
              ({formatUm(crop.w * umPerPx)}×{formatUm(crop.h * umPerPx)})
            </span>
          )}
          {newScaleUm > 0 && (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] text-emerald-300">
              {t(lang, "scaleBar")}: {formatUm(newScaleUm)}
            </span>
          )}
        </div>

        {nuclei.length > 0 && (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {nuclei.slice(0, 5).map((nuc) => {
              const active = activeNucleusId === nuc.id;
              return (
                <button
                  key={nuc.id}
                  type="button"
                  onClick={() => onSelectNucleus(nuc)}
                  title={`${nuc.area_um2} µm² · circ ${nuc.circularity}`}
                  className={`cursor-pointer rounded px-1.5 py-0.5 text-[9.5px] font-semibold transition-colors ${
                    active
                      ? "bg-amber-400 text-slate-950"
                      : "bg-white/8 text-white/70 hover:bg-white/15 hover:text-white"
                  }`}
                >
                  #{nuc.id}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function Studio() {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const { projectId } = useParams<{ projectId?: string }>();
  const nav = useNavigate();

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(projectId ?? null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Dialogs
  const [newProjectModal, setNewProjectModal] = useState(false);
  const [renameProjectTarget, setRenameProjectTarget] = useState<ProjectInfo | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ProjectInfo | null>(null);
  const [addImagesModal, setAddImagesModal] = useState(false);
  const [pickerChecked, setPickerChecked] = useState<Record<string, boolean>>({});
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Loaded PackedPlanes per fileId
  const [planesByFile, setPlanesByFile] = useState<Record<string, PackedPlane>>({});

  // Studio Editing State
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"box" | "cropped">("box");
  const [gridCols, setGridCols] = useState<1 | 2 | 3 | 4>(2);
  const [scaleBar, setScaleBar] = useState(true);

  // Crop & Aspect Ratio State
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>("1:1");
  const [customRatioW, setCustomRatioW] = useState<number>(1);
  const [customRatioH, setCustomRatioH] = useState<number>(1);
  const [consistentCrop, setConsistentCrop] = useState(true);
  /** Relative crop box size (0.15 .. 1.0 of min image dimension) when consistentCrop is on */
  const [cropScalePct, setCropScalePct] = useState<number>(60);
  const [cropsByFile, setCropsByFile] = useState<Record<string, CropBox>>({});

  // Nucleus Auto-Detection State (Foci_Counter.groovy parameters)
  const [nucleusParams, setNucleusParams] = useState<NucleusParams>(DEFAULT_NUCLEUS_PARAMS);
  const [showNucleusSettings, setShowNucleusSettings] = useState(false);
  const [nucleiByFile, setNucleiByFile] = useState<Record<string, NucleusResult>>({});
  const [activeNucleusByFile, setActiveNucleusByFile] = useState<Record<string, number | null>>({});

  // Unified vs Individual Channel Adjustments
  const [editScope, setEditScope] = useState<"unified" | "individual">("unified");
  const [unifiedAdjustments, setUnifiedAdjustments] = useState<ChannelAdjustment[]>([]);
  const [individualAdjustments, setIndividualAdjustments] = useState<Record<string, ChannelAdjustment[]>>({});

  // Apply / Save state
  const [applyBusy, setApplyBusy] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((curr) => (curr === msg ? null : curr));
    }, 4500);
  }, []);

  const loadAll = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const [, projs] = await Promise.all([refreshFiles(), listProjects()]);
      setProjects(projs);
      if (projectId && projs.some((p) => p.id === projectId)) {
        setActiveProjectId(projectId);
      } else if (projs.length > 0) {
        setActiveProjectId((curr) => (curr && projs.some((p) => p.id === curr) ? curr : projs[0].id));
      } else {
        setActiveProjectId(null);
      }
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setLoadingProjects(false);
    }
  }, [lang, projectId, refreshFiles]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (projectId && projects.some((p) => p.id === projectId)) {
      setActiveProjectId(projectId);
    }
  }, [projectId, projects]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );

  const projectFiles = useMemo(() => {
    if (!activeProject) return [];
    const byId = new Map(files.map((f) => [f.id, f]));
    return activeProject.file_ids
      .map((id) => byId.get(id))
      .filter((f): f is FileSummary => Boolean(f) && !isSlide(f));
  }, [activeProject, files]);

  // Select first file in project when switching projects
  useEffect(() => {
    if (!projectFiles.length) {
      setSelectedFileId(null);
      return;
    }
    if (!selectedFileId || !projectFiles.some((f) => f.id === selectedFileId)) {
      setSelectedFileId(projectFiles[0].id);
    }
  }, [projectFiles, selectedFileId]);

  // Initialize unified adjustments from the first file in the project when project changes
  const initializedProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProject || !projectFiles.length) return;
    if (initializedProjectRef.current === activeProject.id && unifiedAdjustments.length > 0) return;
    initializedProjectRef.current = activeProject.id;
    setUnifiedAdjustments(defaultAdjustmentsFromFile(projectFiles[0]));
  }, [activeProject, projectFiles, unifiedAdjustments.length]);

  const activeAspectRatio = useMemo<number | null>(() => {
    if (aspectPreset === "free") return null;
    if (aspectPreset === "custom") {
      const w = Number(customRatioW);
      const h = Number(customRatioH);
      return w > 0 && h > 0 ? w / h : null;
    }
    return ASPECT_PRESETS.find((p) => p.key === aspectPreset)?.ratio ?? null;
  }, [aspectPreset, customRatioH, customRatioW]);

  const activeRatioLabel = useMemo(() => {
    if (aspectPreset === "free") return "";
    if (aspectPreset === "custom") return `${customRatioW}:${customRatioH}`;
    return aspectPreset;
  }, [aspectPreset, customRatioH, customRatioW]);

  // Load PackedPlane buffers for all files in the active project
  useEffect(() => {
    let cancelled = false;
    for (const file of projectFiles) {
      if (planesByFile[file.id]) continue;
      void getDisplay(file)
        .then((buf) => {
          if (cancelled) return;
          const packed = unpackPlane(buf);
          setPlanesByFile((prev) => ({ ...prev, [file.id]: packed }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [planesByFile, projectFiles]);

  // Compute crop box dimensions for a file given scalePct & aspectRatio
  const computeScaledBox = useCallback(
    (imgW: number, imgH: number, cx: number, cy: number, scalePct: number, ratio: number | null): CropBox => {
      const frac = Math.min(1, Math.max(0.15, scalePct / 100));
      let bw = Math.round(imgW * frac);
      let bh = Math.round(imgH * frac);
      if (ratio && ratio > 0) {
        const baseEdge = Math.min(imgW, imgH) * frac;
        if (ratio >= 1) {
          bw = Math.round(baseEdge * Math.sqrt(ratio));
          bh = Math.round(bw / ratio);
        } else {
          bh = Math.round(baseEdge / Math.sqrt(ratio));
          bw = Math.round(bh * ratio);
        }
      }
      return centerCropBoxAt(cx, cy, bw, bh, imgW, imgH, ratio);
    },
    [],
  );

  // Initialize default crop boxes for project files
  useEffect(() => {
    if (!projectFiles.length) return;
    setCropsByFile((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const file of projectFiles) {
        const packed = planesByFile[file.id];
        const imgW = Math.max(file.width ?? 0, packed?.width ?? 0);
        const imgH = Math.max(file.height ?? 0, packed?.height ?? 0);
        if (imgW <= 0 || imgH <= 0) continue;
        if (!next[file.id]) {
          next[file.id] = computeScaledBox(imgW, imgH, imgW / 2, imgH / 2, cropScalePct, activeAspectRatio);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeAspectRatio, computeScaledBox, cropScalePct, planesByFile, projectFiles]);

  // Re-fit all crop boxes when aspect ratio or unified cropScalePct changes
  const updateAllCropSizes = useCallback(
    (nextScalePct: number, nextRatio: number | null) => {
      setCropsByFile((prev) => {
        const next: Record<string, CropBox> = { ...prev };
        for (const file of projectFiles) {
          const packed = planesByFile[file.id];
          const imgW = Math.max(file.width ?? 0, packed?.width ?? 0);
          const imgH = Math.max(file.height ?? 0, packed?.height ?? 0);
          if (imgW <= 0 || imgH <= 0) continue;
          const existing = prev[file.id] ?? defaultCropBox(imgW, imgH, nextRatio);
          const cx = existing.x + existing.w / 2;
          const cy = existing.y + existing.h / 2;
          next[file.id] = computeScaledBox(imgW, imgH, cx, cy, nextScalePct, nextRatio);
        }
        return next;
      });
    },
    [computeScaledBox, planesByFile, projectFiles],
  );

  // Keep aspect ratio consistent when preset changes
  useEffect(() => {
    if (!projectFiles.length) return;
    if (consistentCrop) {
      updateAllCropSizes(cropScalePct, activeAspectRatio);
    } else {
      setCropsByFile((prev) => {
        const next: Record<string, CropBox> = { ...prev };
        for (const file of projectFiles) {
          const packed = planesByFile[file.id];
          const imgW = Math.max(file.width ?? 0, packed?.width ?? 0);
          const imgH = Math.max(file.height ?? 0, packed?.height ?? 0);
          if (imgW > 0 && imgH > 0 && next[file.id]) {
            next[file.id] = fitCropToAspect(next[file.id], imgW, imgH, activeAspectRatio);
          }
        }
        return next;
      });
    }
  }, [activeAspectRatio, consistentCrop, cropScalePct, planesByFile, projectFiles, updateAllCropSizes]);

  // Run Foci_Counter.groovy nucleus segmentation on a single file
  const runNucleusDetectForFile = useCallback(
    (file: FileSummary, customParams?: NucleusParams) => {
      const packed = planesByFile[file.id];
      if (!packed) return null;
      const imgW = Math.max(file.width ?? 0, packed.width);
      const imgH = Math.max(file.height ?? 0, packed.height);
      const umPerPx = Number(file.voxel_um?.[0] || 0);
      const res = segmentNucleiFromPacked(packed, file.channels, umPerPx, customParams ?? nucleusParams, {
        width: imgW,
        height: imgH,
      });
      setNucleiByFile((prev) => ({ ...prev, [file.id]: res }));
      const firstNuc = res.nuclei[0] ?? null;
      setActiveNucleusByFile((prev) => ({ ...prev, [file.id]: firstNuc?.id ?? null }));
      const cx = firstNuc ? firstNuc.cx : imgW / 2;
      const cy = firstNuc ? firstNuc.cy : imgH / 2;
      setCropsByFile((prev) => {
        const current = prev[file.id] ?? computeScaledBox(imgW, imgH, cx, cy, cropScalePct, activeAspectRatio);
        return {
          ...prev,
          [file.id]: centerCropBoxAt(cx, cy, current.w, current.h, imgW, imgH, activeAspectRatio),
        };
      });
      return res;
    },
    [activeAspectRatio, computeScaledBox, cropScalePct, nucleusParams, planesByFile],
  );

  // Run nucleus detection across all files in the project
  const runNucleusDetectAll = useCallback(
    (customParams?: NucleusParams) => {
      let totalFound = 0;
      for (const file of projectFiles) {
        const res = runNucleusDetectForFile(file, customParams);
        if (res && res.nuclei.length > 0) totalFound += res.nuclei.length;
      }
      if (totalFound > 0) {
        showToast(`${t(lang, "nucleusFound")}: ${totalFound}`);
      } else {
        showToast(t(lang, "nucleusNone"));
      }
    },
    [lang, projectFiles, runNucleusDetectForFile, showToast],
  );

  // Handle crop box drag/resize on one card; if consistentCrop is enabled and size changed, sync size to all cards
  const handleCardCropChange = useCallback(
    (file: FileSummary, nextBox: CropBox) => {
      const packed = planesByFile[file.id];
      const imgW = Math.max(file.width ?? 0, packed?.width ?? 0);
      const imgH = Math.max(file.height ?? 0, packed?.height ?? 0);
      setCropsByFile((prev) => {
        const oldBox = prev[file.id];
        const sizeChanged = oldBox && (Math.abs(oldBox.w - nextBox.w) > 1 || Math.abs(oldBox.h - nextBox.h) > 1);
        if (!consistentCrop || !sizeChanged || imgW <= 0 || imgH <= 0) {
          return { ...prev, [file.id]: nextBox };
        }
        // Synchronize relative crop size across all images in the project while keeping each image's center
        const relW = nextBox.w / imgW;
        const relH = nextBox.h / imgH;
        const updated: Record<string, CropBox> = { ...prev, [file.id]: nextBox };
        for (const other of projectFiles) {
          if (other.id === file.id) continue;
          const oPacked = planesByFile[other.id];
          const ow = Math.max(other.width ?? 0, oPacked?.width ?? 0);
          const oh = Math.max(other.height ?? 0, oPacked?.height ?? 0);
          if (ow <= 0 || oh <= 0) continue;
          const cur = prev[other.id] ?? defaultCropBox(ow, oh, activeAspectRatio);
          const cx = cur.x + cur.w / 2;
          const cy = cur.y + cur.h / 2;
          updated[other.id] = centerCropBoxAt(
            cx,
            cy,
            Math.round(ow * relW),
            Math.round(oh * relH),
            ow,
            oh,
            activeAspectRatio,
          );
        }
        return updated;
      });
    },
    [activeAspectRatio, consistentCrop, planesByFile, projectFiles],
  );

  // Select a specific nucleus on a card to center its crop box
  const handleSelectNucleus = useCallback(
    (file: FileSummary, nuc: NucleusRoi) => {
      const packed = planesByFile[file.id];
      const imgW = Math.max(file.width ?? 0, packed?.width ?? 0);
      const imgH = Math.max(file.height ?? 0, packed?.height ?? 0);
      setActiveNucleusByFile((prev) => ({ ...prev, [file.id]: nuc.id }));
      setCropsByFile((prev) => {
        const cur = prev[file.id] ?? defaultCropBox(imgW, imgH, activeAspectRatio);
        return {
          ...prev,
          [file.id]: centerCropBoxAt(nuc.cx, nuc.cy, cur.w, cur.h, imgW, imgH, activeAspectRatio),
        };
      });
    },
    [activeAspectRatio, planesByFile],
  );

  const selectedFile = useMemo(
    () => projectFiles.find((f) => f.id === selectedFileId) ?? projectFiles[0] ?? null,
    [projectFiles, selectedFileId],
  );

  // Resolve adjustments for a given file
  const getAdjustmentsForFile = useCallback(
    (file: FileSummary): ChannelAdjustment[] => {
      const custom = individualAdjustments[file.id];
      const base = custom ?? unifiedAdjustments;
      if (!base.length) return defaultAdjustmentsFromFile(file);
      return file.channels.map((ch, idx) => {
        const found = base[idx];
        if (found) return found;
        return {
          index: idx,
          name: ch.name || `Channel ${idx + 1}`,
          color: ch.color?.length >= 3 ? [...ch.color] : [255, 255, 255],
          visible: true,
          brightness: 1.0,
          min_pct: 0,
          max_pct: 100,
          gamma: 1.0,
        };
      });
    },
    [individualAdjustments, unifiedAdjustments],
  );

  const activeAdjustments = useMemo(() => {
    if (editScope === "individual" && selectedFile) {
      return getAdjustmentsForFile(selectedFile);
    }
    if (unifiedAdjustments.length > 0) return unifiedAdjustments;
    return defaultAdjustmentsFromFile(selectedFile ?? projectFiles[0]);
  }, [editScope, getAdjustmentsForFile, projectFiles, selectedFile, unifiedAdjustments]);

  const updateChannelAdjustment = useCallback(
    (chIdx: number, patch: Partial<ChannelAdjustment>) => {
      if (editScope === "individual" && selectedFile) {
        setIndividualAdjustments((prev) => {
          const current = prev[selectedFile.id] ?? getAdjustmentsForFile(selectedFile);
          const next = current.map((item, idx) => (idx === chIdx ? { ...item, ...patch } : item));
          return { ...prev, [selectedFile.id]: next };
        });
      } else {
        setUnifiedAdjustments((prev) => {
          const base = prev.length ? prev : defaultAdjustmentsFromFile(selectedFile ?? projectFiles[0]);
          return base.map((item, idx) => (idx === chIdx ? { ...item, ...patch } : item));
        });
      }
    },
    [editScope, getAdjustmentsForFile, projectFiles, selectedFile],
  );

  const resetChannelAdjustments = useCallback(() => {
    const refFile = selectedFile ?? projectFiles[0];
    if (!refFile) return;
    const fresh = defaultAdjustmentsFromFile(refFile).map((c) => ({
      ...c,
      brightness: 1.0,
      min_pct: 0,
      max_pct: 100,
      gamma: 1.0,
      visible: true,
    }));
    if (editScope === "individual" && selectedFile) {
      setIndividualAdjustments((prev) => {
        const next = { ...prev };
        delete next[selectedFile.id];
        return next;
      });
    } else {
      setUnifiedAdjustments(fresh);
      setIndividualAdjustments({});
    }
  }, [editScope, projectFiles, selectedFile]);

  const syncCurrentToAll = useCallback(() => {
    if (!selectedFile) return;
    const current = getAdjustmentsForFile(selectedFile);
    setUnifiedAdjustments(current.map((c) => ({ ...c })));
    setIndividualAdjustments({});
    setEditScope("unified");
  }, [getAdjustmentsForFile, selectedFile]);

  // Apply changes to backend (either mode="inplace" or mode="new")
  const handleBatchApply = async (mode: "inplace" | "new") => {
    if (!projectFiles.length || applyBusy) return;
    setApplyBusy(true);
    setError(null);
    try {
      const items = projectFiles.map((file) => {
        const packed = planesByFile[file.id];
        const imgW = Math.max(file.width ?? 0, packed?.width ?? 0);
        const imgH = Math.max(file.height ?? 0, packed?.height ?? 0);
        const box = cropsByFile[file.id] ?? defaultCropBox(imgW, imgH, activeAspectRatio);
        const adjs = getAdjustmentsForFile(file);
        return {
          file_id: file.id,
          crop: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            w: Math.round(box.w),
            h: Math.round(box.h),
            ratio_label: activeRatioLabel || undefined,
          },
          channel_edits: adjustmentsToChannelEdits(adjs),
        };
      });

      const res = await batchApply({
        items,
        mode,
        ratio_label: activeRatioLabel || undefined,
      });

      const affectedIds = [
        ...projectFiles.map((f) => f.id),
        ...res.files.map((f) => f.id),
      ];
      forgetPreviews(affectedIds);
      await refreshFiles();

      // Clear cached planes so fresh cropped/adjusted planes reload
      setPlanesByFile((prev) => {
        const next = { ...prev };
        for (const id of affectedIds) delete next[id];
        return next;
      });

      // Reset crop boxes to full dimensions of the newly cropped images
      const resetBoxes: Record<string, CropBox> = {};
      for (const updatedFile of res.files) {
        const w = updatedFile.width ?? 100;
        const h = updatedFile.height ?? 100;
        resetBoxes[updatedFile.id] = { x: 0, y: 0, w, h };
      }
      setCropsByFile((prev) => ({ ...prev, ...resetBoxes }));
      setNucleiByFile({});

      // If mode === "new" and we have an active project, also add the new files to the project
      if (mode === "new" && activeProject) {
        const newIds = res.files.map((f) => f.id);
        const updatedProj = await updateProject(activeProject.id, {
          file_ids: [...activeProject.file_ids, ...newIds],
        });
        setProjects((prev) => prev.map((p) => (p.id === updatedProj.id ? updatedProj : p)));
      }

      showToast(t(lang, mode === "inplace" ? "applySuccessInplace" : "applySuccessNew"));
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setApplyBusy(false);
    }
  };

  const handleRestoreOriginal = async (file: FileSummary) => {
    setError(null);
    try {
      const restored = await resetFile(file.id);
      forgetPreviews([file.id]);
      setPlanesByFile((prev) => {
        const next = { ...prev };
        delete next[file.id];
        return next;
      });
      await refreshFiles();
      const w = restored.width ?? 100;
      const h = restored.height ?? 100;
      setCropsByFile((prev) => ({
        ...prev,
        [file.id]: computeScaledBox(w, h, w / 2, h / 2, cropScalePct, activeAspectRatio),
      }));
      showToast(t(lang, "restoreSuccess"));
    } catch (err) {
      setError(detailMessage(err, lang));
    }
  };

  // Project CRUD handlers
  async function handleCreateProject(name: string) {
    const nonSlideFiles = files.filter((f) => !isSlide(f));
    const initialIds = nonSlideFiles.slice(0, 4).map((f) => f.id);
    const created = await createProject({
      name,
      file_ids: initialIds,
    });
    setProjects((prev) => [created, ...prev]);
    setActiveProjectId(created.id);
    nav(`/studio/${created.id}`);
  }

  async function handleRenameProject(name: string) {
    if (!renameProjectTarget) return;
    const updated = await updateProject(renameProjectTarget.id, { name });
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setRenameProjectTarget(null);
  }

  async function handleDeleteProject() {
    if (!deleteProjectTarget) return;
    await deleteProject(deleteProjectTarget.id);
    const remaining = projects.filter((p) => p.id !== deleteProjectTarget.id);
    setProjects(remaining);
    setDeleteProjectTarget(null);
    if (activeProjectId === deleteProjectTarget.id) {
      const nextId = remaining[0]?.id ?? null;
      setActiveProjectId(nextId);
      nav(nextId ? `/studio/${nextId}` : "/studio");
    }
  }

  async function handleRemoveFileFromProject(fileId: string) {
    if (!activeProject) return;
    const nextIds = activeProject.file_ids.filter((id) => id !== fileId);
    const updated = await updateProject(activeProject.id, { file_ids: nextIds });
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function openAddImagesModal() {
    if (!activeProject) return;
    const map: Record<string, boolean> = {};
    for (const id of activeProject.file_ids) map[id] = true;
    setPickerChecked(map);
    setAddImagesModal(true);
  }

  async function handleSaveProjectImages() {
    if (!activeProject) return;
    const nextIds = files.filter((f) => !isSlide(f) && pickerChecked[f.id]).map((f) => f.id);
    const updated = await updateProject(activeProject.id, { file_ids: nextIds });
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setAddImagesModal(false);
  }

  const detectedNucChannelIdx = useMemo(() => {
    const ref = selectedFile ?? projectFiles[0];
    return ref ? identifyNucleusChannel(ref.channels, nucleusParams.channel_index) : 0;
  }, [nucleusParams.channel_index, projectFiles, selectedFile]);

  return (
    <Shell dense>
      <div className="grid min-h-[calc(100dvh-3.35rem)] grid-cols-1 lg:h-[calc(100dvh-3.35rem)] lg:min-h-0 lg:grid-cols-[280px_minmax(0,1fr)_360px]">
        {/* Left Sidebar: Projects & Project Image List */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3.5 py-2.5">
            <span className="inline-flex items-center gap-2 text-[12.5px] font-semibold text-[var(--text)]">
              <SquaresFour size={16} weight="duotone" className="text-[var(--accent)]" />
              {t(lang, "projects")}
              <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--accent)]">
                {projects.length}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setNewProjectModal(true)}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 text-[11px] font-semibold text-[var(--accent-ink)] shadow-xs transition-opacity hover:opacity-90"
            >
              <Plus size={13} weight="bold" />
              {t(lang, "newProject")}
            </button>
          </div>

          {/* Project Selector List */}
          <div className="max-h-44 overflow-auto border-b border-[var(--line)] p-2">
            {loadingProjects && (
              <p className="px-2 py-3 text-[11.5px] text-[var(--text-dim)]">{t(lang, "loadingPage")}</p>
            )}
            {!loadingProjects && projects.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--line)] p-3 text-center text-[11.5px] leading-5 text-[var(--text-dim)]">
                {t(lang, "emptyProjects")}
              </p>
            )}
            {projects.map((proj) => {
              const active = proj.id === activeProject?.id;
              return (
                <div
                  key={proj.id}
                  onClick={() => {
                    setActiveProjectId(proj.id);
                    nav(`/studio/${proj.id}`);
                  }}
                  className={`group mb-1 flex cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-[12px] transition-colors ${
                    active
                      ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
                      : "text-[var(--text)] hover:bg-[var(--bg)]"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{proj.name}</div>
                    <div className="font-mono text-[10px] text-[var(--text-dim)]">
                      {proj.file_ids.length} {t(lang, "nFiles")}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => setDeleteProjectTarget(proj)}
                      className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--bg)] hover:text-[var(--danger)]"
                      title={t(lang, "deleteProject")}
                    >
                      <Trash size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Active Project Images */}
          {activeProject && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-2 px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-dim)]">
                <span className="truncate">{activeProject.name}</span>
                <button
                  type="button"
                  onClick={openAddImagesModal}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--bg)] px-2 py-1 text-[11px] font-medium text-[var(--accent)] ring-1 ring-[var(--line)] hover:ring-[var(--accent)]"
                >
                  <Plus size={12} weight="bold" />
                  {t(lang, "addImagesToProject")}
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
                {projectFiles.length === 0 ? (
                  <div className="mx-1.5 my-3 rounded-xl border border-dashed border-[var(--line)] p-4 text-center text-[11.5px] leading-5 text-[var(--text-dim)]">
                    <p>{t(lang, "emptyProjectFiles")}</p>
                    <button
                      type="button"
                      onClick={openAddImagesModal}
                      className="mt-2.5 inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--accent-ink)]"
                    >
                      <Plus size={12} weight="bold" />
                      {t(lang, "addImagesToProject")}
                    </button>
                  </div>
                ) : (
                  projectFiles.map((file) => {
                    const isSel = file.id === selectedFile?.id;
                    const box = cropsByFile[file.id];
                    return (
                      <div
                        key={file.id}
                        onClick={() => setSelectedFileId(file.id)}
                        className={`group mb-1 flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-[11.5px] transition-colors ${
                          isSel
                            ? "border-[var(--accent)]/50 bg-[var(--accent-soft)]/50 text-[var(--text)]"
                            : "border-transparent text-[var(--text)] hover:bg-[var(--bg)]"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{file.name}</span>
                            {file.cropped && (
                              <span className="rounded bg-[var(--accent-soft)] px-1 py-0.2 font-mono text-[9px] text-[var(--accent)]">
                                {t(lang, "croppedBadge")}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] text-[var(--text-dim)]">
                            {file.width ?? "–"}×{file.height ?? "–"}px
                            {box ? ` → ${box.w}×${box.h}px` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRemoveFileFromProject(file.id);
                          }}
                          title={t(lang, "removeFromProject")}
                          className="rounded p-1 text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--danger)] group-hover:opacity-100"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </Glass>

        {/* Center Pane: Interactive Multi-Image Live Studio */}
        <main className="relative flex min-h-[520px] flex-col bg-[var(--well)] text-white">
          {/* Top Unified Crop & Nucleus Control Bar */}
          <div className="border-b border-white/10 bg-slate-950/90 px-3.5 py-2.5 backdrop-blur-md">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Aspect Ratio Presets */}
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-white/65">
                  <Crop size={13} className="text-sky-400" />
                  {t(lang, "cropRatio")}:
                </span>
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
                      className={`cursor-pointer rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${
                        active
                          ? "bg-sky-400 font-semibold text-slate-950 shadow-xs"
                          : "bg-white/8 text-white/75 hover:bg-white/15 hover:text-white"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
                {aspectPreset === "custom" && (
                  <div className="ml-1 inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/50 px-1.5 py-0.5 font-mono text-[11px]">
                    <input
                      type="number"
                      min={0.1}
                      step="any"
                      value={customRatioW}
                      onChange={(e) => setCustomRatioW(Math.max(0.1, Number(e.target.value) || 1))}
                      className="w-10 bg-transparent text-center text-white focus:outline-none"
                    />
                    <span className="text-white/40">:</span>
                    <input
                      type="number"
                      min={0.1}
                      step="any"
                      value={customRatioH}
                      onChange={(e) => setCustomRatioH(Math.max(0.1, Number(e.target.value) || 1))}
                      className="w-10 bg-transparent text-center text-white focus:outline-none"
                    />
                  </div>
                )}
              </div>

              {/* View Mode Switcher & Grid Columns */}
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="inline-flex rounded-lg border border-white/12 bg-black/40 p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setViewMode("box")}
                    className={`cursor-pointer rounded-md px-2.5 py-1 font-medium transition-colors ${
                      viewMode === "box" ? "bg-sky-400 text-slate-950" : "text-white/70 hover:text-white"
                    }`}
                  >
                    {t(lang, "viewBoxEdit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("cropped")}
                    className={`cursor-pointer rounded-md px-2.5 py-1 font-medium transition-colors ${
                      viewMode === "cropped" ? "bg-emerald-400 text-slate-950" : "text-white/70 hover:text-white"
                    }`}
                  >
                    {t(lang, "viewCroppedResult")}
                  </button>
                </div>

                <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/12 bg-black/40 p-0.5 font-mono text-[10.5px]">
                  {([1, 2, 3, 4] as const).map((cols) => (
                    <button
                      key={cols}
                      type="button"
                      onClick={() => setGridCols(cols)}
                      title={`${t(lang, "gridCols")}: ${cols}`}
                      className={`cursor-pointer rounded px-1.5 py-0.5 ${
                        gridCols === cols ? "bg-white text-slate-950 font-semibold" : "text-white/65 hover:text-white"
                      }`}
                    >
                      {cols}×
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => setScaleBar((s) => !s)}
                  className={`cursor-pointer rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${
                    scaleBar ? "bg-white/18 text-white" : "bg-white/6 text-white/50 hover:text-white"
                  }`}
                >
                  {t(lang, "scaleBar")}
                </button>
              </div>
            </div>

            {/* Second Row: Unified Size Slider + Consistent Lock + Auto-Find Nucleus Center */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-2 text-[11px]">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConsistentCrop((v) => !v)}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium transition-colors ${
                    consistentCrop
                      ? "bg-sky-400/20 text-sky-300 ring-1 ring-sky-400/40"
                      : "bg-white/8 text-white/65 hover:text-white"
                  }`}
                >
                  {consistentCrop ? <LockSimple size={13} weight="fill" /> : <LockSimpleOpen size={13} />}
                  {t(lang, "lockConsistentCrop")}
                </button>

                <label className="inline-flex items-center gap-2 text-white/75">
                  <span>{t(lang, "cropSizeScale")}:</span>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={2}
                    value={cropScalePct}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setCropScalePct(val);
                      updateAllCropSizes(val, activeAspectRatio);
                    }}
                    className="h-1.5 w-28 accent-sky-400"
                  />
                  <span className="w-9 font-mono text-sky-300">{cropScalePct}%</span>
                </label>
              </div>

              {/* Nucleus Auto-Detection Controls */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={projectFiles.length === 0}
                  onClick={() => runNucleusDetectAll()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 text-[11.5px] font-semibold text-slate-950 shadow-sm transition-all hover:bg-amber-300 disabled:opacity-40"
                >
                  <Crosshair size={14} weight="bold" />
                  {t(lang, "autoNucleusAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setShowNucleusSettings((v) => !v)}
                  aria-expanded={showNucleusSettings}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                    showNucleusSettings
                      ? "bg-white text-slate-950"
                      : "bg-white/10 text-white/80 hover:bg-white/18 hover:text-white"
                  }`}
                >
                  <GearSix size={13} />
                  {t(lang, "nucleusSettings")}
                </button>
              </div>
            </div>

            {/* Collapsible ImageJ Foci_Counter.groovy Nucleus Segmentation Parameters */}
            {showNucleusSettings && (
              <div className="mt-2.5 grid grid-cols-2 gap-2.5 rounded-xl border border-amber-400/25 bg-black/55 p-3 text-[11px] sm:grid-cols-4">
                <label className="flex flex-col gap-1">
                  <span className="text-white/60">{t(lang, "nucleusChannel")}</span>
                  <select
                    value={nucleusParams.channel_index ?? "auto"}
                    onChange={(e) => {
                      const val = e.target.value === "auto" ? null : Number(e.target.value);
                      const next = { ...nucleusParams, channel_index: val };
                      setNucleusParams(next);
                      runNucleusDetectAll(next);
                    }}
                    className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 font-mono text-white"
                  >
                    <option value="auto">
                      Auto (#{detectedNucChannelIdx + 1})
                    </option>
                    {(selectedFile ?? projectFiles[0])?.channels.map((ch, idx) => (
                      <option key={idx} value={idx}>
                        #{idx + 1} {ch.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-white/60">{t(lang, "nucleusThreshold")}</span>
                  <select
                    value={nucleusParams.threshold_method}
                    onChange={(e) => {
                      const next = {
                        ...nucleusParams,
                        threshold_method: e.target.value as ThresholdMethod,
                      };
                      setNucleusParams(next);
                      runNucleusDetectAll(next);
                    }}
                    className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 font-mono text-white"
                  >
                    {THRESHOLD_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-white/60">{t(lang, "nucleusSmooth")}</span>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    step={0.1}
                    value={nucleusParams.smooth_um}
                    onChange={(e) =>
                      setNucleusParams((p) => ({ ...p, smooth_um: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 font-mono text-white"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-white/60">{t(lang, "nucleusMinCirc")}</span>
                  <input
                    type="number"
                    min={0.05}
                    max={0.95}
                    step={0.05}
                    value={nucleusParams.min_circularity}
                    onChange={(e) =>
                      setNucleusParams((p) => ({
                        ...p,
                        min_circularity: Math.min(0.95, Math.max(0.05, Number(e.target.value) || 0.4)),
                      }))
                    }
                    className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 font-mono text-white"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-white/60">{t(lang, "nucleusMinArea")}</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    step={5}
                    value={nucleusParams.min_area_um2}
                    onChange={(e) =>
                      setNucleusParams((p) => ({ ...p, min_area_um2: Math.max(1, Number(e.target.value) || 30) }))
                    }
                    className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 font-mono text-white"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-white/60">{t(lang, "nucleusMaxArea")}</span>
                  <input
                    type="number"
                    min={50}
                    max={20000}
                    step={50}
                    value={nucleusParams.max_area_um2}
                    onChange={(e) =>
                      setNucleusParams((p) => ({ ...p, max_area_um2: Math.max(50, Number(e.target.value) || 2000) }))
                    }
                    className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 font-mono text-white"
                  />
                </label>

                <div className="col-span-2 flex flex-wrap items-center gap-3 pt-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-white/85">
                    <input
                      type="checkbox"
                      checked={nucleusParams.watershed}
                      onChange={(e) => setNucleusParams((p) => ({ ...p, watershed: e.target.checked }))}
                      className="accent-amber-400"
                    />
                    {t(lang, "nucleusWatershed")} (Solidity &lt; {nucleusParams.ws_solidity})
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-white/85">
                    <input
                      type="checkbox"
                      checked={nucleusParams.exclude_edges}
                      onChange={(e) => setNucleusParams((p) => ({ ...p, exclude_edges: e.target.checked }))}
                      className="accent-amber-400"
                    />
                    {t(lang, "nucleusExcludeEdges")}
                  </label>
                  <button
                    type="button"
                    onClick={() => runNucleusDetectAll(nucleusParams)}
                    className="ml-auto rounded-lg bg-amber-400/20 px-2.5 py-1 font-semibold text-amber-300 hover:bg-amber-400/30"
                  >
                    {t(lang, "autoNucleusAll")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Toast & Error Alerts */}
          {toast && (
            <div className="fade-in absolute right-4 top-16 z-40 flex items-center gap-2 rounded-xl border border-emerald-400/35 bg-slate-950/95 px-3.5 py-2 text-[12px] text-emerald-200 shadow-2xl">
              <CheckCircle size={16} weight="fill" className="text-emerald-400" />
              <span>{toast}</span>
            </div>
          )}
          {error && (
            <div className="mx-4 mt-3 rounded-xl border border-rose-500/35 bg-rose-950/80 px-3.5 py-2 text-[12px] text-rose-200">
              {error}
            </div>
          )}

          {/* Multi-Image Interactive Grid */}
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!activeProject ? (
              <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center text-white/60">
                <CirclesFour size={38} weight="duotone" className="mb-3 text-sky-400" />
                <h2 className="text-[15px] font-semibold text-white">{t(lang, "studioTitle")}</h2>
                <p className="mt-1 max-w-md text-[12.5px] leading-5">{t(lang, "studioSub")}</p>
                <button
                  type="button"
                  onClick={() => setNewProjectModal(true)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-sky-400 px-4 py-2 text-[12.5px] font-semibold text-slate-950 shadow-md hover:bg-sky-300"
                >
                  <Plus size={15} weight="bold" />
                  {t(lang, "newProject")}
                </button>
              </div>
            ) : projectFiles.length === 0 ? (
              <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center text-white/60">
                <FolderOpen size={36} weight="duotone" className="mb-3 text-sky-400" />
                <p className="max-w-sm text-[13px] leading-5">{t(lang, "emptyProjectFiles")}</p>
                <button
                  type="button"
                  onClick={openAddImagesModal}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-sky-400 px-4 py-2 text-[12.5px] font-semibold text-slate-950 shadow-md hover:bg-sky-300"
                >
                  <Plus size={15} weight="bold" />
                  {t(lang, "addImagesToProject")}
                </button>
              </div>
            ) : (
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: `repeat(${Math.min(gridCols, Math.max(1, projectFiles.length))}, minmax(0, 1fr))`,
                }}
              >
                {projectFiles.map((file) => {
                  const packed = planesByFile[file.id];
                  const imgW = Math.max(file.width ?? 0, packed?.width ?? 0, 100);
                  const imgH = Math.max(file.height ?? 0, packed?.height ?? 0, 100);
                  const box = cropsByFile[file.id] ?? defaultCropBox(imgW, imgH, activeAspectRatio);
                  return (
                    <StudioImageCard
                      key={file.id}
                      file={file}
                      packed={packed}
                      adjustments={getAdjustmentsForFile(file)}
                      crop={box}
                      aspectRatio={activeAspectRatio}
                      viewMode={viewMode}
                      scaleBar={scaleBar}
                      nucleiResult={nucleiByFile[file.id]}
                      activeNucleusId={activeNucleusByFile[file.id] ?? null}
                      selected={selectedFile?.id === file.id}
                      hasOverride={Boolean(individualAdjustments[file.id])}
                      onSelect={() => setSelectedFileId(file.id)}
                      onCropChange={(next) => handleCardCropChange(file, next)}
                      onSelectNucleus={(nuc) => handleSelectNucleus(file, nuc)}
                      onAutoNucleusSingle={() => {
                        const res = runNucleusDetectForFile(file);
                        if (res && res.nuclei.length > 0) {
                          showToast(`${file.name}: ${t(lang, "nucleusFound")} (${res.nuclei.length})`);
                        } else {
                          showToast(`${file.name}: ${t(lang, "nucleusNone")}`);
                        }
                      }}
                      onResetOriginal={() => void handleRestoreOriginal(file)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </main>

        {/* Right Pane: Unified / Individual Channel Controls + Apply In-Place / New + Export */}
        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-t lg:border-l lg:border-t-0">
          {/* Scope Selector: Unified vs Individual */}
          <div className="border-b border-[var(--line)] p-3">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--bg)] p-1 text-[11.5px]">
              <button
                type="button"
                onClick={() => setEditScope("unified")}
                className={`cursor-pointer rounded-lg px-2 py-1.5 font-medium transition-colors ${
                  editScope === "unified"
                    ? "bg-[var(--accent)] text-[var(--accent-ink)] shadow-xs"
                    : "text-[var(--text-dim)] hover:text-[var(--text)]"
                }`}
              >
                {t(lang, "unifiedMode")}
              </button>
              <button
                type="button"
                onClick={() => setEditScope("individual")}
                className={`cursor-pointer rounded-lg px-2 py-1.5 font-medium transition-colors ${
                  editScope === "individual"
                    ? "bg-[var(--accent)] text-[var(--accent-ink)] shadow-xs"
                    : "text-[var(--text-dim)] hover:text-[var(--text)]"
                }`}
              >
                {t(lang, "individualMode")}
              </button>
            </div>

            {editScope === "individual" && selectedFile && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-[var(--bg)]/60 px-2.5 py-1.5 text-[11px]">
                <span className="truncate font-mono text-[var(--text)]" title={selectedFile.name}>
                  {selectedFile.name}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {individualAdjustments[selectedFile.id] && (
                    <button
                      type="button"
                      onClick={() =>
                        setIndividualAdjustments((prev) => {
                          const next = { ...prev };
                          delete next[selectedFile.id];
                          return next;
                        })
                      }
                      className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]"
                    >
                      {t(lang, "clearIndividualOverride")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={syncCurrentToAll}
                    className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] ring-1 ring-[var(--line)] hover:text-[var(--text)]"
                  >
                    {t(lang, "syncToAllImages")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Per-Channel Intensity & LUT Controls */}
          <div className="min-h-0 flex-1 overflow-auto p-3.5">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text)]">
                <SlidersHorizontal size={14} className="text-[var(--accent)]" />
                {t(lang, "channels")} · {t(lang, "lutTitle")}
              </span>
              <button
                type="button"
                onClick={resetChannelAdjustments}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--text-dim)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
              >
                <ArrowCounterClockwise size={12} />
                {t(lang, "reset")}
              </button>
            </div>

            {activeAdjustments.length === 0 ? (
              <p className="py-8 text-center text-[12px] text-[var(--text-dim)]">{t(lang, "noneSelected")}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {activeAdjustments.map((ch, idx) => {
                  const [r = 255, g = 255, b = 255] = ch.color;
                  const rgbCss = `rgb(${r}, ${g}, ${b})`;
                  const pctBrightness = Math.round(ch.brightness * 100);
                  return (
                    <div
                      key={idx}
                      className={`rounded-xl border p-3 transition-opacity ${
                        ch.visible
                          ? "border-[var(--line)] bg-[var(--bg)]/50"
                          : "border-[var(--line)]/50 bg-[var(--bg)]/20 opacity-60"
                      }`}
                    >
                      {/* Channel Header: Name, Visibility, Color Swatches */}
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => updateChannelAdjustment(idx, { visible: !ch.visible })}
                          className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--text)]"
                        >
                          <span
                            className="h-3 w-3 rounded-full ring-1 ring-black/30"
                            style={{ backgroundColor: rgbCss }}
                          />
                          <span>{ch.name}</span>
                          {ch.visible ? (
                            <Eye size={13} className="text-[var(--text-dim)]" />
                          ) : (
                            <EyeSlash size={13} className="text-[var(--text-dim)]" />
                          )}
                        </button>

                        <div className="flex items-center gap-1">
                          {COLOR_SWATCHES.map((sw) => {
                            const isMatch =
                              Math.abs(r - sw.rgb[0]) < 35 &&
                              Math.abs(g - sw.rgb[1]) < 35 &&
                              Math.abs(b - sw.rgb[2]) < 35;
                            return (
                              <button
                                key={sw.name}
                                type="button"
                                onClick={() => updateChannelAdjustment(idx, { color: [...sw.rgb] })}
                                title={sw.name}
                                style={{ backgroundColor: `rgb(${sw.rgb.join(",")})` }}
                                className={`h-3.5 w-3.5 rounded-full transition-transform ${
                                  isMatch ? "scale-125 ring-2 ring-[var(--text)]" : "opacity-65 hover:opacity-100"
                                }`}
                              />
                            );
                          })}
                        </div>
                      </div>

                      {/* Brightness / Intensity Gain Slider (0% - 200%) */}
                      <div className="mt-2.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-[var(--text-dim)]">{t(lang, "channelBrightness")}</span>
                          <div className="flex items-center gap-1 font-mono text-[10.5px]">
                            <button
                              type="button"
                              onClick={() => updateChannelAdjustment(idx, { brightness: 0.5 })}
                              className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-dim)] ring-1 ring-[var(--line)] hover:text-[var(--text)]"
                            >
                              {t(lang, "dimChannelPreset")}
                            </button>
                            <button
                              type="button"
                              onClick={() => updateChannelAdjustment(idx, { brightness: 1.0 })}
                              className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-dim)] ring-1 ring-[var(--line)] hover:text-[var(--text)]"
                            >
                              {t(lang, "normalChannelPreset")}
                            </button>
                            <span className="ml-1 w-10 text-right font-semibold text-[var(--accent)]">
                              {pctBrightness}%
                            </span>
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={200}
                          step={2}
                          value={pctBrightness}
                          onChange={(e) =>
                            updateChannelAdjustment(idx, { brightness: Number(e.target.value) / 100 })
                          }
                          className="mt-1 h-1.5 w-full accent-[var(--accent)]"
                        />
                      </div>

                      {/* Black Point (Min) & White Point (Max) & Gamma */}
                      <div className="mt-2 grid grid-cols-3 gap-2 text-[10.5px]">
                        <label className="flex flex-col gap-0.5">
                          <span className="flex justify-between text-[var(--text-dim)]">
                            <span>{t(lang, "min")}</span>
                            <span className="font-mono">{ch.min_pct}%</span>
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={Math.max(0, ch.max_pct - 5)}
                            step={1}
                            value={ch.min_pct}
                            onChange={(e) =>
                              updateChannelAdjustment(idx, { min_pct: Number(e.target.value) })
                            }
                            className="h-1 w-full accent-[var(--accent)]"
                          />
                        </label>

                        <label className="flex flex-col gap-0.5">
                          <span className="flex justify-between text-[var(--text-dim)]">
                            <span>{t(lang, "max")}</span>
                            <span className="font-mono">{ch.max_pct}%</span>
                          </span>
                          <input
                            type="range"
                            min={Math.min(100, ch.min_pct + 5)}
                            max={100}
                            step={1}
                            value={ch.max_pct}
                            onChange={(e) =>
                              updateChannelAdjustment(idx, { max_pct: Number(e.target.value) })
                            }
                            className="h-1 w-full accent-[var(--accent)]"
                          />
                        </label>

                        <label className="flex flex-col gap-0.5">
                          <span className="flex justify-between text-[var(--text-dim)]">
                            <span>{t(lang, "gamma")}</span>
                            <span className="font-mono">{ch.gamma.toFixed(2)}</span>
                          </span>
                          <input
                            type="range"
                            min={0.2}
                            max={2.5}
                            step={0.05}
                            value={ch.gamma}
                            onChange={(e) =>
                              updateChannelAdjustment(idx, { gamma: Number(e.target.value) })
                            }
                            className="h-1 w-full accent-[var(--accent)]"
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Bottom Action Area: Apply In-Place vs Save as New Files + Export */}
          <div className="border-t border-[var(--line)] bg-[var(--bg)]/60 p-3.5">
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={projectFiles.length === 0 || applyBusy}
                  onClick={() => void handleBatchApply("inplace")}
                  className="inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 text-[12px] font-semibold text-[var(--accent-ink)] shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Check size={14} weight="bold" />
                  {applyBusy ? t(lang, "applyingChanges") : t(lang, "applyInplace")}
                </button>

                <button
                  type="button"
                  disabled={projectFiles.length === 0 || applyBusy}
                  onClick={() => void handleBatchApply("new")}
                  className="inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-[12px] font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
                >
                  <Sparkle size={14} weight="fill" className="text-[var(--accent)]" />
                  {applyBusy ? t(lang, "applyingChanges") : t(lang, "applyNewFiles")}
                </button>
              </div>

              <button
                type="button"
                disabled={projectFiles.length === 0}
                onClick={() => setExportModalOpen(true)}
                className="inline-flex min-h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--bg)]/80 px-3 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
              >
                <ExportIcon size={15} />
                {t(lang, "exportProjectFiles")} ({projectFiles.length})
              </button>
            </div>
          </div>
        </Glass>
      </div>

      {/* Create New Project Dialog */}
      <NameDialog
        open={newProjectModal}
        title={t(lang, "newProject")}
        label={t(lang, "projectName")}
        initial={`Project ${projects.length + 1}`}
        onSubmit={handleCreateProject}
        onClose={() => setNewProjectModal(false)}
      />

      {/* Rename Project Dialog */}
      <NameDialog
        open={Boolean(renameProjectTarget)}
        title={t(lang, "rename")}
        label={t(lang, "projectName")}
        initial={renameProjectTarget?.name ?? ""}
        onSubmit={handleRenameProject}
        onClose={() => setRenameProjectTarget(null)}
      />

      {/* Delete Project Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(deleteProjectTarget)}
        title={t(lang, "deleteProject")}
        body={
          deleteProjectTarget && (
            <>
              <span className="mb-1 block font-mono text-[11.5px] font-semibold text-[var(--text)]">
                {deleteProjectTarget.name}
              </span>
              {t(lang, "deleteProjectHint")}
            </>
          )
        }
        confirmLabel={t(lang, "confirmDelete")}
        onConfirm={handleDeleteProject}
        onClose={() => setDeleteProjectTarget(null)}
      />

      {/* Add Images from Workspace Modal */}
      <Modal
        open={addImagesModal}
        title={t(lang, "addImagesToProject")}
        subtitle={activeProject?.name}
        onClose={() => setAddImagesModal(false)}
        width={520}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-[11.5px] text-[var(--text-dim)]">
            <span>
              {t(lang, "selected")}:{" "}
              <strong className="font-mono text-[var(--text)]">
                {Object.values(pickerChecked).filter(Boolean).length}
              </strong>
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const all: Record<string, boolean> = {};
                  for (const f of files) if (!isSlide(f)) all[f.id] = true;
                  setPickerChecked(all);
                }}
                className="text-[var(--accent)] hover:underline"
              >
                {t(lang, "selectAll")}
              </button>
              <button
                type="button"
                onClick={() => setPickerChecked({})}
                className="text-[var(--text-dim)] hover:underline"
              >
                {t(lang, "clearSelection")}
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--bg)]/50 p-2">
            {files
              .filter((f) => !isSlide(f))
              .map((file) => {
                const isChecked = Boolean(pickerChecked[file.id]);
                return (
                  <label
                    key={file.id}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg)]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) =>
                          setPickerChecked((prev) => ({ ...prev, [file.id]: e.target.checked }))
                        }
                        className="accent-[var(--accent)]"
                      />
                      <span className="truncate font-medium text-[var(--text)]">
                        {joinPath(file.folder, file.name)}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-dim)]">
                      {file.width ?? "–"}×{file.height ?? "–"}
                    </span>
                  </label>
                );
              })}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setAddImagesModal(false)}
              className="rounded-xl px-3.5 py-1.5 text-[12px] text-[var(--text-dim)] hover:bg-[var(--bg)]"
            >
              {t(lang, "cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSaveProjectImages()}
              className="rounded-xl bg-[var(--accent)] px-4 py-1.5 text-[12px] font-semibold text-[var(--accent-ink)]"
            >
              {t(lang, "save")}
            </button>
          </div>
        </div>
      </Modal>

      {/* Export Project Files Modal */}
      <Modal
        open={exportModalOpen}
        title={t(lang, "exportProjectFiles")}
        subtitle={activeProject?.name}
        onClose={() => setExportModalOpen(false)}
        width={460}
      >
        <ExportPanel
          fileIds={projectFiles.map((f) => f.id)}
          visible={activeAdjustments.map((c) => c.visible)}
        />
      </Modal>
    </Shell>
  );
}
