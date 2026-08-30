import type { PointerEvent, ReactNode } from "react";
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring } from "motion/react";

type Tone = "light" | "dark";
type Shape = "island" | "panel" | "card" | "chip" | "dock";

export function Glass({
  children,
  className = "",
  tone = "light",
  shape = "card",
  specular = true,
  as: Tag = "div",
  "aria-label": ariaLabel,
  "data-tour": dataTour,
}: {
  children: ReactNode;
  className?: string;
  tone?: Tone;
  shape?: Shape;
  specular?: boolean;
  as?: "div" | "header" | "aside" | "nav" | "section";
  "aria-label"?: string;
  "data-tour"?: string;
}) {
  const reduce = useReducedMotion();
  const x = useMotionValue(22);
  const y = useMotionValue(8);
  const sx = useSpring(x, { stiffness: 140, damping: 22, mass: 0.35 });
  const sy = useSpring(y, { stiffness: 140, damping: 22, mass: 0.35 });
  const sheen = useMotionTemplate`radial-gradient(520px circle at ${sx}% ${sy}%, rgb(255 255 255 / ${tone === "dark" ? 0.22 : 0.42}), transparent 42%)`;

  function onMove(event: PointerEvent<HTMLElement>) {
    if (reduce || !specular) return;
    const box = event.currentTarget.getBoundingClientRect();
    x.set(((event.clientX - box.left) / Math.max(box.width, 1)) * 100);
    y.set(((event.clientY - box.top) / Math.max(box.height, 1)) * 100);
  }

  const MotionTag = motion[Tag];

  return (
    <MotionTag
      className={`liquid-glass liquid-glass--${shape} liquid-glass--${tone} ${className}`}
      aria-label={ariaLabel}
      data-tour={dataTour}
      onPointerMove={onMove}
    >
      {specular && !reduce ? (
        <motion.span className="liquid-glass-sheen" style={{ background: sheen }} aria-hidden />
      ) : null}
      {children}
    </MotionTag>
  );
}
