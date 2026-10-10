// What the dormant network has been through, as the two float textures its
// shaders read: one texel per note, two per thread, each holding *when*
// something happened on the replay's clock — never how bright it is. The
// shaders turn the time since into light, so a note flares and settles, a
// trail cools behind the walk, without a byte uploaded while it does. Pure:
// the textures' contents and the spans to upload are tested in Node, and the
// GPU side (dormant-network.ts) copies them up as they are.
//
// Everything comes from the replay's history (replay-view.ts), stamped exactly
// as the crawl was planned: the threads gone along, the notes reached, the
// notes found. So the network lights the same at any frame rate and after a
// jump to the end. A frame writes only what is new in the history since the
// last; at rest — paused, done, or between two stamps — nothing is written
// and nothing is uploaded.
//
// The walk's own progress along the thread it is on, and the note it is
// reading, change every frame: those travel as uniforms (`head`, `read`),
// never through a texture. The one thing taken from the live view is when a
// grip last closed on a thread, so the filament it holds can flash; a grip is
// a stamp too, written once when it lands.
//
// Layouts, as RGBA floats:
//
//   note     (reached, found, why, 0)
//   thread   (enter, leave, way, gripped) (offset, length, again, grip)
//
//  - reached: when the walk first reached the note; found: when it was handed
//    over; why: 1 named, 2 linked, 3 decision, 0 not found.
//  - enter, leave: the latest passage along the thread. way: + when it went
//    from the key's first note to its second, − the other way, its size
//    1 + why (1 for a walk); 0 never gone along. gripped: when the last grip
//    closed on it, and grip: where, 0–1 from the key's first note.
//  - offset: trail walked before it, so pulses flow on unbroken from thread to
//    thread; length: the thread's, world units; again: 1 when an earlier
//    passage already drew it whole.
//
// "Never" is a time far in the future (NEVER): a shader reads it as "not yet".
// Texel ranges are uploaded a row at a time, so a thread's two texels never
// straddle a row (the width is even), and every span sent stays in one row.

import type { ReachKind } from '../../crawl-plan';
import type { ReplayView } from '../../replay-view';
import { threadEnds, type ThreadKey } from '../../threads';

/** Texels a row, in both textures. Even, so a thread's pair never straddles two rows. */
export const STATE_WIDTH = 256;
/** The time a thing that has not happened is stamped with: always "not yet". Exact in a float. */
export const NEVER = 1e9;
/** What a found note's `why` holds, by the kind of reason. */
export const FOUND_CODE: Readonly<Record<ReachKind, number>> = { named: 1, linked: 2, decision: 3 };
/**
 * Spans in one frame past which a texture goes up whole: a jump to the end
 * writes most of it anyway, and one upload beats a hundred small ones.
 */
const MAX_SPANS = 64;

export interface StateUpload {
  /** The whole texture: its first upload, after a reset, or after a jump. */
  full: boolean;
  /** Otherwise these spans, start and count in floats, each within one row; empty when nothing changed. */
  ranges: number[];
}

export interface StateDelta {
  /** Everything went dark again (the crawl started over or went): whatever was added for it goes too. */
  reset: boolean;
  nodes: StateUpload;
  threads: StateUpload;
  /** Threads gone along for the first time, in the order they were: the tubes add them. */
  opened: number[];
}

/** Grip slots read from the view. More than the Sentinel has; the rest stay empty. */
const SLOTS = 16;

export class DormantState {
  readonly width = STATE_WIDTH;
  readonly nodeRows: number;
  readonly threadRows: number;
  /** The note texture's data: `width × nodeRows` texels. */
  readonly nodes: Float32Array;
  /** The thread texture's data: `width × threadRows` texels. */
  readonly threads: Float32Array;
  /**
   * The thread the walk is on, and how far along it, 0–1 the way it goes; −1
   * when it is on none. Each frame's: a uniform, never a texture write.
   */
  readonly head: [number, number] = [-1, 0];
  /**
   * The note being read, and when its reading starts and ends, replay clock;
   * −1 before the first. Kept after the walk moves on, so it fades from there.
   */
  readonly read: [number, number, number] = [-1, 0, 0];
  /** Texture uploads asked for so far: at rest it stops counting. */
  uploads = 0;
  /** Notes found so far that have a texel. */
  found = 0;
  /** When the latest of them was found, replay clock; −∞ before any. */
  lastFound = -Infinity;

