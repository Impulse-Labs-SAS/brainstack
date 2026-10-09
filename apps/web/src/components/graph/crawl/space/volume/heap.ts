// A binary min-heap of lattice sites by a number, for growing regions over the
// lattice nearest first. Typed arrays rather than objects, because a layout
// pushes every site of the lattice through it.
//
// Ties go to the smaller site: with keys that are often exactly equal — two
// sites the same angle from a seed — the order things come out in must not
// depend on the order they went in, or the layout would shift whenever the
// vault's notes arrived in another order.

export class MinHeap {
  private keys: Float64Array;
  private items: Int32Array;
  private n = 0;

  constructor(capacity = 64) {
    this.keys = new Float64Array(Math.max(1, capacity));
    this.items = new Int32Array(Math.max(1, capacity));
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(key: number, item: number): void {
    if (this.n === this.keys.length) {
      const keys = new Float64Array(this.n * 2);
      const items = new Int32Array(this.n * 2);
      keys.set(this.keys);
      items.set(this.items);
      this.keys = keys;
      this.items = items;
    }
    let i = this.n++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!precedes(key, item, this.keys[parent]!, this.items[parent]!)) break;
      this.keys[i] = this.keys[parent]!;
      this.items[i] = this.items[parent]!;
      i = parent;
    }
    this.keys[i] = key;
    this.items[i] = item;
  }

  /** The item with the smallest key, taken off the heap; -1 when it is empty. */
  pop(): number {
    if (this.n === 0) return -1;
    const top = this.items[0]!;
    const n = --this.n;
    if (n === 0) return top;
    const key = this.keys[n]!;
    const item = this.items[n]!;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= n) break;
      const r = l + 1;
      const c =
        r < n && precedes(this.keys[r]!, this.items[r]!, this.keys[l]!, this.items[l]!) ? r : l;
      if (!precedes(this.keys[c]!, this.items[c]!, key, item)) break;
      this.keys[i] = this.keys[c]!;
      this.items[i] = this.items[c]!;
      i = c;
    }
    this.keys[i] = key;
    this.items[i] = item;
    return top;
  }
}

/** Whether (key, item) comes out before (otherKey, otherItem). */
function precedes(key: number, item: number, otherKey: number, otherItem: number): boolean {
  return key < otherKey || (key === otherKey && item < otherItem);
}
