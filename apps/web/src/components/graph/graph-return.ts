// The way back from a note to the graph it was opened from. /graph mounts afresh every time it is
// entered, Back included, and would come up framed on the whole graph with nothing selected: the
// place somebody was reading from, lost to one look at a note. So opening a note keeps where the
// graph was — the note, the camera, the way back through what was selected before — in this
// tab's session storage, and the next layout of the same view takes it up once.
//
// The camera is kept relative to the note, not as it was: the next layout starts from the saved
// positions but settles a little differently, or from scratch, and the note should come back
// where it was on the screen, wherever it lands. Pure: the store and the clock come from the
// caller, and every access to the store may throw.

import { GRAPH_VIEWS, type GraphView } from '@/lib/graph-model';

/** What the way back reads and writes: `sessionStorage`, or a fake in a test. */
export type ReturnStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const RETURN_KEY = 'brainstack.graph.return';
const VERSION = 1;
/** Past this the graph opens as on any visit: ten minutes on, the way back is another errand. */
export const RETURN_TTL_MS = 10 * 60_000;
/** How much of Back's trail is kept: the latest steps, enough for a walk without a long record. */
export const RETURN_TRAIL_MAX = 20;

/** A camera relative to a note: its target minus the note's place, and its angle and distance. */
export interface CamOffset {
  dx: number;
  dy: number;
  dz: number;
  yaw: number;
  pitch: number;
  dist: number;
}

/**
 * A step of Back's trail: a note, or a path by its notes in order, with the camera it was seen
 * from (a path's relative to the note it was traced from) and the view it was seen in.
 */
export type ReturnStep = ({ node: string } | { path: string[] }) & {
  cam: CamOffset;
  view: GraphView;
};

export interface ReturnEntry {
  view: GraphView;
  /** The note opened. */
  node: string;
  cam: CamOffset;
  /** Back's trail, oldest first. */
  trail: ReturnStep[];
}

/** Keep `entry` for the next layout of its view in this tab. Blocked or full storage keeps nothing. */
export function writeReturn(store: ReturnStore | null, entry: ReturnEntry, now: number): void {
  const value = { v: VERSION, at: now, ...entry, trail: entry.trail.slice(-RETURN_TRAIL_MAX) };
  try {
    store?.setItem(RETURN_KEY, JSON.stringify(value));
  } catch {
    // storage blocked or full: the graph comes up as on any visit
  }
}

/**
 * The way back kept for `view`, or null: none, another view's, older than the TTL, or not one
 * this version wrote. Read once — the key goes whatever it held — so a later visit is not taken
 * for a way back from the same note. A step of the trail that does not parse is left out.
 */
export function readReturn(
  store: ReturnStore | null,
  view: GraphView,
  now: number,
): ReturnEntry | null {
  let raw: string | null;
  try {
    raw = store?.getItem(RETURN_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    store?.removeItem(RETURN_KEY);
  } catch {
    // a store that reads but will not write: the TTL ends what it keeps
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== VERSION || value.view !== view) return null;
  const { at } = value;
  if (typeof at !== 'number' || !(now >= at && now - at <= RETURN_TTL_MS)) return null;
  const cam = camOffset(value.cam);
  if (typeof value.node !== 'string' || !cam || !Array.isArray(value.trail)) return null;
  const trail = value.trail.map(returnStep).filter((s): s is ReturnStep => s !== null);
  return { view, node: value.node, cam, trail: trail.slice(-RETURN_TRAIL_MAX) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function camOffset(value: unknown): CamOffset | null {
  if (!isRecord(value)) return null;
  const { dx, dy, dz, yaw, pitch, dist } = value;
  const nums = [dx, dy, dz, yaw, pitch, dist];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if ((dist as number) <= 0) return null;
  return { dx, dy, dz, yaw, pitch, dist } as CamOffset;
}

function returnStep(value: unknown): ReturnStep | null {
  if (!isRecord(value)) return null;
  const cam = camOffset(value.cam);
  const view = GRAPH_VIEWS.find((v) => v === value.view);
  if (!cam || !view) return null;
  if (typeof value.node === 'string') return { node: value.node, cam, view };
  const { path } = value;
  if (Array.isArray(path) && path.length >= 2 && path.every((id) => typeof id === 'string'))
    return { path: path as string[], cam, view };
  return null;
}
