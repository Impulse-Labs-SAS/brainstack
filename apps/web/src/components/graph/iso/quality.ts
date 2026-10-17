// How sharply line art draws while its camera moves: the canvas's pixel ratio, stepped down when
// frames drawn during a pan, a zoom or a flight come late, and back up when they come early.
// Frames at rest are not counted: a still map is drawn once, at its sharpest, and costs nothing
// after.
//
// The decision worth keeping: it falls fast and climbs slowly. Three late frames in the last
// forty (a p95 above 20 ms, a missed vsync at 60 Hz) step it down; a hundred and twenty with at
// most six of them 18 ms or slower (a p95 under 18 ms) step it up. After any change it counts
// afresh, so a step is judged only by frames drawn at it. A 60 Hz screen's frames that make vsync
// come 16.7 ms apart, under the upper bound, so a machine that caught up climbs back. A step it
// has fallen from twice is out of reach for the rest of the visit, however long it held in
// between: a load slow at one step and fast at the next, steadily or in bursts every few seconds,
// settles instead of flapping between them.
//
// The bounds are a 60 Hz screen's. A browser that draws less often whatever the machine (a 30 fps
// power saver, a 50 Hz panel) stretches them by as much, measured from the frames at rest: a
// lower ratio cannot make it draw sooner, and only the grid would blink on every pan for nothing.
// On a screen whose ratio falls between two steps (1.75, 1.1) the sharpest step is the screen's
// own, so a machine that keeps up never changes the ratio at all.
//
// Pure: no DOM, no clock. The caller measures the intervals.

/** The canvas pixel ratios it steps through, sharpest first. */
export const DPR_STEPS: readonly number[] = [2, 1.5, 1.25, 1];

/** What a step draws: its pixel ratio, and whether the dot grid and the cables' hidden stretches show. */
export interface QualityLevel {
  dpr: number;
  grid: boolean;
  hidden: boolean;
}

/** The step past the last ratio: the same ratio, without the dot grid and the hidden cables. */
const BARE = DPR_STEPS.length;

/** A step down: the p95 of the last 40 moving frames above 20 ms, a missed vsync at 60 Hz. */
const DOWN_FRAMES = 40;
export const SLOW_MS = 20;
/**
 * A step up: the p95 of the last 120 under 18 ms. A 60 Hz screen's frames that make vsync come
 * 16.7 ms apart: under a lower bound it could never climb back after one bad moment.
 */
const UP_FRAMES = 120;
export const FAST_MS = 18;

/** A device ratio this little under a step still takes it: a reported 1.4999 is a 1.5 screen. */
const SLACK = 0.01;

/** The frame the bounds are for, a 60 Hz screen's, and how much longer one at rest must be to stretch them. */
const VSYNC_MS = 1000 / 60;
const STRETCH_FROM = 1.1;
/** Frames at rest kept to measure the cadence, and how many it takes before it is believed. */
const IDLE_FRAMES = 31;
const IDLE_MIN = 10;

/**
 * How many of `n` frames must be beyond a bound for their p95 to be. By nearest rank, the p95
 * is the ceil(0.95·n)-th fastest frame: it is beyond the bound exactly when it and every frame
 * slower than it are. Counting those as frames come and go costs nothing per frame, where
 * sorting the window would.
 */
const beyondP95 = (n: number) => n - Math.ceil((n * 19) / 20) + 1;
/** Three of forty. */
const SLOW_COUNT = beyondP95(DOWN_FRAMES);
/** Seven of a hundred and twenty: six slower frames still leave the p95 under the bound. */
const NOT_FAST_COUNT = beyondP95(UP_FRAMES);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Steps the drawing's quality down while moving frames come late, and back up while they come early. */
export class QualityGovernor {
  private readonly device: number;
  /** The sharpest step it may climb to: the device's own, or lower once one was lost twice. */
  private top: number;
  /** The screen's own sharpest step, as it started. */
  private readonly own: number;
  private at: number;
  /** Per step, how many times it has fallen from it on this visit. */
  private readonly falls = new Uint8Array(BARE);
  /** Moving frames counted since the last change. */
  private frames = 0;
  /** Per frame, in a ring as long as its window, whether it was slow, or not fast. */
  private readonly slowRing = new Uint8Array(DOWN_FRAMES);
  private readonly notFastRing = new Uint8Array(UP_FRAMES);
  /** How many of the last DOWN_FRAMES were slow, and of the last UP_FRAMES not fast. */
  private slow = 0;
  private notFast = 0;
  /** The last frames drawn at rest, their intervals: how often the browser draws at all. */
  private readonly idleRing = new Float64Array(IDLE_FRAMES);
  private idleCount = 0;
  /** What the bounds are multiplied by: 1 at 60 Hz or faster, 2 at 30 fps. */
  private stretch = 1;
  private stretchStale = false;

