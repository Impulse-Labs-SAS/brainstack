// Where a label may go. Every label on the graph is a rectangle that must not
// cover another label, the chrome floating over the graph, or a note that
// matters; one that cannot find room is dropped, never drawn on top of
// something else. What is placed first wins, so callers place by importance:
// the selected note, then what it links to, what a search found, the names of
// places, and the rest.
//
// Taken rectangles are kept in a grid of cells, so testing a label costs what
// lies near it, not everything placed so far: a frame places hundreds.
//
// Pure: no canvas, no DOM. Shared by every view and every style.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** The cell size of the grid: about a short label's width. */
const CELL = 64;

/** One frame's room for labels: `bounds` minus everything reserved or taken. */
export class LabelSpace {
  private readonly cells = new Map<number, Rect[]>();
  private readonly cols: number;
  private placed = 0;

  constructor(readonly bounds: Rect) {
    this.cols = Math.max(1, Math.ceil(bounds.w / CELL) + 2);
  }

  /** Labels taken so far; reserved rectangles do not count. */
  get count(): number {
    return this.placed;
  }

  /** Whether `r` lies inside the bounds and clear of everything reserved or taken. */
  fits(r: Rect): boolean {
    const b = this.bounds;
    if (r.x < b.x || r.y < b.y || r.x + r.w > b.x + b.w || r.y + r.h > b.y + b.h) return false;
    let hit = false;
    this.visit(r, (list) => {
      for (const other of list ?? []) {
        if (intersects(r, other)) {
          hit = true;
          return true;
        }
      }
      return false;
    });
    return !hit;
  }

  /** Mark `r` as taken by something that is not a label: chrome, a note's dot. Anywhere, even off bounds. */
  reserve(r: Rect): void {
    this.add(r);
  }

  /** Mark `r` as taken by a label, whether or not it fit: the caller has decided to draw it. */
  take(r: Rect): void {
    this.add(r);
    this.placed++;
  }

  /** The first of `slots` that fits, taken; null when none does. */
  place(slots: readonly Rect[]): Rect | null {
    for (const r of slots) {
      if (this.fits(r)) {
        this.take(r);
        return r;
      }
    }
    return null;
  }

  private add(r: Rect): void {
    this.visit(r, (list, key) => {
      if (list) list.push(r);
      else this.cells.set(key, [r]);
      return false;
    });
  }

  /** Calls `fn` for each cell `r` covers, with the rectangles in it, until `fn` returns true. */
  private visit(r: Rect, fn: (list: Rect[] | undefined, key: number) => boolean): void {
    const b = this.bounds;
    // Columns from the bounds' left edge; whatever spills out either side shares the column
    // beyond that edge. Rows are unbounded: a key is unique for any row.
    const col = (x: number) => clamp(Math.floor((x - b.x) / CELL), -1, this.cols - 2);
    const c0 = col(r.x);
    const c1 = col(r.x + r.w);
    const r0 = Math.floor((r.y - b.y) / CELL);
    const r1 = Math.floor((r.y + r.h - b.y) / CELL);
    for (let row = r0; row <= r1; row++) {
      for (let c = c0; c <= c1; c++) {
        const key = row * this.cols + (c + 1);
        if (fn(this.cells.get(key), key)) return;
      }
    }
  }
}

/**
 * Which labels were drawn last frame. A label that was showing goes before one
 * that was not, among labels of the same importance, so a label holds its
 * place while the notes drift or the camera moves, instead of trading places
 * with a neighbour every other frame.
 */
export class LabelMemory {
  private last = new Set<string>();
  private now = new Set<string>();

  /** Start a frame: what was drawn becomes what was shown. */
  begin(): void {
    this.last = this.now;
    this.now = new Set();
  }

  wasShown(key: string): boolean {
    return this.last.has(key);
  }

  shown(key: string): void {
    this.now.add(key);
  }
}

/** `items` with those last shown first, each group in its given order. */
export function shownFirst<T>(
  items: Iterable<T>,
  key: (item: T) => string,
  memory: LabelMemory,
): T[] {
  const before: T[] = [];
  const after: T[] = [];
  for (const item of items) (memory.wasShown(key(item)) ? before : after).push(item);
  return before.concat(after);
}
