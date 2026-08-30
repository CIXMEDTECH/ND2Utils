import type { PointerEvent, ReactNode } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";

export function Magnetic({
  children,
  className = "",
  strength = 12,
}: {
  children: ReactNode;
  className?: string;
  strength?: number;
}) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 320, damping: 18, mass: 0.35 });
  const sy = useSpring(y, { stiffness: 320, damping: 18, mass: 0.35 });

  function onMove(event: PointerEvent<HTMLDivElement>) {
    if (reduce) return;
    const box = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    x.set((dx / box.width) * strength);
    y.set((dy / box.height) * strength);
  }

  return (
    <motion.div
      className={className}
      style={{ x: reduce ? 0 : sx, y: reduce ? 0 : sy }}
      onPointerMove={onMove}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}
