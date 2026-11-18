import { useRef } from "react";
import { autoScaleUm, type Optics } from "../lib/scalebar";
import { formatUm } from "../lib/format";
import type { NucleusRoi } from "../lib/types";

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type HandleDir = "move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | "new";

const MIN_CROP_PX = 16;

export function fitCropToAspect(
  box: CropBox,
  imageWidth: number,
  imageHeight: number,
  aspectRatio: number | null,
): CropBox {
  if (!aspectRatio || aspectRatio <= 0 || imageWidth < 2 || imageHeight < 2) {
    const x = Math.max(0, Math.min(Math.round(box.x), imageWidth - 2));
    const y = Math.max(0, Math.min(Math.round(box.y), imageHeight - 2));
    const w = Math.max(2, Math.min(Math.round(box.w), imageWidth - x));
    const h = Math.max(2, Math.min(Math.round(box.h), imageHeight - y));
    return { x, y, w, h };
  }

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const area = Math.max(box.w * box.h, MIN_CROP_PX * MIN_CROP_PX);
  let targetW = Math.sqrt(area * aspectRatio);
  let targetH = targetW / aspectRatio;

  if (targetW > imageWidth * 0.92) {
    targetW = imageWidth * 0.92;
    targetH = targetW / aspectRatio;
  }
  if (targetH > imageHeight * 0.92) {
    targetH = imageHeight * 0.92;
    targetW = targetH * aspectRatio;
  }
  if (targetW > imageWidth) {
    targetW = imageWidth;
    targetH = targetW / aspectRatio;
  }
  if (targetH > imageHeight) {
    targetH = imageHeight;
    targetW = targetH * aspectRatio;
  }

  const w = Math.max(2, Math.min(imageWidth, Math.round(targetW)));
  const h = Math.max(2, Math.min(imageHeight, Math.round(targetH)));
  const x = Math.max(0, Math.min(imageWidth - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(imageHeight - h, Math.round(cy - h / 2)));
  return { x, y, w, h };
}

export function defaultCropBox(imageWidth: number, imageHeight: number, aspectRatio: number | null): CropBox {
  const initial: CropBox = {
    x: Math.round(imageWidth * 0.15),
    y: Math.round(imageHeight * 0.15),
    w: Math.max(2, Math.round(imageWidth * 0.7)),
    h: Math.max(2, Math.round(imageHeight * 0.7)),
  };
  return fitCropToAspect(initial, imageWidth, imageHeight, aspectRatio);
}

export function centerCropBoxAt(
  cx: number,
  cy: number,
  w: number,
  h: number,
  imageWidth: number,
  imageHeight: number,
  aspectRatio: number | null = null,
): CropBox {
  if (imageWidth < 2 || imageHeight < 2) return { x: 0, y: 0, w: 2, h: 2 };
  let cw = Math.max(2, Math.min(imageWidth, Math.round(w)));
  let ch = Math.max(2, Math.min(imageHeight, Math.round(h)));
  if (aspectRatio && aspectRatio > 0) {
    if (cw / ch > aspectRatio) {
      cw = Math.max(2, Math.min(imageWidth, Math.round(ch * aspectRatio)));
    } else {
      ch = Math.max(2, Math.min(imageHeight, Math.round(cw / aspectRatio)));
    }
    if (cw > imageWidth) {
      cw = imageWidth;
      ch = Math.max(2, Math.round(cw / aspectRatio));
    }
    if (ch > imageHeight) {
      ch = imageHeight;
      cw = Math.max(2, Math.round(ch * aspectRatio));
    }
  }
  const x = Math.max(0, Math.min(imageWidth - cw, Math.round(cx - cw / 2)));
  const y = Math.max(0, Math.min(imageHeight - ch, Math.round(cy - ch / 2)));
  return { x, y, w: cw, h: ch };
}

export function CropOverlay({
  imageWidth,
  imageHeight,
  umPerPixel,
  crop,
  aspectRatio,
  scaleBar,
  nuclei,
  activeNucleusId,
  onSelectNucleus,
  compact = false,
  optics,
  scaleUm: forcedScaleUm,
  onChange,
}: {
  optics?: Optics;
  scaleUm?: number | null;
  imageWidth: number;
  imageHeight: number;
  umPerPixel: number;
  crop: CropBox;
  aspectRatio: number | null;
  scaleBar: boolean;
  nuclei?: NucleusRoi[];
  activeNucleusId?: number | null;
  onSelectNucleus?: (nuc: NucleusRoi) => void;
  compact?: boolean;
  onChange: (next: CropBox) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    dir: HandleDir;
    startIx: number;
    startIy: number;
    startBox: CropBox;
  } | null>(null);

  if (imageWidth <= 0 || imageHeight <= 0) return null;

  function toImageCoords(clientX: number, clientY: number): { ix: number; iy: number } {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { ix: 0, iy: 0 };
    const ix = ((clientX - rect.left) / rect.width) * imageWidth;
    const iy = ((clientY - rect.top) / rect.height) * imageHeight;
    return { ix, iy };
  }

  function startDrag(dir: HandleDir, event: React.PointerEvent) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const el = overlayRef.current;
    if (!el) return;
    el.setPointerCapture(event.pointerId);
    const { ix, iy } = toImageCoords(event.clientX, event.clientY);
    dragRef.current = {
      dir,
      startIx: ix,
      startIy: iy,
      startBox: { ...crop },
    };
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = dragRef.current;
    if (!state) return;
    event.stopPropagation();
    const { ix, iy } = toImageCoords(event.clientX, event.clientY);
    const dx = ix - state.startIx;
    const dy = iy - state.startIy;
    const b = state.startBox;
    const minEdge = Math.min(MIN_CROP_PX, Math.floor(Math.min(imageWidth, imageHeight) / 2));

    if (state.dir === "move") {
      const x = Math.round(Math.max(0, Math.min(imageWidth - b.w, b.x + dx)));
      const y = Math.round(Math.max(0, Math.min(imageHeight - b.h, b.y + dy)));
      onChange({ x, y, w: b.w, h: b.h });
      return;
    }

    if (state.dir === "new") {
      const x0 = Math.max(0, Math.min(imageWidth, state.startIx));
      const y0 = Math.max(0, Math.min(imageHeight, state.startIy));
      const x1 = Math.max(0, Math.min(imageWidth, ix));
      const y1 = Math.max(0, Math.min(imageHeight, iy));
      let x = Math.min(x0, x1);
      let y = Math.min(y0, y1);
      let w = Math.max(minEdge, Math.abs(x1 - x0));
      let h = Math.max(minEdge, Math.abs(y1 - y0));
      if (aspectRatio && aspectRatio > 0) {
        h = w / aspectRatio;
        if (y + h > imageHeight) {
          h = imageHeight - y;
          w = h * aspectRatio;
        }
      }
      x = Math.max(0, Math.min(imageWidth - w, x));
      y = Math.max(0, Math.min(imageHeight - h, y));
      onChange({
        x: Math.round(x),
        y: Math.round(y),
        w: Math.max(2, Math.round(w)),
        h: Math.max(2, Math.round(h)),
      });
      return;
    }

    let left = b.x;
    let right = b.x + b.w;
    let top = b.y;
    let bottom = b.y + b.h;

    if (state.dir.includes("w")) left = Math.max(0, Math.min(right - minEdge, b.x + dx));
    if (state.dir.includes("e")) right = Math.min(imageWidth, Math.max(left + minEdge, b.x + b.w + dx));
    if (state.dir.includes("n")) top = Math.max(0, Math.min(bottom - minEdge, b.y + dy));
    if (state.dir.includes("s")) bottom = Math.min(imageHeight, Math.max(top + minEdge, b.y + b.h + dy));

    let w = right - left;
    let h = bottom - top;

    if (aspectRatio && aspectRatio > 0) {
      if (state.dir === "n" || state.dir === "s") {
        w = h * aspectRatio;
        const cx = (left + right) / 2;
        if (w > imageWidth) {
          w = imageWidth;
          h = w / aspectRatio;
          if (state.dir === "n") top = bottom - h;
          else bottom = top + h;
        }
        left = Math.max(0, Math.min(imageWidth - w, cx - w / 2));
        right = left + w;
      } else if (state.dir === "e" || state.dir === "w") {
        h = w / aspectRatio;
        const cy = (top + bottom) / 2;
        if (h > imageHeight) {
          h = imageHeight;
          w = h * aspectRatio;
          if (state.dir === "w") left = right - w;
          else right = left + w;
        }
        top = Math.max(0, Math.min(imageHeight - h, cy - h / 2));
        bottom = top + h;
      } else {
        // Corner handle
        if (w / h > aspectRatio) {
          w = h * aspectRatio;
        } else {
          h = w / aspectRatio;
        }
        const maxW = state.dir.includes("w") ? right : imageWidth - left;
        const maxH = state.dir.includes("n") ? bottom : imageHeight - top;
        if (w > maxW) {
          w = maxW;
          h = w / aspectRatio;
        }
        if (h > maxH) {
          h = maxH;
          w = h * aspectRatio;
        }
        if (state.dir.includes("w")) left = right - w;
        else right = left + w;
        if (state.dir.includes("n")) top = bottom - h;
        else bottom = top + h;
      }
    }

    onChange({
      x: Math.max(0, Math.round(left)),
      y: Math.max(0, Math.round(top)),
      w: Math.max(2, Math.min(imageWidth, Math.round(right - left))),
      h: Math.max(2, Math.min(imageHeight, Math.round(bottom - top))),
    });
  }

  function endDrag(event: React.PointerEvent) {
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
  }

  const leftPct = (crop.x / imageWidth) * 100;
  const topPct = (crop.y / imageHeight) * 100;
  const widthPct = (crop.w / imageWidth) * 100;
  const heightPct = (crop.h / imageHeight) * 100;

  const [scaleUm, scalePx] = autoScaleUm(umPerPixel, crop.w, optics, forcedScaleUm) ?? [0, 0];
  const scaleBarPct = crop.w > 0 ? Math.min(90, Math.max(6, (scalePx / crop.w) * 100)) : 0;

  return (
    <div
      ref={overlayRef}
      data-no-pan
      className="pointer-events-auto absolute inset-0 z-10 cursor-crosshair select-none overflow-hidden"
      onPointerDown={(e) => startDrag("new", e)}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Detected Nuclei Contours & Clickable Centroids */}
      {nuclei && nuclei.length > 0 && (
        <svg
          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible"
        >
          {nuclei.map((nuc) => {
            const isActive = activeNucleusId === nuc.id;
            const pathD =
              nuc.contour.length >= 3
                ? `M ${nuc.contour.map(([px, py]) => `${px} ${py}`).join(" L ")} Z`
                : "";
            return (
              <g key={nuc.id}>
                {pathD && (
                  <path
                    d={pathD}
                    fill={isActive ? "rgba(250, 204, 21, 0.14)" : "rgba(56, 189, 248, 0.08)"}
                    stroke={isActive ? "#facc15" : "#38bdf8"}
                    strokeWidth={Math.max(1.2, Math.min(imageWidth, imageHeight) * 0.0035)}
                    strokeDasharray={isActive ? undefined : `${Math.max(3, imageWidth * 0.008)} ${Math.max(2, imageWidth * 0.006)}`}
                    className={onSelectNucleus ? "pointer-events-auto cursor-pointer" : ""}
                    onPointerDown={(e) => {
                      if (!onSelectNucleus) return;
                      e.stopPropagation();
                      e.preventDefault();
                      onSelectNucleus(nuc);
                    }}
                  />
                )}
              </g>
            );
          })}
        </svg>
      )}

      {/* Clickable Nucleus Center Badges */}
      {nuclei &&
        nuclei.map((nuc) => {
          const isActive = activeNucleusId === nuc.id;
          const cxPct = (nuc.cx / imageWidth) * 100;
          const cyPct = (nuc.cy / imageHeight) * 100;
          return (
            <button
              key={`badge-${nuc.id}`}
              type="button"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onSelectNucleus?.(nuc);
              }}
              style={{ left: `${cxPct}%`, top: `${cyPct}%` }}
              title={`#${nuc.id} (${nuc.area_um2} µm², circ ${nuc.circularity})`}
              className={`pointer-events-auto absolute z-30 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full px-1.5 py-0.5 font-mono text-2xs font-bold leading-none shadow-md transition-transform hover:scale-110 ${
                isActive
                  ? "bg-amber-400 text-slate-950 ring-2 ring-white"
                  : "bg-slate-950/85 text-sky-300 ring-1 ring-sky-400/60 hover:bg-sky-400 hover:text-slate-950"
              }`}
            >
              #{nuc.id}
            </button>
          );
        })}

      <div
        style={{
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: `${widthPct}%`,
          height: `${heightPct}%`,
          boxShadow: "0 0 0 9999px rgba(4, 6, 10, 0.65)",
        }}
        className="absolute cursor-move border border-sky-400 ring-1 ring-black/50"
        onPointerDown={(e) => startDrag("move", e)}
      >
        {/* Rule of thirds grid */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          <div className="border-b border-r border-white/25" />
          <div className="border-b border-r border-white/25" />
          <div className="border-b border-white/25" />
          <div className="border-b border-r border-white/25" />
          <div className="border-b border-r border-white/25" />
          <div className="border-b border-white/25" />
          <div className="border-r border-white/25" />
          <div className="border-r border-white/25" />
          <div />
        </div>

        {/* Center Crosshair */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-sky-300/70" />
          <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-sky-300/70" />
        </div>

        {/* Live Dimensions Readout Pill */}
        <div
          className={`pointer-events-none absolute left-1.5 top-1.5 flex flex-wrap items-center gap-1 rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-white shadow-md ring-1 ring-white/15 backdrop-blur-xs ${
            compact ? "text-2xs" : "text-2xs"
          }`}
        >
          <span className="font-semibold text-sky-300">
            {crop.w} × {crop.h} px
          </span>
          {!compact && umPerPixel > 0 && (
            <span className="text-white/70">
              ({formatUm(crop.w * umPerPixel)} × {formatUm(crop.h * umPerPixel)})
            </span>
          )}
        </div>

        {/* Live Adaptive Scale Bar inside the cropped region */}
        {scaleBar && umPerPixel > 0 && scaleUm > 0 && (
          <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col items-end rounded-md bg-black/85 px-2 py-1 shadow-md ring-1 ring-white/15">
            <span className="font-mono text-2xs font-medium leading-none text-white">
              {Number(scaleUm.toPrecision(6))} µm
            </span>
            <div
              className="mt-1 h-[3px] rounded-full bg-white"
              style={{ width: `${Math.max(24, Math.min(140, (scaleBarPct / 100) * 220))}px` }}
            />
          </div>
        )}

        {/* Corner & Edge Handles */}
        <div
          onPointerDown={(e) => startDrag("nw", e)}
          className="absolute -left-1.5 -top-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-xs border border-black/60 bg-sky-400 shadow-xs"
        />
        <div
          onPointerDown={(e) => startDrag("ne", e)}
          className="absolute -right-1.5 -top-1.5 h-3.5 w-3.5 cursor-nesw-resize rounded-xs border border-black/60 bg-sky-400 shadow-xs"
        />
        <div
          onPointerDown={(e) => startDrag("sw", e)}
          className="absolute -bottom-1.5 -left-1.5 h-3.5 w-3.5 cursor-nesw-resize rounded-xs border border-black/60 bg-sky-400 shadow-xs"
        />
        <div
          onPointerDown={(e) => startDrag("se", e)}
          className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-xs border border-black/60 bg-sky-400 shadow-xs"
        />
        <div
          onPointerDown={(e) => startDrag("n", e)}
          className="absolute -top-1 left-1/2 h-2 w-6 -translate-x-1/2 cursor-ns-resize rounded-full border border-black/60 bg-white/90"
        />
        <div
          onPointerDown={(e) => startDrag("s", e)}
          className="absolute -bottom-1 left-1/2 h-2 w-6 -translate-x-1/2 cursor-ns-resize rounded-full border border-black/60 bg-white/90"
        />
        <div
          onPointerDown={(e) => startDrag("w", e)}
          className="absolute -left-1 top-1/2 h-6 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border border-black/60 bg-white/90"
        />
        <div
          onPointerDown={(e) => startDrag("e", e)}
          className="absolute -right-1 top-1/2 h-6 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border border-black/60 bg-white/90"
        />
      </div>
    </div>
  );
}
