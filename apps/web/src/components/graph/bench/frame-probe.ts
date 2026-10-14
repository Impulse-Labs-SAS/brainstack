// How smoothly the page draws, measured from outside whatever draws it. A loop of its own
// on requestAnimationFrame records the gap between frames: when the main thread is busy
// (a layout tick, a label pass, an upload) the next frame comes late, whoever was busy.
// Long tasks, where the browser reports them, say what blocked input.
//
// It measures what the person feels, not what one module costs: a slow frame is slow
// whether the graph or React spent it. For one module's share, profile it.

/** A window of frames, summed up. Times in milliseconds. */
export interface FrameStats {
  frames: number;
  /** Median gap between frames. */
  p50: number;
  /** The gap 95% of frames came within. */
  p95: number;
  max: number;
  /** Frames per second over the window, from the mean gap. */
  fps: number;
  /** Tasks of 50 ms or more, and their time together. */
  longTasks: number;
  longTaskMs: number;
}

/** The value at fraction `q` of `sorted` (ascending), by nearest rank. */
function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

/** Frame gaps and long-task durations, summed up. */
export function frameStats(gaps: readonly number[], longTasks: readonly number[]): FrameStats {
  const sorted = [...gaps].sort((a, b) => a - b);
  const total = gaps.reduce((s, g) => s + g, 0);
  return {
    frames: gaps.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    fps: total > 0 ? (1000 * gaps.length) / total : 0,
    longTasks: longTasks.length,
    longTaskMs: longTasks.reduce((s, d) => s + d, 0),
  };
}

/** The frames a probe keeps: about ten seconds at 60 fps. */
const WINDOW = 600;

/** Records frame gaps while started; `report` sums up the last few seconds. */
export class FrameProbe {
  private gaps: number[] = [];
  private longTasks: number[] = [];
  private last = 0;
  private raf = 0;
  private observer: PerformanceObserver | null = null;

  start(): void {
    if (this.raf) return;
    this.last = 0;
    const tick = (t: number) => {
      if (this.last) {
        this.gaps.push(t - this.last);
        if (this.gaps.length > WINDOW) this.gaps.shift();
      }
      this.last = t;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTasks.push(e.duration);
        if (this.longTasks.length > WINDOW)
          this.longTasks.splice(0, this.longTasks.length - WINDOW);
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch {
      // Long tasks are Chromium's; elsewhere the count stays at zero.
      this.observer = null;
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Forget what was recorded, to measure from now on. */
  reset(): void {
    this.gaps = [];
    this.longTasks = [];
    this.last = 0;
  }

  report(): FrameStats {
    return frameStats(this.gaps, this.longTasks);
  }
}
