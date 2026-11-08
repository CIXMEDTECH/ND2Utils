export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect
        x="3.5"
        y="3.5"
        width="25"
        height="25"
        rx="7.5"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="16" cy="16" r="6.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
      <path
        d="M16 6.5v2.8M16 22.7v2.8M6.5 16h2.8M22.7 16h2.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
