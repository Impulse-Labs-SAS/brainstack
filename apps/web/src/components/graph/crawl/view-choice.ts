// Which view /graph opens on. The toolbar picks one of four: the three
// layouts and the Sentinel, which is no layout of its own — under it the
// engine shows the brain — so a choice is a layout or 'sentinel'. Pure and
// tiny: with crawl-colors.ts, the only module of crawl/ the view imports
// up front, so the Brain, Network and Territories never load the Sentinel.
//
// The Sentinel is the default. A choice is remembered only when somebody
// makes it — a tab or a key — under a key of its own: the old key was written
// on every visit, chosen or not, so nearly every browser that ever opened the
// graph holds a Brain nobody picked. Of that key only Network and Territories
// count, since reaching them took a pick (or a browser without WebGL, which
// opens there anyway).

import { GRAPH_VIEWS, type GraphView } from '@/lib/graph-model';

export type ViewChoice = GraphView | 'sentinel';

/** Where a pick is remembered. */
export const CHOICE_KEY = 'brainstack.graph.choice';
/** Where the view used to be remembered, picked or not. Read, never written. */
export const LEGACY_VIEW_KEY = 'brainstack.graph.view';

const CHOICES: readonly string[] = [...GRAPH_VIEWS, 'sentinel'];

/** `'#brain'` … `'#sentinel'`; the old `'#crawl'` is the Sentinel. Anything else: null. */
export function choiceFromHash(hash: string): ViewChoice | null {
  const name = hash.startsWith('#') ? hash.slice(1) : hash;
  return name === 'crawl' ? 'sentinel' : storedChoice(name);
}

/** A remembered value, if it is a choice at all. */
export function storedChoice(value: unknown): ViewChoice | null {
  return typeof value === 'string' && CHOICES.includes(value) ? (value as ViewChoice) : null;
}

/** What a browser remembers choosing: the new key's, else a Network or Territories the old key held. */
export function rememberedChoice(choice: unknown, legacyView: unknown): ViewChoice | null {
  const chosen = storedChoice(choice);
  if (chosen) return chosen;
  return legacyView === 'network' || legacyView === 'territories' ? legacyView : null;
}

/** Hash, else the stored choice, else the Sentinel. The Sentinel and Brain need WebGL; Network stands in. */
export function openingView(
  hash: string,
  stored: unknown,
  webgl: boolean,
): { view: GraphView; sentinel: boolean } {
  const choice = choiceFromHash(hash) ?? storedChoice(stored) ?? 'sentinel';
  if (!webgl && (choice === 'sentinel' || choice === 'brain')) {
    return { view: 'network', sentinel: false };
  }
  return choice === 'sentinel'
    ? { view: 'brain', sentinel: true }
    : { view: choice, sentinel: false };
}
