import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separated?: boolean;
  onSelect: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const box = ref.current.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(menu.x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(menu.y, window.innerHeight - box.height - margin)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof MouseEvent && ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowDown") {
        event.preventDefault();
        buttons[(index + 1) % buttons.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={menu.title}
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      className="liquid-glass liquid-glass--chip fixed z-[60] min-w-[200px] max-w-[280px] origin-top-left bg-[var(--bg-elev)] p-1 text-[12.5px] shadow-[var(--shadow)]"
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.title && (
        <p className="truncate px-2.5 pb-1.5 pt-1 font-mono text-[10px] text-[var(--text-dim)]" title={menu.title}>
          {menu.title}
        </p>
      )}
      {menu.items.map((item) => (
        <div key={item.key}>
          {item.separated && <div className="mx-2 my-1 h-px bg-[var(--line)]" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus:outline-none disabled:opacity-40 ${
              item.danger
                ? "text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] focus:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]"
                : "text-[var(--text)] hover:bg-[var(--accent-soft)] focus:bg-[var(--accent-soft)]"
            }`}
          >
            <span className="flex w-4 shrink-0 justify-center text-current opacity-80">{item.icon}</span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
