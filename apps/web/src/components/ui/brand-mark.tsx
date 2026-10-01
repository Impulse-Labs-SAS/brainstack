/**
 * The BrainStack mark ("Pliegue"): one line folded into three layers, ending in a node.
 * Drawn on a 48-unit grid with a 6-unit stroke, so it is pixel-sharp at 16, 32 and 48 px.
 * The line follows `currentColor`; the node is the accent.
 */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={className}
    >
      <path
        d="M9 12H33A6 6 0 0 1 33 24H15A6 6 0 0 0 15 36H24"
        fill="none"
        stroke="currentColor"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <circle cx="37.5" cy="36" r="4.5" className="fill-accent" />
    </svg>
  );
}
