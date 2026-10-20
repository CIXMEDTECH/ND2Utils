import type { ReactNode } from "react";

type Tone = "light" | "dark";
type Shape = "island" | "panel" | "card" | "chip" | "dock";

/** Translucent surface (see .liquid-glass in index.css). Static: no pointer tracking. */
export function Glass({
  children,
  className = "",
  tone = "light",
  shape = "card",
  as: Tag = "div",
  "aria-label": ariaLabel,
  "data-tour": dataTour,
}: {
  children: ReactNode;
  className?: string;
  tone?: Tone;
  shape?: Shape;
  as?: "div" | "header" | "aside" | "nav" | "section";
  "aria-label"?: string;
  "data-tour"?: string;
}) {
  return (
    <Tag
      className={`liquid-glass liquid-glass--${shape} liquid-glass--${tone} ${className}`}
      aria-label={ariaLabel}
      data-tour={dataTour}
    >
      {children}
    </Tag>
  );
}