  private readonly nodeAt = new Map<string, number>();
  private readonly threadAt = new Map<ThreadKey, number>();
  private readonly lengths: ArrayLike<number>;
  /** Per thread: gone along before. */
  private readonly passed: Uint8Array;
  private history: ReplayView['history'] | null = null;
  private epoch = -1;
  private lastClock = -Infinity;
  private passages = 0;
  private reachedSeen = 0;
  private foundSeen = 0;
  /** Trail walked so far, world units: the next walked thread's offset. */
  private trail = 0;
  private readonly holdKey: (ThreadKey | null)[] = new Array<ThreadKey | null>(SLOTS).fill(null);
  private readonly holdSince = new Float64Array(SLOTS);
  /** Something was written since the textures were last dark. */
  private lit = false;
  /** Not uploaded yet at all. */
  private fresh = true;
  private readonly delta: StateDelta = {
    reset: false,
    nodes: { full: false, ranges: [] },
    threads: { full: false, ranges: [] },
    opened: [],
  };

  /**
   * `nodes` and `threads` in texel order — a note's or a thread's index is its
   * place in them — and each thread's length, world units, same order.
   */
  constructor(nodes: readonly string[], threads: readonly ThreadKey[], lengths: ArrayLike<number>) {
    nodes.forEach((id, i) => this.nodeAt.set(id, i));
    threads.forEach((key, i) => this.threadAt.set(key, i));
    this.lengths = lengths;
    this.passed = new Uint8Array(threads.length);
    this.nodeRows = Math.max(1, Math.ceil(nodes.length / STATE_WIDTH));
    this.threadRows = Math.max(1, Math.ceil((threads.length * 2) / STATE_WIDTH));
    this.nodes = new Float32Array(STATE_WIDTH * this.nodeRows * 4);
    this.threads = new Float32Array(STATE_WIDTH * this.threadRows * 4);
    this.dark();
  }

  /** A note's index in the textures, −1 when it has none. */
  nodeIndex(id: string): number {
    return this.nodeAt.get(id) ?? -1;
  }

  /** A thread's index, −1 when it has no route here: a reach can light a pair no thread joins. */
  threadIndex(key: ThreadKey): number {
    return this.threadAt.get(key) ?? -1;
  }

  /**
   * Brings the textures up to the view: what is new in its history since the
   * last call, and what to upload for it. The delta is reused: read it before
   * the next call. A null view, or a crawl that started over, puts it all out.
   */
  sync(view: ReplayView | null): StateDelta {
    const d = this.delta;
    d.reset = false;
    d.nodes.full = this.fresh;
    d.threads.full = this.fresh;
    d.nodes.ranges.length = 0;
    d.threads.ranges.length = 0;
    d.opened.length = 0;
    this.fresh = false;

    const history = view?.history ?? null;
    // The replay empties and refills one history, and a crawl jumped to its
    // end before this looks again can end later, with no fewer entries: its
    // epoch says it started over. A clock or a list gone back says so too.
    const over =
      !view ||
      !history ||
      history !== this.history ||
      history.epoch !== this.epoch ||
      view.clock < this.lastClock ||
      history.passages.length < this.passages ||
      history.reached.size < this.reachedSeen ||
      history.foundAt.size < this.foundSeen;
    if (over) {
      if (this.lit) {
        this.dark();
        d.reset = true;
        d.nodes.full = true;
        d.threads.full = true;
      }
      this.history = history;
      this.epoch = history?.epoch ?? -1;
      this.passages = 0;
      this.reachedSeen = 0;
      this.foundSeen = 0;
      this.trail = 0;
      this.found = 0;
      this.lastFound = -Infinity;
      this.holdKey.fill(null);
      this.read[0] = -1;
    }
    this.head[0] = -1;
    this.head[1] = 0;
    if (!view || !history) {
      this.lastClock = -Infinity;
      return this.finish();
    }
    this.lastClock = view.clock;

    this.passagesSince(history);
    this.notesSince(view, history);
    this.grips(view);
    this.live(view);
    return this.finish();
  }

  /** Every texel back to "never": nothing reached, found, gone along or held. */
  private dark(): void {
    this.nodes.fill(0);
    for (let i = 0; i < this.nodes.length; i += 4) {
      this.nodes[i] = NEVER;
      this.nodes[i + 1] = NEVER;
    }
    this.threads.fill(0);
    for (let t = 0; t < this.passed.length; t++) {
      const o = t * 8;
      this.threads[o] = NEVER;
      this.threads[o + 1] = NEVER;
      this.threads[o + 3] = NEVER;
      this.threads[o + 5] = this.lengths[t] ?? 0;
    }
    this.passed.fill(0);
    this.lit = false;
  }

