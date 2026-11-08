import { useCallback, useEffect, useRef, useState } from "react";
import { CornersOut, Minus, Plus } from "@phosphor-icons/react";
import { t } from "../i18n";
import { useApp } from "../store";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 12;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function isControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, a, input, select, textarea, label, [data-no-pan]"))
  );
}

export function ZoomStage({
  src,
  alt,
  children,
  media,
  mediaOverlay,
  mediaReady = false,
  mediaLoading,
  toolbarExtra,
}: {
  src: string | null;
  alt: string;
  children?: React.ReactNode;
  media?: React.ReactNode;
  mediaOverlay?: React.ReactNode;
  mediaReady?: boolean;
  mediaLoading?: boolean;
  toolbarExtra?: React.ReactNode;
}) {
  const lang = useApp((s) => s.lang);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(src));
  const [dragging, setDragging] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const currentRef = useRef({ zoom: 1, x: 0, y: 0 });
  const targetRef = useRef({ zoom: 1, x: 0, y: 0 });
  const rafRef = useRef<number>(0);

  const previewReady = mediaReady || Boolean(loadedSrc);
  const previewLoading = mediaLoading ?? loading;

  const stepAnimation = useCallback(() => {
    const cur = currentRef.current;
    const tgt = targetRef.current;
    const dz = tgt.zoom - cur.zoom;
    const dx = tgt.x - cur.x;
    const dy = tgt.y - cur.y;

    if (Math.abs(dz) < 0.0006 && Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15) {
      currentRef.current = { ...tgt };
      setZoom(tgt.zoom);
      setPan({ x: tgt.x, y: tgt.y });
      rafRef.current = 0;
      return;
    }

    const alpha = 0.32;
    const nextZoom = cur.zoom + dz * alpha;
    const nextX = cur.x + dx * alpha;
    const nextY = cur.y + dy * alpha;
    currentRef.current = { zoom: nextZoom, x: nextX, y: nextY };
    setZoom(nextZoom);
    setPan({ x: nextX, y: nextY });
    rafRef.current = requestAnimationFrame(stepAnimation);
  }, []);

  const scheduleAnimation = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(stepAnimation);
    }
  }, [stepAnimation]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const getMediaSize = useCallback((): { w: number; h: number } | null => {
    const root = contentRef.current;
    if (!root) return null;
    const canvas = root.querySelector("canvas");
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      return { w: canvas.width, h: canvas.height };
    }
    const img = root.querySelector("img");
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { w: img.naturalWidth, h: img.naturalHeight };
    }
    if (root.offsetWidth > 0 && root.offsetHeight > 0) {
      return { w: root.offsetWidth, h: root.offsetHeight };
    }
    return null;
  }, []);

  const computeFitZoom = useCallback((): number => {
    const stage = stageRef.current;
    const size = getMediaSize();
    if (!stage || !size || size.w <= 0 || size.h <= 0) return 1;
    const sw = Math.max(120, stage.clientWidth - 48);
    const sh = Math.max(120, stage.clientHeight - 96);
    return clampZoom(Math.min(sw / size.w, sh / size.h, 1.5));
  }, [getMediaSize]);

  const animateTo = useCallback(
    (nextZoom: number, nextX = 0, nextY = 0, immediate = false) => {
      const z = clampZoom(nextZoom);
      targetRef.current = { zoom: z, x: nextX, y: nextY };
      if (immediate) {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        currentRef.current = { zoom: z, x: nextX, y: nextY };
        setZoom(z);
        setPan({ x: nextX, y: nextY });
      } else {
        scheduleAnimation();
      }
    },
    [scheduleAnimation],
  );

  const fit = useCallback(
    (immediate = false) => {
      const z = computeFitZoom();
      animateTo(z, 0, 0, immediate);
    },
    [animateTo, computeFitZoom],
  );

  const zoomByFactor = useCallback(
    (factor: number, anchorX = 0, anchorY = 0) => {
      const prev = targetRef.current;
      const nextZoom = clampZoom(prev.zoom * factor);
      const ratio = nextZoom / prev.zoom;
      const nextX = anchorX - (anchorX - prev.x) * ratio;
      const nextY = anchorY - (anchorY - prev.y) * ratio;
      targetRef.current = { zoom: nextZoom, x: nextX, y: nextY };
      scheduleAnimation();
    },
    [scheduleAnimation],
  );

  useEffect(() => {
    if (!src) {
      setLoadedSrc(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const image = new Image();
    const commit = () => {
      if (cancelled) return;
      setLoadedSrc(src);
      setLoading(false);
    };
    image.onload = commit;
    image.onerror = () => {
      if (!cancelled) setLoading(false);
    };
    image.src = src;
    if (image.complete && image.naturalWidth > 0) commit();
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [src]);

  // Auto-fit when media first becomes ready
  useEffect(() => {
    if (!previewReady) return;
    const id = requestAnimationFrame(() => {
      fit(true);
    });
    return () => cancelAnimationFrame(id);
  }, [previewReady, loadedSrc, fit]);

  function endDrag() {
    drag.current = null;
    setDragging(false);
  }

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!previewReady) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
      const rawDelta = Math.max(-72, Math.min(72, event.deltaY * unit));
      // Gentle, fine-grained sensitivity for both mouse wheel and trackpad pinch
      const speed = event.ctrlKey ? 0.005 : 0.0013;
      const factor = Math.exp(-rawDelta * speed);
      const rect = element.getBoundingClientRect();
      const cx = event.clientX - (rect.left + rect.width / 2);
      const cy = event.clientY - (rect.top + rect.height / 2);
      zoomByFactor(factor, cx, cy);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [previewReady, zoomByFactor]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 border-b border-white/[0.07] bg-[#0b0e14]/90 px-3 py-1 text-[11px] text-white/65 backdrop-blur-md">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 font-medium transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => fit(false)}
          title={t(lang, "fit")}
        >
          <CornersOut size={13} />
          <span>{t(lang, "fit")}</span>
        </button>
        <button
          type="button"
          className="h-7 rounded-lg px-2 font-mono transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => animateTo(1, 0, 0)}
        >
          {t(lang, "oneToOne")}
        </button>
        <span className="mx-0.5 h-4 w-px bg-white/10" aria-hidden />
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => zoomByFactor(1 / 1.18)}
          aria-label={t(lang, "zoomOut")}
        >
          <Minus size={13} />
        </button>
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={Math.round((Math.log(zoom) / Math.log(MAX_ZOOM)) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            const next = v >= 0 ? Math.pow(MAX_ZOOM, v) : Math.pow(1 / MIN_ZOOM, v);
            const prev = targetRef.current;
            animateTo(next, prev.x, prev.y, true);
          }}
          aria-label={t(lang, "zoomLevel")}
          className="stage-zoom-slider hidden w-20 sm:block"
        />
        <span className="min-w-12 text-center font-mono text-[11px] tabular-nums text-white/80">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => zoomByFactor(1.18)}
          aria-label={t(lang, "zoomIn")}
        >
          <Plus size={13} />
        </button>
        {toolbarExtra && (
          <>
            <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
            <div className="flex flex-wrap items-center gap-1.5">{toolbarExtra}</div>
          </>
        )}
      </div>

      <div
        ref={stageRef}
        className={`stage-canvas-well relative min-h-0 flex-1 overflow-hidden bg-[var(--well)] ${
          previewReady ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
        onDoubleClick={(event) => {
          if (isControlTarget(event.target)) return;
          fit(false);
        }}
        onPointerDown={(event) => {
          if (!previewReady || event.button !== 0 || isControlTarget(event.target)) return;
          if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            px: currentRef.current.x,
            py: currentRef.current.y,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const nextX = drag.current.px + (event.clientX - drag.current.x);
          const nextY = drag.current.py + (event.clientY - drag.current.y);
          currentRef.current.x = nextX;
          currentRef.current.y = nextY;
          targetRef.current.x = nextX;
          targetRef.current.y = nextY;
          setPan({ x: nextX, y: nextY });
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {mediaReady && media ? (
          <div
            ref={contentRef}
            className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none will-change-transform"
            style={{
              transform: `translate(-50%, -50%) translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          >
            {media}
            {mediaOverlay}
          </div>
        ) : loadedSrc ? (
          <div
            ref={contentRef}
            className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none will-change-transform"
            style={{
              transform: `translate(-50%, -50%) translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          >
            <img
              src={loadedSrc}
              alt={alt}
              draggable={false}
              className="block max-h-none max-w-none select-none"
            />
            {mediaOverlay}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-[13px] leading-5 text-white/40">
            {t(lang, src || mediaLoading ? "previewLoading" : "noneSelected")}
          </div>
        )}

        {previewLoading && (
          <div role="status" className="pointer-events-none absolute right-3 top-3 z-10">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/70 px-3 py-1.5 font-mono text-[11px] text-white/75 shadow-lg backdrop-blur-md">
              <span className="spinner h-3 w-3 border-white/25 border-t-[var(--accent)]" />
              {t(lang, "previewLoading")}
            </div>
          </div>
        )}

        {children ? (
          <div
            data-no-pan
            className="pointer-events-none absolute inset-0 z-20 select-none [&>*]:pointer-events-auto"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
