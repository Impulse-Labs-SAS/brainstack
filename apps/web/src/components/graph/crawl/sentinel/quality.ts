// How much Sentinel this machine can carry — pure, no three, no DOM, tested
// directly.
//
// Two decisions live here. The starting tier comes from what the GPU says it
// is before anything is drawn: a software rasteriser gets the trail of light,
// a card that cannot render to half-float targets gets the lightest tier, and
// everything else starts where its class usually holds 60 fps. After that the
// governor watches frames at rest and steps the tier down when they slip, or
// back up when the GPU timer proves there is room.
//
// Frame times are the raw distance between `now`s, never the controller's
// `dt`: that one is capped at 64 ms to keep animations sane, and a governor
// reading it would be blind on exactly the machines that need it most. Only
// frames at rest count — while the layout settles the graph itself costs more
// than a frame, and that is not the Sentinel's to fix.
//
// Tiers come from tiers.ts and never change a shader's program key, so a step
// in either direction is a few buffer counts, never a compile.

import type { Tier } from './tiers';

/** What the probe learns about the GPU before the first frame. */
export interface Caps {
  /** The renderer string, unmasked when the browser allows it. */
  renderer: string | null;
  /** Whether a half-float target can be rendered to: bloom and the environment need it. */
  floatColor: boolean;
  maxSamples: number;
  /** Whether `EXT_disjoint_timer_query_webgl2` is there to measure the Sentinel's own GPU time. */
  timer: boolean;
  dpr: number;
  /** Drawing-buffer pixels: the canvas size times its pixel ratio. */
  pixels: number;
}

export type GpuClass = 'software' | 'integrated' | 'discrete' | 'unknown';

// Checked against the whole string: ANGLE names its backend and driver too,
// and a SwiftShader context is software whatever vendor it claims.
const SOFTWARE =
  /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render|software rasterizer/i;

// Exceptions first: vendors that make both kinds name some of their chips in a
// way the broad patterns below would put in the wrong class. Discrete names
// are tried before integrated ones because a Mac's ANGLE string says "Apple"
// whatever GPU it runs on.
const RULES: ReadonlyArray<readonly [RegExp, GpuClass]> = [
  // AMD's APUs, and NVIDIA's Tegra, are integrated.
  [
    /radeon(\(tm\))?\s*((r\d|vega\s*\d+)\s*)?graphics|radeon(\(tm\))?\s*\d{3}m\b|tegra/i,
    'integrated',
  ],
  // Intel's Arc A-series cards are discrete; the Arc in a laptop chip has no model number.
  [/\barc(\(tm\))?\s*a\d{3}/i, 'discrete'],
  [/nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon|firepro|\bamd\b/i, 'discrete'],
  [/\bintel\b|\biris\b|\buhd\b|hd graphics|apple|mali|adreno|powervr|videocore/i, 'integrated'],
];

/** What kind of GPU a renderer string names. Masked or missing names are unknown. */
export function classifyRenderer(name: string | null): GpuClass {
  if (!name) return 'unknown';
  if (SOFTWARE.test(name)) return 'software';
  for (const [pattern, kind] of RULES) if (pattern.test(name)) return kind;
  return 'unknown';
}

/** Above this many drawing-buffer pixels, the glow and the hull's fill cost too much for tier 3. */
const LARGE_BUFFER_PX = 4.5e6;

const lower = (a: Tier, b: Tier): Tier => (a < b ? a : b);

/**
 * The tier to start at, or the trail when the Sentinel should not be drawn at
 * all. `lastStable` is where an earlier crawl on this page settled: starting
 * above it would only replay the same step down.
 */
export function startTier(caps: Caps, lastStable: Tier | null): Tier | 'trail' {
  const gpu = classifyRenderer(caps.renderer);
  if (gpu === 'software') return 'trail';
  let tier: Tier = !caps.floatColor ? 0 : gpu === 'discrete' ? 3 : 2;
  if (caps.pixels > LARGE_BUFFER_PX) tier = lower(tier, 2);
  if (lastStable !== null) tier = lower(tier, lastStable);
  return tier;
}

// Where the last crawl on this page settled. A module variable on purpose: it
// survives leaving and re-entering Crawl, and dies with the page — whatever
// slowed this machine down before a reload, under another load, is no reason
// to start low after it.
let stable: Tier | null = null;

/**
 * Remember the tier a crawl ended at. One that ended on the trail still tries
 * the lightest tier next time: the overload may have been passing.
 */
export function rememberStable(tier: Tier | 'trail'): void {
  stable = tier === 'trail' ? 0 : tier;
}

export function recallStable(): Tier | null {
  return stable;
}