  /** The passages added since the last frame: each thread's latest, and the trail's length. */
  private passagesSince(history: ReplayView['history']): void {
    const list = history.passages;
    for (let i = this.passages; i < list.length; i++) {
      const p = list[i]!;
      const t = this.threadAt.get(p.key);
      const walked = p.kind === 'walk';
      const length = t === undefined ? 0 : (this.lengths[t] ?? 0);
      // A walk carries the trail on; a reach starts its own pulses at the note it reached from.
      const offset = walked ? this.trail : 0;
      if (walked) this.trail += length;
      // A pair no thread of this space joins (a reach along a non-link): nothing to draw.
      if (t === undefined) continue;
      const why = p.kind === 'walk' ? 0 : FOUND_CODE[p.kind];
      const way = (threadEnds(p.key)[0] === p.fromId ? 1 : -1) * (1 + why);
      const o = t * 8;
      this.threads[o] = p.enter;
      this.threads[o + 1] = p.leave;
      this.threads[o + 2] = way;
      this.threads[o + 4] = offset;
      this.threads[o + 6] = this.passed[t] ? 1 : 0;
      if (!this.passed[t]) {
        this.passed[t] = 1;
        this.delta.opened.push(t);
      }
      this.span(this.delta.threads, o, 8);
    }
    this.passages = list.length;
  }

  /** Notes reached and found since the last frame. Both maps only ever grow, in order. */
  private notesSince(view: ReplayView, history: ReplayView['history']): void {
    if (history.reached.size > this.reachedSeen) {
      let k = 0;
      for (const [id, at] of history.reached) {
        if (k++ < this.reachedSeen) continue;
        const n = this.nodeAt.get(id);
        if (n === undefined) continue;
        this.nodes[n * 4] = at;
        this.span(this.delta.nodes, n * 4, 4);
      }
      this.reachedSeen = history.reached.size;
    }
    if (history.foundAt.size > this.foundSeen) {
      let k = 0;
      for (const [id, at] of history.foundAt) {
        if (k++ < this.foundSeen) continue;
        const n = this.nodeAt.get(id);
        const kind = view.found.get(id);
        if (n === undefined) continue;
        this.nodes[n * 4 + 1] = at;
        this.nodes[n * 4 + 2] = kind ? FOUND_CODE[kind] : FOUND_CODE.named;
        this.found++;
        this.lastFound = Math.max(this.lastFound, at);
        this.span(this.delta.nodes, n * 4, 4);
      }
      this.foundSeen = history.foundAt.size;
    }
  }

  /** A grip that landed since the last frame stamps its thread, when and where: the filament flashes there, then goes out. */
  private grips(view: ReplayView): void {
    const slots = Math.min(SLOTS, view.holds.length);
    for (let s = 0; s < slots; s++) {
      const h = view.holds[s];
      if (!h) {
        this.holdKey[s] = null;
        continue;
      }
      if (h.key === this.holdKey[s] && h.since === this.holdSince[s]) continue;
      this.holdKey[s] = h.key;
      this.holdSince[s] = h.since;
      const t = this.threadAt.get(h.key);
      if (t === undefined) continue;
      this.threads[t * 8 + 3] = h.since;
      this.threads[t * 8 + 7] = h.u;
      this.span(this.delta.threads, t * 8, 8);
    }
  }

  /** The walk's place on its thread, and the note being read: this frame's, for the uniforms. */
  private live(view: ReplayView): void {
    const w = view.walk;
    if (view.mode === 'walk' && w && w.segments.length > 0) {
      let k = 0;
      let d = Math.max(0, w.travelled);
      while (k < w.segments.length - 1 && d > w.segments[k]!.length) {
        d -= w.segments[k]!.length;
        k++;
      }
      const st = w.segments[k]!;
      const t = st.key ? this.threadAt.get(st.key) : undefined;
      if (t !== undefined) {
        this.head[0] = t;
        this.head[1] = st.length > 0 ? Math.max(0, Math.min(1, d / st.length)) : 1;
      }
    }
    if (view.mode === 'dwell' && view.hereId && view.dwell) {
      const n = this.nodeAt.get(view.hereId);
      if (n !== undefined) {
        const start = view.clock - view.dwell.t;
        this.read[0] = n;
        this.read[1] = start;
        this.read[2] = start + view.dwell.duration;
      }
    }
  }

  /** Marks `count` floats from `start` to upload, joined to the last span when it runs on from it. */
  private span(upload: StateUpload, start: number, count: number): void {
    this.lit = true;
    if (upload.full) return;
    const r = upload.ranges;
    const n = r.length;
    if (n > 0 && r[n - 2]! + r[n - 1]! === start && this.row(start) === this.row(r[n - 2]!)) {
      r[n - 1] = r[n - 1]! + count;
      return;
    }
    if (n / 2 >= MAX_SPANS) {
      upload.full = true;
      r.length = 0;
      return;
    }
    r.push(start, count);
  }

  /** The row a float lies in. */
  private row(float: number): number {
    return Math.floor(float / (4 * STATE_WIDTH));
  }

  private finish(): StateDelta {
    const d = this.delta;
    if (d.nodes.full) d.nodes.ranges.length = 0;
    if (d.threads.full) d.threads.ranges.length = 0;
    if (d.nodes.full || d.nodes.ranges.length > 0) this.uploads++;
    if (d.threads.full || d.threads.ranges.length > 0) this.uploads++;
    return d;
  }
}
