// What a crawl replay looks like from outside: the contract between the replay
// (crawl-replay.ts), which decides where the walk is and which threads are
// held and lit, and whatever draws it — the light trail, or the Sentinel.
//
// Everything is named by id and thread key, never by graph object, so it
// survives the graph being rebuilt mid-crawl, and the Sentinel never needs to
// know what a GraphModel is.

import type { ReachKind } from './crawl-plan';
import type { LegStretch, ThreadField, ThreadKey } from './threads';
import type { Vec3 } from './vec';

/** A thread the crawl has touched: it glows when touched and fades to a floor it keeps. */
export interface Lit {
  glow: number;
  floor: number;
  kind: 'walk' | ReachKind;
}

/** One stretch of the current walk: along a thread (`key`), or across the void (`key` null). */
export type LegSegment = LegStretch;

export interface WalkLeg {
  segments: readonly LegSegment[];
  /** World units. */
  total: number;
  /** Seconds the leg takes. */
  duration: number;
  /** Seconds into the leg. */
  t: number;
  /** World units travelled along it, the replay's cursor. */
  travelled: number;
  /** No thread joins the two notes: the leg crosses the void. */
  void: boolean;
}

/** What a grip slot holds: a thread, and where along it, from the key's first id. */
export interface Hold {
  key: ThreadKey;
  u: number;
  /** Replay clock when it landed. */
  since: number;
}

/** A grip moving from one hold to the next: it lands — and lights its thread — at `land`. */
export interface Swing {
  slot: number;
  from: Hold | null;
  to: Hold | null;
  /** Replay clock. */
  start: number;
  land: number;
}

/** Reaching out, while dwelling, to a note just read — or into the void, for a reference nothing settled. */
export interface Reach {
  nodeId: string | null;
  /** Where it reaches when there is no note: the void. */
  point: Vec3 | null;
  kind: ReachKind | 'ask';
  /** Replay clock when it sets out; it touches 0.4 s later. */
  start: number;
  reached: boolean;
}

export type ReplayEvent =
  | { kind: 'begin'; clock: number; stepIndex: number; nextId: string | null }
  | { kind: 'arrive'; clock: number; nodeId: string }
  | { kind: 'grip'; clock: number; slot: number; key: ThreadKey; u: number }
  | { kind: 'release'; clock: number; slot: number; key: ThreadKey }
  | { kind: 'found'; clock: number; nodeId: string; reachKind: ReachKind }
  /** A crossing of the void touched the note on the far side. */
  | { kind: 'contact'; clock: number; nodeId: string }
  | { kind: 'done'; clock: number };

export interface ReplayView {
  mode: 'idle' | 'walk' | 'dwell' | 'done';
  /** Seconds since the replay started, advanced only while playing. */
  clock: number;
  /** World units per creature unit: the vault's typical link. */
  unit: number;
  stepIndex: number;
  /** The note it stands on, or last left. */
  hereId: string | null;
  /** Where the next leg goes, known while dwelling: the eye looks there before it moves. */
  nextId: string | null;
  /** Heading of the walk, world space, unit length. */
  dir: Vec3;
  walk: WalkLeg | null;
  dwell: { t: number; duration: number } | null;
  /** One per grip slot (anatomy GRIP_SLOTS): what it holds now. */
  holds: readonly (Hold | null)[];
  /** Grips on their way to a new hold. */
  swings: readonly Swing[];
  reaches: readonly Reach[];
  lit: ReadonlyMap<ThreadKey, Lit>;
  /** Notes handed over, by id. */
  found: ReadonlyMap<string, ReachKind>;
  /** The threads and notes it walks over. */
  field: ThreadField;
}
