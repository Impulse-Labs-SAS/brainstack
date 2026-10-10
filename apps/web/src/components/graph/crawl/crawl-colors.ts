// The colours a crawl is drawn in, one per reason a note was handed over: the
// same hex in the threads, the halos, the labels, the panel's log and the
// legend, so a colour on the canvas reads as the word beside it in the panel.
// Pure and tiny, so the view can import it without pulling in what draws.

export const CRAWL_COLORS = {
  named: '#b8a6ff',
  linked: '#5eead4',
  decision: '#4ade80',
  ask: '#fbbf24',
} as const;

/** `#rrggbb` at opacity `a`, as a canvas colour string. */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
