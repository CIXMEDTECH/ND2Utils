export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="4.2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="1.4" fill="currentColor" />
      <path
        d="M16 5v3.2M16 23.8V27M5 16h3.2M23.8 16H27"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}
