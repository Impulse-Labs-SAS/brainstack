// The Sentinel switch, remembered per browser: whether the creature is drawn
// or the walk shows as light alone. It used to be the spider's switch, under
// another key; a choice made there carries over once, so whoever turned the
// spider off does not find the Sentinel on. A blocked or private store means
// on: the default, and nothing worse than a creature nobody asked to hide.

/** What the switch reads and writes: `localStorage`, or a fake in a test. */
export type PrefStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY = 'brainstack.graph.sentinel';
const OLD = 'brainstack.graph.spider';

/** Whether the creature is drawn. The spider switch's choice carries over once: off stays off. */
export function readSentinelPref(store: PrefStore | null): boolean {
  if (!store) return true;
  let old: string | null;
  try {
    const value = store.getItem(KEY);
    if (value !== null) return value !== 'off';
    old = store.getItem(OLD);
  } catch {
    return true;
  }
  if (old === null) return true;
  try {
    // Moved, not copied: the old key would otherwise outlive every later choice.
    store.setItem(KEY, old);
    store.removeItem(OLD);
  } catch {
    // a store that reads but will not write: the old choice is read again next visit
  }
  return old !== 'off';
}

export function writeSentinelPref(store: PrefStore | null, on: boolean): void {
  try {
    store?.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked or full: the choice holds for this visit
  }
}