export interface FrameSample {
  /** `performance.now()` at the frame, in ms. */
  now: number;
  /** No layout ticks, warm-up or growth this frame: the graph is at rest. */
  settled: boolean;
  /** The Sentinel's own CPU time this frame. */
  cpuMs: number;
  /** Its GPU time, when the timer has a finished measurement to report. */
  gpuMs: number | null;
}

export interface Decision {
  tier: Tier | 'trail';
  changed: boolean;
  reason: 'missed' | 'cpu' | 'gpu' | 'headroom' | 'overload' | null;
}

export interface GovernorOptions {
  /** Accepted frames per decision. */
  window: number;
  /** Share of missed frames in a window that steps the tier down. */
  missRatio: number;
  /** Least time between two changes. */
  cooldownMs: number;
  /** Frames ignored after a hold or a change: compiles, uploads and a resize all stutter once. */
  graceMs: number;
  /** How long a step down keeps the tier it left out of reach. */
  ceilingMs: number;
}

const DEFAULTS: GovernorOptions = {
  window: 120,
  missRatio: 0.25,
  cooldownMs: 2000,
  graceMs: 1200,
  ceilingMs: 30_000,
};

/**
 * The frame period aimed for is never shorter than 60 Hz: a 144 Hz screen is
 * no reason to shed detail.
 */
const MIN_PERIOD_MS = 1000 / 60;
/** A longer gap is a hidden tab or a stalled page, not a slow frame. */
const GAP_MS = 250;
/** Frames the vsync estimate looks back over. */
const VSYNC_FRAMES = 60;
/**
 * The longest refresh period the estimate believes, 50 Hz. A GPU that holds a
 * steady 30 fps looks exactly like a 30 Hz display, and without a timer
 * nothing tells them apart; the first is the common one — an integrated GPU
 * carrying too much — and believing it a display would never miss a frame.
 */
const MAX_VSYNC_MS = 20;
/**
 * The Sentinel's budget, as shares of the frame period: CPU and GPU limits
 * that step it down, the GPU time under which a window counts as clean, and
 * the GPU time that sends it to the trail from the lowest tier.
 */
const CPU_LIMIT = 0.12;
const GPU_LIMIT = 0.25;
const GPU_CLEAN = 0.1;
const GPU_OVERLOAD = 0.5;
/**
 * The timer's elapsed time is not the Sentinel's alone. On a shared GPU the
 * browser's compositor, other canvases and other apps run between its begin
 * and end, and their work is counted too — the lab measured 6.6 ms for 0.25 ms
 * of Sentinel while a screen recorder was capturing. So a long GPU time steps
 * down only when frames are being missed as well: that is the evidence the
 * time is real and costs something.
 */
const GPU_MISS_RATIO = 0.05;
/**
 * A clean window also needs the CPU at half its limit: stepping up adds
 * segments and iterations, and a step up that is undone a window later is
 * worse than none.
 */
const CPU_CLEAN = CPU_LIMIT / 2;
const CLEAN_MISS_RATIO = 0.02;
const CLEAN_WINDOWS = 3;
/**
 * How long the lowest tier must overload the GPU before the Sentinel gives way
 * to the trail. Dropping the creature mid-crawl is drastic; one bad window, a
 * driver hiccup or another tab's burst, is not enough for it.
 */
const OVERLOAD_MS = 5000;
const LOG_LINES = 64;

const label = (t: Tier | 'trail'): string => (t === 'trail' ? 'trail' : `T${t}`);
const ms = (v: number): string => `${v.toFixed(2)} ms`;

/** Median of the first `n` values of `src`, sorted in `scratch`; NaN entries are skipped. */
function median(
  src: Float64Array,
  n: number,
  scratch: Float64Array,
): { value: number; count: number } {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    if (!Number.isNaN(v)) scratch[m++] = v;
  }
  if (m === 0) return { value: NaN, count: 0 };
  const sorted = scratch.subarray(0, m).sort();
  const mid = m >> 1;
  const value = m % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { value, count: m };
}

/**
 * Steps the Sentinel's tier with the frame rate at rest.
 *
 * Feed it one `sample` per frame, settled or not — the unsettled ones are what
 * tell it the next frame's time is the graph's, not the Sentinel's. A step down
 * from tier k keeps k out of reach for `ceilingMs`; a second step down from k
 * keeps it out for the session, which is what stops alternating load from
 * swinging the tier back and forth.
 */
export class QualityGovernor {
  private readonly opts: GovernorOptions;
  private auto: Tier | 'trail';
  private forced: Tier | null = null;

  // The decision window: a ring of accepted frames. NaN in `gpu` is a frame
  // with no finished GPU measurement.
  private readonly at: Float64Array;
  private readonly dt: Float64Array;
  private readonly cpu: Float64Array;
  private readonly gpu: Float64Array;
  private readonly scratch: Float64Array;
  private head = 0;
  private count = 0;

