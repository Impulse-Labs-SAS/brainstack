// What the Sentinel panel makes of a search: the answer as gather_context gave
// it, or as the history kept it, and what the person did with it — notes taken
// out, references settled, notes the budget left out put back. From the two,
// the rows the panel lists and the notes and questions the brief carries.
// Pure, tested directly.
//
// Every note is keyed by where it is (`place`): a path in the viewer's own
// vault, or a path and its owner for a note in a folder somebody shared —
// the same key the replay names the notes it reached by.

import type { BriefNote, BriefQuestion } from './brief';
import { place, type CrawlResult, type ReachKind } from './crawl-plan';

type Via = CrawlResult['notes'][number]['via'];

/** A note the budget left out, as the engine lists it: no body, one line on why it was a candidate. */
interface LeftOutSource {
  path: string;
  ownerId?: string;
  title: string;
  reason: string;
}

/**
 * What a search hands the panel. gather_context's answer carries each note's
 * reason and excerpt, and the notes left out; the history keeps the replay
 * alone, and, since it began keeping them, the notes left out.
 */
export interface AnswerSource extends CrawlResult {
  notes: Array<
    CrawlResult['notes'][number] & { reason?: string; excerpt?: string; truncated?: boolean }
  >;
  leftOut?: readonly LeftOutSource[];
  budget?: { notesLeftOut: number };
  notesLeftOut?: number;
}

export interface AnswerNote {
  key: string;
  path: string;
  ownerId?: string;
  title: string;
  isDecision: boolean;
  /** The colour it lights in, as the replay reaches it. */
  kind: ReachKind;
  reason: string;
  /** Its body as the answer carried it; the history keeps none. */
  excerpt?: string;
  truncated?: boolean;
}

export interface Candidate {
  key: string;
  path: string;
  ownerId?: string;
  title: string;
}

export interface Unresolved {
  term: string;
  reason: 'no-match' | 'ambiguous';
  candidates: Candidate[];
}

export interface LeftOut extends Candidate {
  reason: string;
  /** The colour its reason implies: linked, or what the text led to. */
  kind: ReachKind;
}

export interface Answer {
  question: string;
  notes: AnswerNote[];
  unresolved: Unresolved[];
  leftOut: LeftOut[];
  /** Notes the budget left out in all: `leftOut` may list fewer, and the history may list none. */
  leftOutCount: number;
  coverage: { resolved: number; total: number };
}

/** Why a note is here, as the engine says it (`describeVia`): the history keeps no reason, only `via`. */
export function reasonOf(via: Via): string {
  switch (via.kind) {
    case 'named':
      return via.count > 1 ? `the text says "${via.text}" (${via.count}×)` : `the text says "${via.text}"`;
    case 'search':
      return `matches "${via.term}"`;
    case 'prompt':
      return 'matches the question';
    case 'linked':
      return via.direction === 'out' ? `linked from ${via.fromTitle}` : `links to ${via.fromTitle}`;
  }
}

/** The colour the replay lights a note in: what the text led to, else a decision or a link. */
export function kindOf(n: { via: Via; isDecision: boolean }): ReachKind {
  if (n.via.kind !== 'linked') return 'named';
  return n.isDecision ? 'decision' : 'linked';
}

/** For a note the engine left out, the colour its reason implies. */
function kindOfReason(reason: string): ReachKind {
  return /^link(ed|s) /.test(reason) ? 'linked' : 'named';
}

const placed = (p: { path: string; ownerId?: string }) => ({
  key: place(p.path, p.ownerId),
  path: p.path,
  ...(p.ownerId ? { ownerId: p.ownerId } : {}),
});

export function answerOf(question: string, src: AnswerSource): Answer {
  const leftOut = (src.leftOut ?? []).map((l) => ({
    ...placed(l),
    title: l.title,
    reason: l.reason,
    kind: kindOfReason(l.reason),
  }));
  return {
    question,
    notes: src.notes.map((n) => ({
      ...placed(n),
      title: n.title,
      isDecision: n.isDecision,
      kind: kindOf(n),
      reason: n.reason ?? reasonOf(n.via),
      ...(n.excerpt !== undefined ? { excerpt: n.excerpt, truncated: n.truncated === true } : {}),
    })),
    unresolved: src.unresolved.map((u) => ({
      term: u.term,
      reason: u.reason,
      candidates: (u.candidates ?? []).map((c) => ({ ...placed(c), title: c.title })),
    })),
    leftOut,
    leftOutCount: Math.max(leftOut.length, src.budget?.notesLeftOut ?? src.notesLeftOut ?? 0),
    coverage: src.coverage,
  };
}

/**
 * How to tell apart the notes a reference could mean: each path cut to its
 * last segments, as few as no other candidate ends in — the file's name when
 * two share a folder, its folders too when two share a name. They share a
 * title by definition, so the title says nothing.
 */
