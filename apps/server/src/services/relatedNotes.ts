// Ranking for "related notes" — pure and DB-free, tested directly in Node
// like apps/web/src/lib/import-md.ts. NoteService.listRelated does the
// querying (candidate rows, vault-wide counts for the target's own signals)
// and calls rankRelated to turn that into a scored, ordered list.
//
// A signal is one shared tag or facet (key, value) pair between the target
// note and a candidate. Weighting by rarity — 1 / how many notes carry that
// signal, vault-wide — is what makes two notes sharing a tag only three notes
// use outrank two notes that both merely use a technology half the vault
// happens to use.

export interface SignalHit {
  /** The candidate note carrying this signal. */
  path: string;
  /** `tag:<tag>` or `facet:<key>:<value>` — opaque, just a join key. */
  signal: string;
}

export interface SignalCount {
  signal: string;
  /** How many notes, vault-wide, carry this signal. */
  count: number;
}

export interface RankedNote {
  path: string;
  score: number;
  signals: string[];
}

export function rankRelated(
  hits: readonly SignalHit[],
  counts: readonly SignalCount[],
  limit: number,
): RankedNote[] {
  const weightOf = new Map(counts.map((c) => [c.signal, 1 / Math.max(1, c.count)]));

  const byPath = new Map<string, { score: number; signals: string[] }>();
  for (const hit of hits) {
    const entry = byPath.get(hit.path) ?? { score: 0, signals: [] };
    entry.score += weightOf.get(hit.signal) ?? 0;
    entry.signals.push(hit.signal);
    byPath.set(hit.path, entry);
  }

  return [...byPath.entries()]
    .map(([path, v]) => ({ path, score: v.score, signals: v.signals }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** `tag:<tag>` — the SignalHit/SignalCount key for a shared tag. */
export function tagSignal(tag: string): string {
  return `tag:${tag}`;
}

/** `facet:<key>:<value>` — the SignalHit/SignalCount key for a shared facet. */
export function facetSignal(key: string, value: string): string {
  return `facet:${key}:${value}`;
}