  private readonly recent = new Float64Array(VSYNC_FRAMES);
  private readonly recentSorted = new Float64Array(VSYNC_FRAMES);
  private recentHead = 0;
  private recentCount = 0;
  private vsync = MIN_PERIOD_MS;
  private vsyncStale = false;

  private prevNow: number | null = null;
  private prevSettled = false;
  // The first frames after a start are as untrustworthy as those after a
  // hold, so a grace starts on the first sample unless `hold` set one.
  private holdPending = true;
  private holdUntil = -Infinity;
  private lastChange = -Infinity;
  private cleanWindows = 0;
  private overloadSince: number | null = null;
  private ceiling: Tier = 3;
  private tempCeiling: Tier = 3;
  private tempUntil = -Infinity;
  private readonly downsFrom = [0, 0, 0, 0];

  private t0: number | null = null;
  private lastNow = 0;
  private readonly lines: string[] = [];

  constructor(
    start: Tier,
    private readonly timer: boolean,
    opts?: Partial<GovernorOptions>,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.auto = start;
    const n = Math.max(1, Math.round(this.opts.window));
    this.at = new Float64Array(n);
    this.dt = new Float64Array(n);
    this.cpu = new Float64Array(n);
    this.gpu = new Float64Array(n);
    this.scratch = new Float64Array(n);
  }

  /** The tier to draw at: the lab's forced one, else the governor's own. */
  get tier(): Tier | 'trail' {
    return this.forced ?? this.auto;
  }

  /** The estimated display refresh period, in ms. */
  get vsyncMs(): number {
    if (this.vsyncStale) {
      const n = this.recentCount;
      const sorted = this.recentSorted.subarray(0, n);
      sorted.set(this.recent.subarray(0, n));
      sorted.sort();
      // The 10th percentile: frames that made vsync, ignoring the rare one
      // that came early after a late one.
      const p10 = sorted[Math.max(0, Math.ceil(0.1 * n) - 1)]!;
      this.vsync = Math.min(MAX_VSYNC_MS, Math.max(4, p10));
      this.vsyncStale = false;
    }
    return this.vsync;
  }

  /** What the governor decided and why, oldest first, for the lab. */
  get log(): readonly string[] {
    return this.lines;
  }

  sample(s: FrameSample): Decision {
    if (this.t0 === null) this.t0 = s.now;
    this.lastNow = s.now;
    if (this.holdPending) {
      this.holdUntil = Math.max(this.holdUntil, s.now + this.opts.graceMs);
      this.holdPending = false;
    }
    const dt = this.prevNow === null ? 0 : s.now - this.prevNow;
    // A frame's time is spent by the frame before it: after an unsettled
    // frame, this one's dt still carries the layout's tick.
    const counts =
      s.settled && this.prevSettled && dt > 0 && dt <= GAP_MS && s.now >= this.holdUntil;
    this.prevNow = s.now;
    this.prevSettled = s.settled;
    if (!counts || this.auto === 'trail') return this.verdict(false, null);

    this.noteVsync(dt);
    if (this.forced !== null) return this.verdict(false, null);

    const n = this.at.length;
    const i = this.head;
    this.at[i] = s.now;
    this.dt[i] = dt;
    this.cpu[i] = s.cpuMs;
    this.gpu[i] = this.timer && s.gpuMs !== null ? s.gpuMs : NaN;
    this.head = (i + 1) % n;
    if (this.count < n) this.count++;
    // A window that fills during the cooldown keeps sliding, so the decision,
    // when it comes, reads the latest frames.
    if (this.count < n || s.now - this.lastChange < this.opts.cooldownMs) {
      return this.verdict(false, null);
    }
    const reason = this.decide(s.now);
    this.clearWindow();
    return this.verdict(reason !== null, reason);
  }

  /** Ignore frames for a while: after a load, a context restore or a resize. */
  hold(now: number): void {
    this.holdUntil = Math.max(this.holdUntil, now + this.opts.graceMs);
    this.holdPending = false;
    this.clearWindow();
    this.cleanWindows = 0;
    this.overloadSince = null;
  }

  /** The lab's override: draw at this tier whatever the frames say; null hands it back. */
  force(tier: Tier | null): void {
    if (tier === this.forced) return;
    this.forced = tier;
    // Frames drawn at a forced tier say nothing about the governor's own.
    this.clearWindow();
    this.cleanWindows = 0;
    this.overloadSince = null;
    this.holdPending = true;
    this.say(
      this.lastNow,
      tier === null ? `auto again at ${label(this.auto)}` : `forced ${label(tier)}`,
    );
  }

  private verdict(changed: boolean, reason: Decision['reason']): Decision {
    return { tier: this.tier, changed, reason };
  }

