import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "@phosphor-icons/react";
import { t } from "../i18n";
import { useApp } from "../store";

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
  mediaReady = false,
  mediaLoading,
}: {
  src: string | null;
  alt: string;
  children?: React.ReactNode;
  media?: React.ReactNode;
  mediaReady?: boolean;
  mediaLoading?: boolean;
}) {
  const lang = useApp((s) => s.lang);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(src));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const previewReady = mediaReady || Boolean(loadedSrc);
  const previewLoading = mediaLoading ?? loading;

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

  function setClampedZoom(next: number) {
    const value = Math.min(8, Math.max(0.2, next));
    zoomRef.current = value;
    setZoom(value);
  }

  function fit() {
    setClampedZoom(1);
    setPan({ x: 0, y: 0 });
  }

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
      setClampedZoom(zoomRef.current * (event.deltaY > 0 ? 0.9 : 1.1));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [previewReady]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 items-center gap-1.5 border-b border-white/[0.06] bg-black/20 px-3 text-[11px] text-white/58">
        <button type="button" className="rounded-lg px-2 py-1.5 transition-colors hover:bg-white/10 hover:text-white" onClick={fit}>
          {t(lang, "fit")}
        </button>
        <button
          type="button"
          className="rounded-lg px-2 py-1.5 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => setClampedZoom(1)}
        >
          {t(lang, "oneToOne")}
        </button>
        <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => setClampedZoom(zoom - 0.2)}
          aria-label={t(lang, "zoomOut")}
        >
          <Minus size={13} />
        </button>
        <span className="min-w-11 text-center font-mono tabular-nums text-white/70">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => setClampedZoom(zoom + 0.2)}
          aria-label={t(lang, "zoomIn")}
        >
          <Plus size={13} />
        </button>
      </div>

      <div
        ref={stageRef}
        className={`relative min-h-0 flex-1 overflow-hidden bg-[var(--well)] ${previewReady ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""}`}
        onDoubleClick={(event) => {
          if (isControlTarget(event.target)) return;
          fit();
        }}
        onPointerDown={(event) => {
          if (!previewReady || event.button !== 0 || isControlTarget(event.target)) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setPan({
            x: drag.current.px + (event.clientX - drag.current.x),
            y: drag.current.py + (event.clientY - drag.current.y),
          });
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {mediaReady && media ? (
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none will-change-transform"
            style={{
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          >
            {media}
          </div>
        ) : loadedSrc ? (
          <img
            src={loadedSrc}
            alt={alt}
            draggable={false}
            className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none will-change-transform"
            style={{
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-[13px] leading-5 text-white/38">
            {t(lang, src || mediaLoading ? "previewLoading" : "noneSelected")}
          </div>
        )}

        {previewLoading && (
          <div role="status" className="pointer-events-none absolute right-3 top-3 z-10">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-2 font-mono text-[11px] text-white/65">
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
