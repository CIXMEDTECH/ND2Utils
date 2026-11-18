import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { t } from "../i18n";
import { detailMessage, fileExtension } from "../lib/format";
import { useApp } from "../store";

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  width = 440,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const lang = useApp((s) => s.lang);
  const panelRef = useRef<HTMLDivElement>(null);
  // Callers usually pass an inline onClose; keep the latest one without re-running the open
  // effect (which would steal focus back to the first field on every parent re-render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    // Focus the first field (or the panel) so keyboard users land inside the dialog.
    requestAnimationFrame(() => {
      const field = panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button[data-autofocus]");
      (field ?? panelRef.current)?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-3 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ maxWidth: width }}
        className="liquid-glass liquid-glass--card flex max-h-[min(88dvh,820px)] w-full flex-col bg-[var(--bg-elev)] focus:outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-md font-semibold tracking-[-0.02em]">{title}</h2>
            {subtitle && <div className="mt-1 text-sm leading-5 text-[var(--text-dim)]">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} className="icon-action -mr-1.5 -mt-1 shrink-0" aria-label={t(lang, "close")}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Small "enter a name" dialog used for new folder / rename. */
export function NameDialog({
  open,
  title,
  label,
  initial,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open, initial]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const clean = value.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(clean);
      onClose();
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={title} onClose={onClose} width={400}>
      <form onSubmit={(event) => void submit(event)} className="grid gap-3">
        <label className="grid gap-1.5 text-xs font-medium text-[var(--text-dim)]">
          {label}
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => {
              const ext = fileExtension(event.target.value);
              const dot = ext ? event.target.value.length - ext.length : event.target.value.length;
              event.target.setSelectionRange(0, dot);
            }}
            className="h-10 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 text-base text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm leading-5 text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
            {t(lang, "cancel")}
          </button>
          <button type="submit" disabled={busy || !value.trim()} className="h-9 rounded-lg bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-40">
            {t(lang, "save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Confirmation for destructive actions. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={title} onClose={onClose} width={400}>
      <div className="text-base leading-6 text-[var(--text-dim)]">{body}</div>
      {error && (
        <p role="alert" className="mt-3 text-sm leading-5 text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" data-autofocus onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-[var(--text-dim)] hover:bg-[var(--bg)]">
          {t(lang, "cancel")}
        </button>
        <button type="button" disabled={busy} onClick={() => void confirm()} className="h-9 rounded-lg bg-[var(--danger)] px-4 text-sm font-semibold text-white disabled:opacity-40">
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