  private noteVsync(dt: number): void {
    this.recent[this.recentHead] = dt;
    this.recentHead = (this.recentHead + 1) % VSYNC_FRAMES;
    if (this.recentCount < VSYNC_FRAMES) this.recentCount++;
    this.vsyncStale = true;
  }

  private clearWindow(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Reads a full window; returns why the tier changed, or null. */
  private decide(now: number): Decision['reason'] {
    const tier = this.auto;
    if (tier === 'trail') return null;
    const n = this.count;
    const vsync = this.vsyncMs;
    const period = Math.max(vsync, MIN_PERIOD_MS);
    const late = period + vsync / 2;
    let missed = 0;
    for (let i = 0; i < n; i++) if (this.dt[i]! > late) missed++;
    const missRatio = missed / n;
    const cpu = median(this.cpu, n, this.scratch).value;
    const readings = median(this.gpu, n, this.scratch);
    // Too few readings make a median of noise: the timer's results arrive
    // frames late and a disjoint event throws a batch away.
    const gpu = this.timer && readings.count >= n / 4 ? readings.value : null;
    const costly = missRatio >= GPU_MISS_RATIO;

    const why: Decision['reason'] =
      cpu > CPU_LIMIT * period
        ? 'cpu'
        : gpu !== null && gpu > GPU_LIMIT * period && costly
          ? 'gpu'
          : missRatio >= this.opts.missRatio
            ? 'missed'
            : null;

    if (why !== null) {
      this.cleanWindows = 0;
      if (tier > 0) {
        this.overloadSince = null;
        const detail =
          why === 'cpu'
            ? `median CPU ${ms(cpu)} over ${ms(CPU_LIMIT * period)}`
            : why === 'gpu'
              ? `median GPU ${ms(gpu ?? 0)} over ${ms(GPU_LIMIT * period)}`
              : `${Math.round(missRatio * 100)}% of ${n} frames missed (vsync ${ms(vsync)})`;
        this.stepDown(tier, now, why, detail);
        return why;
      }
      // At the floor only the timer can tell the Sentinel's cost from the
      // graph's; frame times alone never send it to the trail.
      if (gpu !== null && gpu > GPU_OVERLOAD * period && costly) {
        // The window is full, so `head` is its oldest frame: overload is timed from there.
        this.overloadSince ??= this.at[this.head]!;
        if (now - this.overloadSince >= OVERLOAD_MS) {
          const limit = ms(GPU_OVERLOAD * period);
          this.change(
            'trail',
            now,
            `median GPU ${ms(gpu)} over ${limit} at T0 for ${OVERLOAD_MS / 1000} s`,
          );
          return 'overload';
        }
      } else {
        this.overloadSince = null;
      }
      return null;
    }
    this.overloadSince = null;

    if (!this.timer) return null;
    const clean =
      missRatio < CLEAN_MISS_RATIO &&
      gpu !== null &&
      gpu < GPU_CLEAN * period &&
      cpu < CPU_CLEAN * period;
    this.cleanWindows = clean ? this.cleanWindows + 1 : 0;
    if (this.cleanWindows < CLEAN_WINDOWS || tier >= this.ceilingAt(now)) return null;
    this.change(
      (tier + 1) as Tier,
      now,
      `${this.cleanWindows} clean windows, median GPU ${ms(gpu ?? 0)}`,
    );
    return 'headroom';
  }

  private ceilingAt(now: number): Tier {
    return now < this.tempUntil ? lower(this.ceiling, this.tempCeiling) : this.ceiling;
  }

  private stepDown(from: Tier, now: number, why: string, detail: string): void {
    const to = (from - 1) as Tier;
    this.change(to, now, `${why}: ${detail}`);
    const downs = (this.downsFrom[from] ?? 0) + 1;
    this.downsFrom[from] = downs;
    if (downs >= 2) {
      this.ceiling = lower(this.ceiling, to);
      this.say(now, `${label(from)} is out of reach for the session`);
    } else {
      this.tempCeiling = to;
      this.tempUntil = now + this.opts.ceilingMs;
      this.say(now, `${label(from)} is out of reach for ${this.opts.ceilingMs / 1000} s`);
    }
  }

  private change(to: Tier | 'trail', now: number, why: string): void {
    this.say(now, `${label(this.auto)} → ${label(to)}, ${why}`);
    this.auto = to;
    this.lastChange = now;
    this.cleanWindows = 0;
    this.holdUntil = Math.max(this.holdUntil, now + this.opts.graceMs);
  }

  private say(now: number, text: string): void {
    const t = ((now - (this.t0 ?? now)) / 1000).toFixed(1);
    this.lines.push(`${t} s  ${text}`);
    if (this.lines.length > LOG_LINES) this.lines.shift();
  }
}
