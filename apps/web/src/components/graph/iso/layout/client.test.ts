import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LayoutClient, layoutNow } from './client';
import { layoutIso, type IsoLayout, type LayoutNote, type LayoutVault } from './territories';

const VAULTS: LayoutVault[] = [{ id: 'own', label: 'Your vault', shared: false }];

/** Invented notes, distinct per project: the last layout is kept for the module, so each test asks for its own. */
function notes(project: string, n = 6): LayoutNote[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `own/${project}/note ${i}.md`,
    path: `${project}/note ${i}.md`,
    project: `own|${project}`,
    projectLabel: project,
    vault: 'own',
    isIndex: false,
    createdAt: i,
  }));
}

/** Whether `promise` has already resolved: an answer laid out on this thread is there at once. */
async function settledNow<T>(promise: Promise<T>): Promise<boolean> {
  const later = Symbol('later');
  return (await Promise.race([promise, Promise.resolve(later)])) !== later;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// The worker's scope as the real worker module sees it. Each fake worker points
// its replies at itself before handing the scope a request.
type Listener = ((event: { data: unknown }) => void) | null;
const scope: {
  onmessage: Listener;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
} = {
  onmessage: null,
  postMessage: () => {},
};

/** A Worker that runs layout.worker.ts in this thread, cloning across as the browser would. */
class FakeWorker {
  static made: FakeWorker[] = [];
  /** Every request fails, as a worker that threw would. */
  static crash = false;
  /** The constructor throws, as where workers are blocked. */
  static refuse = false;
  /** Replies arrive and cannot be read, as a message that fails to deserialise. */
  static garble = false;

  onmessage: Listener = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  posted = 0;
  terminated = false;
  transfers: Transferable[][] = [];

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    if (FakeWorker.refuse) throw new Error('workers are blocked here');
    FakeWorker.made.push(this);
  }

  postMessage(message: unknown): void {
    this.posted++;
    const data = structuredClone(message);
    setTimeout(() => {
      if (this.terminated) return;
      if (FakeWorker.crash) {
        this.onerror?.(new Error('the worker fell over'));
        return;
      }
      scope.postMessage = (reply, transfer = []) => {
        this.transfers.push(transfer);
        const copy = structuredClone(reply, { transfer });
        setTimeout(() => {
          if (this.terminated) return;
          if (FakeWorker.garble) this.onmessageerror?.({ data: null });
          else this.onmessage?.({ data: copy });
        }, 0);
      };
      scope.onmessage!({ data });
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('./layout.worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.made = [];
  FakeWorker.crash = false;
  FakeWorker.refuse = false;
  FakeWorker.garble = false;
});

describe('LayoutClient', () => {
  it('lays out on this thread when there is no Worker, and answers the same key with the same object', async () => {
    vi.stubGlobal('Worker', undefined);
    const client = new LayoutClient();
    const input = notes('Orbit');
    const pending = client.layout(input, VAULTS);
    expect(await settledNow(pending)).toBe(true);
    const layout = await pending;
    expect(layout).toEqual(layoutIso(input, VAULTS));
    expect(await client.layout([...input], [...VAULTS])).toBe(layout);
    expect(layoutNow(input, VAULTS)).toBe(layout);
  });

  it('starts no worker for what layoutNow already laid out', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const input = notes('Atlas');
    const first = layoutNow(input, VAULTS);
    expect(
      layoutNow(
        input.map((n) => ({ ...n })),
        VAULTS,
      ),
    ).toBe(first);
    expect(await new LayoutClient().layout(input, VAULTS)).toBe(first);
    expect(FakeWorker.made).toHaveLength(0);
  });

  it('lays out in the worker, moving the arrays across rather than copying them', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new LayoutClient();
    const input = notes('Ledger', 9);
    const layout = await client.layout(input, VAULTS);
    expect(FakeWorker.made).toHaveLength(1);
    const worker = FakeWorker.made[0]!;
    expect(worker.options).toEqual({ type: 'module' });
    expect(String(worker.url)).toMatch(/layout\.worker\.ts$/);
    expect(layout).toEqual(layoutIso(input, VAULTS));
    expect(worker.transfers).toHaveLength(1);
    expect(worker.transfers[0]).toHaveLength(2);
    expect(await client.layout(input, VAULTS)).toBe(layout);
    expect(worker.posted).toBe(1);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('resolves a request a newer one superseded with the newer layout', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new LayoutClient();
    const [older, newer] = await Promise.all([
      client.layout(notes('Gondor'), VAULTS),
      client.layout(notes('Rohan', 4), VAULTS),
    ]);
    expect(older).toBe(newer);
    expect(newer.ids).toEqual(layoutIso(notes('Rohan', 4), VAULTS).ids);
    const worker = FakeWorker.made[0]!;
    expect(worker.posted).toBe(2);
    // Asked again for what is already on its way, it waits for that answer instead of sending more.
    const [a, b] = await Promise.all([
      client.layout(notes('Erebor'), VAULTS),
      client.layout(notes('Erebor'), VAULTS),
    ]);
    expect(a).toBe(b);
    expect(worker.posted).toBe(3);
    client.dispose();
  });

  it('lays out at once when asked to, and what was pending resolves with that', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new LayoutClient();
    const pending = client.layout(notes('Dale'), VAULTS);
    const now = client.layoutNow(notes('Esgaroth', 3), VAULTS);
    expect(now).toBe(layoutNow(notes('Esgaroth', 3), VAULTS));
    expect(await settledNow(pending)).toBe(true);
    expect(await pending).toBe(now);
    // The worker's answer for the older request comes later, and changes nothing.
    await tick();
    expect(await client.layout(notes('Esgaroth', 3), VAULTS)).toBe(now);
    client.dispose();
  });

  it('falls back to this thread for good when the worker fails', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.crash = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new LayoutClient();
    const input = notes('Shire');
    const layout = await client.layout(input, VAULTS);
    expect(layout).toEqual(layoutIso(input, VAULTS));
    expect(warn).toHaveBeenCalledTimes(1);
    const worker = FakeWorker.made[0]!;
    expect(worker.terminated).toBe(true);
    const next = client.layout(notes('Bree'), VAULTS);
    expect(await settledNow(next)).toBe(true);
    expect(FakeWorker.made).toHaveLength(1);
    expect(worker.posted).toBe(1);
  });

  it('falls back to this thread when a reply cannot be read', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.garble = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = notes('Lorien');
    const layout = await new LayoutClient().layout(input, VAULTS);
    expect(layout).toEqual(layoutIso(input, VAULTS));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
  });

  it('lays out on this thread when the worker cannot start', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.refuse = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = new LayoutClient().layout(notes('Moria'), VAULTS);
    expect(await settledNow(pending)).toBe(true);
    expect((await pending).ids).toHaveLength(6);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never resolves what was pending when it is disposed, and stops the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new LayoutClient();
    let answer: IsoLayout | null = null;
    void client.layout(notes('Isengard'), VAULTS).then((layout) => (answer = layout));
    client.dispose();
    await tick();
    expect(answer).toBeNull();
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    // Asked again, it lays out here, and still answers nobody who asked before.
    const later = client.layout(notes('Orthanc'), VAULTS);
    expect(await settledNow(later)).toBe(true);
    await tick();
    expect(answer).toBeNull();
    expect(FakeWorker.made).toHaveLength(1);
  });
});
