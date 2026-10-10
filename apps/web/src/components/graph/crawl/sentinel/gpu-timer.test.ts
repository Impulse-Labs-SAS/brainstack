import { describe, expect, it } from 'vitest';

import { GpuTimer } from './gpu-timer';

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

/**
 * The few WebGL2 calls the timer makes, with results the test hands out: a
 * query's result is available once `finish` says so, as a GPU would after a
 * few frames.
 */
class FakeGl {
  readonly QUERY_RESULT = 0x8866;
  readonly QUERY_RESULT_AVAILABLE = 0x8867;
  /** Queries created and not deleted. */
  readonly live = new Set<WebGLQuery>();
  /** Ended queries, in the order they ended. */
  readonly ended: WebGLQuery[] = [];
  disjoint = false;
  private readonly results = new Map<WebGLQuery, number>();
  private open: WebGLQuery | null = null;

  constructor(private readonly hasExtension = true) {}

  getExtension(name: string) {
    return this.hasExtension && name === 'EXT_disjoint_timer_query_webgl2'
      ? { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT }
      : null;
  }
  createQuery(): WebGLQuery {
    const query = {} as WebGLQuery;
    this.live.add(query);
    return query;
  }
  deleteQuery(query: WebGLQuery): void {
    this.live.delete(query);
  }
  beginQuery(target: number, query: WebGLQuery): void {
    expect(target).toBe(TIME_ELAPSED_EXT);
    expect(this.open).toBeNull();
    this.open = query;
    this.results.delete(query);
  }
  endQuery(target: number): void {
    expect(target).toBe(TIME_ELAPSED_EXT);
    this.ended.push(this.open!);
    this.open = null;
  }
  getParameter(name: number): boolean {
    expect(name).toBe(GPU_DISJOINT_EXT);
    // Reading the flag clears it, as the extension does.
    const d = this.disjoint;
    this.disjoint = false;
    return d;
  }
  getQueryParameter(query: WebGLQuery, name: number): boolean | number {
    const ns = this.results.get(query);
    return name === this.QUERY_RESULT_AVAILABLE ? ns !== undefined : (ns ?? 0);
  }
  /** The GPU finished the `i`-th query to end, after `ms`. */
  finish(i: number, ms: number): void {
    this.results.set(this.ended[i]!, ms * 1e6);
  }
}

function timerOn(gl: FakeGl): GpuTimer {
  const timer = GpuTimer.create(gl as unknown as WebGL2RenderingContext);
  expect(timer).not.toBeNull();
  return timer!;
}

/** One frame's work, timed. */
function measure(timer: GpuTimer): void {
  timer.begin();
  timer.end();
}

describe('GpuTimer', () => {
  it('is not there without the extension', () => {
    expect(GpuTimer.create(new FakeGl(false) as unknown as WebGL2RenderingContext)).toBeNull();
  });

  it('reports the newest finished measurement, in ms, reading them in the order they ended', () => {
    const gl = new FakeGl();
    const timer = timerOn(gl);
    for (let i = 0; i < 3; i++) measure(timer);
    expect(timer.poll()).toBeNull();
    // The second finished first: nothing is read past the first, still running.
    gl.finish(1, 2);
    expect(timer.poll()).toBeNull();
    gl.finish(0, 1.5);
    expect(timer.poll()).toBe(2);
    gl.finish(2, 0.75);
    expect(timer.poll()).toBe(0.75);
    expect(timer.poll()).toBeNull();
  });

  it('throws away whatever was in flight when the GPU was disjoint', () => {
    const gl = new FakeGl();
    const timer = timerOn(gl);
    measure(timer);
    measure(timer);
    gl.finish(0, 1);
    gl.finish(1, 1);
    gl.disjoint = true;
    expect(timer.poll()).toBeNull();
    expect(timer.poll()).toBeNull();
    // Its queries are free again: the next measurement is read as usual.
    measure(timer);
    gl.finish(2, 3);
    expect(timer.poll()).toBe(3);
  });

  it('keeps at most eight measurements in flight, and skips frames while all are', () => {
    const gl = new FakeGl();
    const timer = timerOn(gl);
    for (let i = 0; i < 12; i++) measure(timer);
    expect(gl.ended).toHaveLength(8);
    expect(gl.live.size).toBe(8);
    gl.finish(0, 1);
    expect(timer.poll()).toBe(1);
    measure(timer);
    expect(gl.ended).toHaveLength(9);
  });

  it('deletes every query when disposed, an open one included', () => {
    const gl = new FakeGl();
    const timer = timerOn(gl);
    measure(timer);
    timer.begin();
    timer.dispose();
    expect(gl.live.size).toBe(0);
    expect(timer.poll()).toBeNull();
    timer.dispose();
  });
});
