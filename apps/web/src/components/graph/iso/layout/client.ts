// Where the plate layout runs: in a worker when the browser has one, here when it
// does not, cannot start one, or the one it had failed. Either way the caller gets
// the same layout from the same function.
//
// The last layout is kept by its key, shared by every client and by `layoutNow`:
// the first frame lays out at once, and the client asked next for the same notes
// answers with that very object, without work. A layout handed out is shared, so
// nobody may write to it.

import type { LayoutRequest } from './layout.worker';
import {
  layoutIso,
  layoutKey,
  type IsoLayout,
  type LayoutNote,
  type LayoutVault,
} from './territories';

let last: { key: string; layout: IsoLayout } | null = null;

function remember(key: string, layout: IsoLayout): IsoLayout {
  last = { key, layout };
  return layout;
}

/** The layout now, on this thread: for the first frame, before any worker could answer. */
export function layoutNow(notes: readonly LayoutNote[], vaults: readonly LayoutVault[]): IsoLayout {
  const key = layoutKey(notes, vaults);
  if (last?.key === key) return last.layout;
  return remember(key, layoutIso(notes, vaults));
}

interface Pending {
  key: string;
  notes: readonly LayoutNote[];
  vaults: readonly LayoutVault[];
}

export class LayoutClient {
  private worker: Worker | null = null;
  /** There is no worker, it could not start, or it failed: everything is laid out here from now on. */
  private inline = false;
  private disposed = false;
  private seq = 0;
  /** The newest request. Only its layout resolves anything; an older one's is dropped. */
  private latest = 0;
  /** What the worker was sent and has not answered, oldest first: it answers in order. */
  private readonly sent: number[] = [];
  /** The newest request while the worker has it, kept to lay out here if the worker fails. */
  private pending: Pending | null = null;
  private waiting: ((layout: IsoLayout) => void)[] = [];

  /**
   * The layout for these notes. A newer call supersedes one still in flight: every
   * promise unresolved by then resolves with the newest call's layout.
   */
  layout(notes: readonly LayoutNote[], vaults: readonly LayoutVault[]): Promise<IsoLayout> {
    const key = layoutKey(notes, vaults);
    if (last?.key === key) {
      this.latest = ++this.seq;
      return Promise.resolve(this.settle(last.layout));
    }
    // Already on its way: the answer coming serves this call too.
    if (this.pending?.key === key) return this.wait();
    const worker = this.workerFor();
    this.latest = ++this.seq;
    if (!worker) return Promise.resolve(this.settle(remember(key, layoutIso(notes, vaults))));
    this.pending = { key, notes, vaults };
    this.sent.push(this.latest);
    const request: LayoutRequest = { notes, vaults };
    worker.postMessage(request);
    return this.wait();
  }

  /** `layoutNow`, as a request: newer than anything pending, which resolves with it. */
  layoutNow(notes: readonly LayoutNote[], vaults: readonly LayoutVault[]): IsoLayout {
    this.latest = ++this.seq;
    return this.settle(layoutNow(notes, vaults));
  }

  /** Stops the worker. What was still pending never resolves: whoever asked for it is gone. */
  dispose(): void {
    this.disposed = true;
    this.stopWorker();
    this.waiting = [];
  }

  private wait(): Promise<IsoLayout> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Resolves everything waiting with `layout`, the newest request's. */
  private settle(layout: IsoLayout): IsoLayout {
    const waiting = this.waiting;
    this.waiting = [];
    this.pending = null;
    for (const resolve of waiting) resolve(layout);
    return layout;
  }

  private workerFor(): Worker | null {
    if (this.worker || this.inline || this.disposed) return this.worker;
    if (typeof Worker === 'undefined') {
      this.inline = true;
      return null;
    }
    try {
      const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<IsoLayout>) => this.received(event.data);
      worker.onerror = (event) => this.failed(event);
      worker.onmessageerror = (event) => this.failed(event);
      this.worker = worker;
    } catch (error) {
      this.failed(error);
    }
    return this.worker;
  }

  private received(layout: IsoLayout): void {
    const seq = this.sent.shift();
    if (seq !== this.latest || !this.pending) return;
    this.settle(remember(this.pending.key, layout));
  }

  private failed(error: unknown): void {
    console.warn('Graph: the layout worker failed; the map is laid out on the main thread.', error);
    const pending = this.pending;
    this.stopWorker();
    this.inline = true;
    if (pending) this.settle(remember(pending.key, layoutIso(pending.notes, pending.vaults)));
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.sent.length = 0;
    this.pending = null;
  }
}