export function candidateLabels(paths: readonly string[]): string[] {
  const parts = paths.map((p) => p.split('/'));
  return parts.map((segs, i) => {
    for (let k = 1; k < segs.length; k++) {
      const tail = segs.slice(-k).join('/');
      if (parts.every((other, j) => j === i || other.slice(-k).join('/') !== tail)) return tail;
    }
    return segs.join('/');
  });
}

// -- What the person did with it ------------------------------------------------------

/** A reference settled: the candidates meant (one, or every one), or none, to leave it out. */
export type Settled = readonly string[] | 'none';

export interface Curation {
  /** Notes of the answer taken out of the brief. */
  out: ReadonlySet<string>;
  /** By term. A term absent is still open: the brief asks the assistant to ask. */
  settled: ReadonlyMap<string, Settled>;
  /** Notes the budget left out, put back. */
  added: ReadonlySet<string>;
}

export const NO_CURATION: Curation = { out: new Set(), settled: new Map(), added: new Set() };

/** Every note in `keys` in the brief, or every one out. */
export function setNotes(c: Curation, keys: readonly string[], on: boolean): Curation {
  const out = new Set(c.out);
  for (const k of keys) {
    if (on) out.delete(k);
    else out.add(k);
  }
  return { ...c, out };
}

/**
 * A term settled as `choice`, or opened again with null. A note picked is in
 * the brief, even one of the answer's the person had taken out: the card
 * says it is used, so the prompt must carry it.
 */
export function settle(c: Curation, term: string, choice: Settled | null): Curation {
  const settled = new Map(c.settled);
  if (choice === null) settled.delete(term);
  else settled.set(term, choice);
  if (!Array.isArray(choice)) return { ...c, settled };
  const out = new Set(c.out);
  for (const k of choice) out.delete(k);
  return { ...c, settled, out };
}

export function setAdded(c: Curation, key: string, on: boolean): Curation {
  const added = new Set(c.added);
  if (on) added.add(key);
  else added.delete(key);
  return { ...c, added };
}

// -- What the panel lists, and what the brief carries ------------------------------

export interface Row {
  key: string;
  path: string;
  ownerId?: string;
  title: string;
  kind: ReachKind;
  isDecision: boolean;
  reason: string;
  /** In the brief. */
  on: boolean;
  /** From the answer; meant by a reference settled (`term`); or put back from what did not fit. */
  from: 'answer' | 'settled' | 'added';
  term?: string;
  excerpt?: string;
  truncated?: boolean;
}

/**
 * The notes the panel lists, in the answer's order and then the person's
 * additions. With `reached`, only the answer's notes the walk has reached so
 * far: the list fills as the Sentinel finds them. Null lists them all.
 */
export function rowsOf(a: Answer, c: Curation, reached: ReadonlySet<string> | null = null): Row[] {
  const rows: Row[] = [];
  const keys = new Set<string>();
  for (const n of a.notes) {
    keys.add(n.key);
    if (reached && !reached.has(n.key)) continue;
    rows.push({ ...n, on: !c.out.has(n.key), from: 'answer' });
  }
  for (const u of a.unresolved) {
    const s = c.settled.get(u.term);
    if (!s || s === 'none') continue;
    for (const cand of u.candidates) {
      if (!s.includes(cand.key) || keys.has(cand.key)) continue;
      keys.add(cand.key);
      rows.push({
        ...cand,
        kind: 'named',
        isDecision: false,
        reason: `you picked it for "${u.term}"`,
        on: true,
        from: 'settled',
        term: u.term,
      });
    }
  }
  for (const l of a.leftOut) {
    if (!c.added.has(l.key) || keys.has(l.key)) continue;
    keys.add(l.key);
    rows.push({ ...l, isDecision: false, on: true, from: 'added' });
  }
  return rows;
}

/** The notes the brief carries, bodies included where the answer had them. */
export function chosenNotes(a: Answer, c: Curation): BriefNote[] {
  return rowsOf(a, c)
    .filter((r) => r.on)
    .map((r) => ({
      path: r.path,
      ...(r.ownerId ? { ownerId: r.ownerId } : {}),
      title: r.title,
      isDecision: r.isDecision,
      reason: r.reason,
      ...(r.excerpt !== undefined ? { body: r.excerpt, truncated: r.truncated === true } : {}),
    }));
}

/** The references still open: the brief tells the assistant to ask about each. */
export function openQuestions(a: Answer, c: Curation): BriefQuestion[] {
  return a.unresolved
    .filter((u) => !c.settled.has(u.term))
    .map((u) => ({
      term: u.term,
      reason: u.reason,
      ...(u.candidates.length > 0
        ? {
            candidates: u.candidates.map((cand) => ({
              path: cand.path,
              ...(cand.ownerId ? { ownerId: cand.ownerId } : {}),
              title: cand.title,
            })),
          }
        : {}),
    }));
}
