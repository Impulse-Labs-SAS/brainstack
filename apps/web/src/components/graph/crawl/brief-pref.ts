// The format the Sentinel's prompt is copied in, remembered per browser:
// references for an assistant connected to BrainStack, full text for any
// other. Whoever uses one kind of assistant keeps choosing the same. A blocked
// or private store means references: the default, and the shorter paste.

import type { BriefFormat } from './brief';

/** What the choice reads and writes: `localStorage`, or a fake in a test. */
export type BriefFormatStore = Pick<Storage, 'getItem' | 'setItem'>;

const KEY = 'brainstack.graph.sentinel.brief';

export function readBriefFormat(store: BriefFormatStore | null): BriefFormat {
  try {
    return store?.getItem(KEY) === 'full' ? 'full' : 'refs';
  } catch {
    return 'refs';
  }
}

export function writeBriefFormat(store: BriefFormatStore | null, format: BriefFormat): void {
  try {
    store?.setItem(KEY, format);
  } catch {
    // storage blocked or full: the choice holds for this visit
  }
}
