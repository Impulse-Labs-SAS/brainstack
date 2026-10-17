// Which style the graph is drawn in. The classic style draws every view; line art, while it is
// built a view at a time, draws only the views in LINEART_VIEWS and leaves the rest classic.
// Chosen by `?style=` on the URL, which wins, then by what was stored; classic otherwise. Pure.

import type { GraphView } from '@/lib/graph-model';

export type GraphStyle = 'classic' | 'lineart';

export const STYLE_KEY = 'brainstack.graph.style';

/** The views line art draws so far. */
export const LINEART_VIEWS: readonly GraphView[] = ['territories', 'network'];

const isStyle = (v: unknown): v is GraphStyle => v === 'classic' || v === 'lineart';

/** The style from a query string (`?style=lineart`) and a stored preference, in that order. */
export function graphStyle(search: string, stored: unknown): GraphStyle {
  const asked = new URLSearchParams(search).get('style')?.trim();
  if (isStyle(asked)) return asked;
  return isStyle(stored) ? stored : 'classic';
}