  /**
   * `deviceDpr` is the screen's pixel ratio: it starts at the sharpest step not above it, and
   * never climbs past that. `start`, a step remembered from the last visit, starts it lower:
   * where it begins, not a ceiling, so a machine that was slow once can earn the sharp steps back.
   */
  constructor(deviceDpr: number, start?: number) {
    this.device = Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
    // The least step not under the screen's ratio, drawn at the screen's own: 1.75 starts at
    // 1.75, then 1.5. Under the last (a page zoomed out on a 1× screen), the last; over the
    // first, the first.
    let top = 0;
    for (let i = 0; i < DPR_STEPS.length; i++) if (DPR_STEPS[i]! >= this.device - SLACK) top = i;
    this.top = top;
    this.own = top;
    this.at =
      start !== undefined && Number.isInteger(start) ? clamp(start, this.top, BARE) : this.top;
  }

  get level(): QualityLevel {
    const step = this.at;
    return {
      // Never above the screen's own ratio: drawing pixels it cannot show only costs.
      dpr: Math.min(DPR_STEPS[Math.min(step, BARE - 1)]!, this.device),
      grid: step < BARE,
      hidden: step < BARE,
    };
  }

  /** The step it is at. */
  get step(): number {
    return this.at;
  }

  /**
   * The step to start the next visit at, or a governor for another screen: only one it fell to.
   * One that never stepped down says nothing, so a screen sharper than this one starts at its
   * own sharpest, not at this one's.
   */
  get remembered(): number | undefined {
    return this.at > this.own ? this.at : undefined;
  }

  /**
   * A frame that drew nothing: its interval since the last, ms. Their median is how often the
   * browser draws, which no step can make shorter.
   */
  idle(intervalMs: number): void {
    if (!(intervalMs > 0) || intervalMs === Infinity) return;
    this.idleRing[this.idleCount++ % IDLE_FRAMES] = intervalMs;
    this.stretchStale = true;
  }

  /** A frame drawn while the camera moved: its interval since the last, ms. */
  moving(intervalMs: number): QualityLevel | null {
    // Not a frame's interval: a clock that went backwards, or nothing measured.
    if (!(intervalMs > 0) || intervalMs === Infinity) return null;
    const stretch = this.cadence();
    const i = this.frames++;
    // The rings start at zero, so until a window is full the frame a slot held counts nothing.
    const slow = intervalMs > SLOW_MS * stretch ? 1 : 0;
    this.slow += slow - this.slowRing[i % DOWN_FRAMES]!;
    this.slowRing[i % DOWN_FRAMES] = slow;
    const notFast = intervalMs < FAST_MS * stretch ? 0 : 1;
    this.notFast += notFast - this.notFastRing[i % UP_FRAMES]!;
    this.notFastRing[i % UP_FRAMES] = notFast;

    const n = this.frames;
    // Late frames are answered first: a window that is both late and early is late.
    if (n >= DOWN_FRAMES && this.slow >= SLOW_COUNT && this.at < BARE) {
      // Lost again after the one retry: that step is too much for this machine, now.
      const falls = (this.falls[this.at] ?? 0) + 1;
      this.falls[this.at] = falls;
      if (falls >= 2) this.top = this.at + 1;
      return this.change(this.at + 1);
    }
    if (n >= UP_FRAMES && this.notFast < NOT_FAST_COUNT && this.at > this.top)
      return this.change(this.at - 1);
    return null;
  }

  /** What the bounds are stretched by: the median frame at rest over a 60 Hz one, when well over it. */
  private cadence(): number {
    if (!this.stretchStale) return this.stretch;
    this.stretchStale = false;
    const n = Math.min(this.idleCount, IDLE_FRAMES);
    if (n < IDLE_MIN) return this.stretch;
    const sorted = this.idleRing.slice(0, n).sort();
    const median = sorted[n >> 1]!;
    this.stretch = median > VSYNC_MS * STRETCH_FROM ? median / VSYNC_MS : 1;
    return this.stretch;
  }

  /** Moves to `step` and starts counting afresh: frames drawn at the old step say nothing of the new. */
  private change(step: number): QualityLevel {
    this.at = step;
    this.frames = 0;
    this.slow = 0;
    this.notFast = 0;
    this.slowRing.fill(0);
    this.notFastRing.fill(0);
    return this.level;
  }
}
