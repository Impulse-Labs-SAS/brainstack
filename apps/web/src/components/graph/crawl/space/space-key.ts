// What the dormant network's layout reads of a model, as one short string.
// The graph builds a new model whenever anything changes — a title edited, a
// layer toggled, a share's notes polled in — and laying the cluster out again
// is the expensive part of the Sentinel view, which also starts a walk over
// from its first note. So the view compares keys and builds again only when
// the layout would come out different.
//
// It reads exactly what volume/layout.ts, the crystals' tints and the
// threads' tints read: each note's id, vault, project, path (its folders),
// whether it is an index, and when it was made (the oldest note leads a
// folder); each vault's colour; each walkable thread, its kind and the vault
// it is tinted by. Never positions, titles, edit dates, topics, affinity or
// weights, none of which the cluster reads; nor decisions, which reach a built
// space on their own (`setDecisions`), with no build.

import type { GraphModel } from '@/lib/graph-model';

import { walkable } from '../crawl-plan';
import { threadKey } from '../threads';

/** Between the fields of one entry; no id, path or label holds it. */
const FIELD = '\u0001';
/** Between entries. */
const ENTRY = '\u0002';

/**
 * The key of what the cluster's layout reads of `model`: a model built again
 * with the same key lays out exactly as before, so the space is not built
 * again. Notes and threads counted, then a hash of the rest. Pure.
 */
export function spaceKey(model: GraphModel): string {
  const notes = model.nodes
    .filter((n) => n.kind === 'note')
    .map((n) =>
      [
        n.id,
        n.vault,
        n.project?.id ?? '',
        n.project?.label ?? '',
        n.path,
        n.isIndex ? '1' : '0',
        String(n.createdAt),
      ].join(FIELD),
    )
    .sort();
  const vaults = model.vaults.map((v) => `${v.id}${FIELD}${v.color.hue}`).sort();
  // One per pair, the first the model lists, as the threads' tints take it.
  const threads = new Map<string, string>();
  for (const e of model.edges) {
    if (!walkable(e) || e.source.id === e.target.id) continue;
    const key = threadKey(e.source, e.target);
    if (!threads.has(key)) threads.set(key, `${key}${FIELD}${e.kind}${FIELD}${e.source.vault}`);
  }
  const lines = [...threads.values()].sort();
  const text = [notes.join(ENTRY), vaults.join(ENTRY), lines.join(ENTRY)].join('\n');
  return `${notes.length}:${lines.length}:${cyrb53(text)}`;
}

/** A 53-bit hash of `text`, as base 36: two keys that differ almost never meet. */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
