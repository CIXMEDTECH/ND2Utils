import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ArrowCounterClockwise, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { t } from "../i18n";
import { undoLastMove, useMoveToast } from "../lib/moves";
import { useApp } from "../store";

/** Result of the last move, with Undo; hides itself after a while. */
export function MoveToast() {
  const lang = useApp((s) => s.lang);
  const toast = useMoveToast((s) => s.toast);
  const dismiss = useMoveToast((s) => s.dismiss);

  useEffect(() => {
    if (!toast) return;
    const handle = window.setTimeout(dismiss, toast.undo ? 10_000 : 5_000);
    return () => window.clearTimeout(handle);
  }, [dismiss, toast]);

  if (!toast) return null;
  return createPortal(
    <div
      role="status"
      className="fade-in fixed bottom-5 left-1/2 z-[70] flex max-w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--bg-elev)] px-4 py-3 text-sm shadow-[var(--shadow)]"
    >
      {toast.error ? (
        <WarningCircle size={18} weight="fill" className="shrink-0 text-[var(--danger)]" />
      ) : (
        <CheckCircle size={18} weight="fill" className="shrink-0 text-[var(--ok)]" />
      )}
      <span className="min-w-0 truncate">{toast.text}</span>
      {toast.undo && (
        <button
          type="button"
          onClick={() => void undoLastMove(toast.undo!)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          <ArrowCounterClockwise size={15} />
          {t(lang, "undo")}
        </button>
      )}
      <button type="button" onClick={dismiss} className="shrink-0 text-[var(--text-dim)] hover:text-[var(--text)]" aria-label={t(lang, "close")}>
        <X size={14} />
      </button>
    </div>,
    document.body,
  );
}
