// The Sentinel view's plugin over a fake stage and a stand-in for the
// controller: when the stage comes and goes, what falls back to the trail and
// what it plays there, when the cluster is built again, and that nothing ever
// plays on its own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boundsOf, type Camera, type Viewport } from '@/lib/graph-camera';
import type { GraphModel } from '@/lib/graph-model';

import type { PluginFrame, PluginStage } from '../graph-controller';

import { CrawlPlugin, type CrawlPluginOptions, type SentinelUi } from './crawl-plugin';
import type { CrawlSnapshot } from './crawl-snapshot';
import { sampleVault } from './sample-vault';
import { polylineThreadField } from './space/polyline-field';
import type { SpaceBuild } from './space/space';
import { volumeLayout } from './space/volume/layout';
import type { StageFactory, StageFrame, StageHandle } from './stage/stage-handle';
import { typicalLink } from './threads';

const VP: Viewport = { width: 800, height: 600 };

/** The sample vault laid out as the dormant network lays it out, without three. */
function clusterOf(model: GraphModel): SpaceBuild {
  const l = volumeLayout(model);
  const field = polylineThreadField({
    nodes: l.positions,
    routes: l.routes,
    adjacency: l.adjacency,
    cell: l.unit,
  });
  return {
    positions: l.positions,
    field,
    unit: l.unit,
    bounds: boundsOf([...l.positions.values()].map(([x, y, z]) => ({ x, y, z })))!,
    pace: 9 * l.unit,
    camera: { pitch: 0.3, follow: 8 },
  };
}

/** A stage that records what it is asked, and compiles only when the test says so. */
class FakeStage implements StageHandle {
  readonly canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: VP.width, height: VP.height }),
  } as unknown as HTMLCanvasElement;
  software = false;
  onLost: (() => void) | null = null;
  readonly log: string[] = [];
  builds = 0;
  /** The last frame it drew. */
  frame: StageFrame | null = null;
  decisions: ReadonlySet<string> | null = null;
  disposed = false;
  breakRender = false;
  private readonly warming: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  build(model: GraphModel): SpaceBuild {
    this.log.push('build');
    this.builds++;
    return clusterOf(model);
  }
  warmup(): Promise<void> {
    this.log.push('warmup');
    return new Promise((resolve, reject) => this.warming.push({ resolve, reject }));
  }
  /** Settles every warm-up asked for so far. */
  warm(ok = true): void {
    for (const w of this.warming.splice(0)) {
      if (ok) w.resolve();
      else w.reject(new Error('a shader'));
    }
  }
  setDecisions(ids: ReadonlySet<string>): void {
    this.decisions = new Set(ids);
  }
  shapeBezel(): void {}
  resize(): void {
    this.log.push('resize');
  }
  hold(): void {}
  snap(): void {
    this.log.push('snap');
  }
  finalPose(): void {
    this.log.push('finalPose');
  }
  render(f: StageFrame): void {
    if (this.breakRender) throw new Error('a frame');
    this.frame = f;
  }
  dispose(): void {
    this.disposed = true;
    this.log.push('dispose');
  }
}

/** A 2D context that does nothing and remembers what was called. */
function fakeCtx(): CanvasRenderingContext2D & { calls: string[]; texts: string[] } {
  const calls: string[] = [];
  const texts: string[] = [];
  const props: Record<string | symbol, unknown> = { calls, texts };
  return new Proxy(props, {
    get(t, key) {
      if (key in t) return t[key];
      return (...args: unknown[]) => {
        calls.push(String(key));
        if (key === 'fillText') texts.push(String(args[0]));
        if (key === 'measureText') return { width: String(args[0]).length * 6 };
        if (key === 'createRadialGradient') return { addColorStop() {} };
        return undefined;
      };
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { calls: string[]; texts: string[] };
}

/** The page's prompt: a box in the middle of the stage, and the chrome the levels are written on. */
function page() {
  const vars = new Map<string, string>();
  const chrome = {
    style: {
      setProperty: (name: string, value: string) => vars.set(name, value),
      removeProperty: (name: string) => vars.delete(name),
    },
  } as unknown as HTMLElement;
  const box = {
    getBoundingClientRect: () => ({ left: 120, top: 272, width: 560, height: 56 }),
  } as unknown as HTMLElement;
  return { box, chrome, vars };
}

/**
 * The controller as the plugin meets it: stage mode while `stage` is non-null
 * (the overview, a resize, then each frame the stage's camera, the follow,
 * its render and the plugin's draw), the graph's frame otherwise.
 */
class Host {
  cam: Camera = { tx: 0, ty: 0, tz: 0, yaw: 0.2, pitch: 0.1, dist: 400 };
  now = 1000;
  staged: PluginStage | null = null;
  entered = 0;
  readonly ctx = fakeCtx();

  constructor(
    readonly plugin: CrawlPlugin,
    public model: GraphModel,
  ) {}

  frame(dt = 16): void {
    const last = this.now;
    this.now += dt;
    const f: PluginFrame = {
      now: this.now,
      dt: Math.min(64, this.now - last),
      cam: this.cam,
      vp: VP,
      dpr: 1,
      model: this.model,
      reduceMotion: false,
      settled: true,
    };
    const stage = this.plugin.stage ?? null;
    if (stage !== this.staged) {
      this.staged = stage;
      if (stage) {
        this.entered++;
        this.cam = { ...stage.overview(VP) };
        stage.resize(VP, 1);
      }
    }
    const held = stage ? stage.camera(f) : null;
    if (held) this.cam = held;
    else {
      const t = this.plugin.follow();
      if (t) {
        const k = 1 - Math.exp(-f.dt / 450);
        const c = this.cam;
        this.cam = {
          ...c,
          tx: c.tx + (t.x - c.tx) * k,
          ty: c.ty + (t.y - c.ty) * k,
          tz: c.tz + (t.z - c.tz) * k,
          dist: c.dist + (t.dist - c.dist) * k,
        };
      }
    }
    f.cam = this.cam;
    stage?.render(f);
    this.plugin.draw(this.ctx, f);
  }

  frames(n: number, dt = 16): void {
    for (let i = 0; i < n; i++) this.frame(dt);
  }

  /** Frames until `done` holds; fails after a simulated ten minutes. */
  until(done: () => boolean): void {
    for (let i = 0; i < 40_000 && !done(); i++) this.frame();
    expect(done()).toBe(true);
  }
}

/** Every microtask and timer due now: an import or a compile that has settled is heard. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(opts: Partial<CrawlPluginOptions> & { stage?: FakeStage } = {}) {
  const vault = sampleVault();
  const stage = opts.stage ?? new FakeStage();
  const uis: SentinelUi[] = [];
  const snaps: CrawlSnapshot[] = [];
  const factory = vi.fn<StageFactory>(() => stage);
  const plugin = new CrawlPlugin({
    still: false,
    sentinel: true,
    onSnapshot: (s) => snaps.push(s),
    onUi: (u) => uis.push(u),
    loadStage: () => Promise.resolve(factory),
    ...opts,
  });
  const dom = page();
  plugin.attach(dom);
  const host = new Host(plugin, vault.model);
  const ui = () => uis.at(-1)!;
  const snap = () => snaps.at(-1)!;
  return { vault, stage, factory, plugin, host, uis, snaps, dom, ui, snap };
}

/** Set up, the stage loaded, built and compiled, and the first stage frame drawn: at the prompt. */
async function ready(opts: Partial<CrawlPluginOptions> & { stage?: FakeStage } = {}) {
  const s = setup(opts);
  await flush();
  s.host.frame();
  s.stage.warm();
  await flush();
  s.host.frame();
  return s;
}

/** In the crawl, the way in over: the timeline let the camera go. */
const arrived = (stage: FakeStage) => {
  const sc = stage.frame?.scene;
  return !!sc && sc.scene === 'crawl' && !sc.moving && !sc.handoff;
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('getComputedStyle', () => ({
    borderTopLeftRadius: '16px',
    getPropertyValue: () => '',
  }));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CrawlPlugin starting', () => {
  it('keeps the brain under an inert prompt until the stage is compiled, then opens on the prompt', async () => {
    const s = setup();
    await flush();
    s.host.frame();
    // Sized by the frame it was made in.
    expect(s.factory).toHaveBeenCalledWith({ vp: VP, dpr: 1 });
    expect(s.stage.log).toEqual(['resize', 'build', 'warmup']);
    expect(s.plugin.stage).toBeNull();
    expect(s.ui()).toMatchObject({ status: 'starting', scene: 'prompt', interactive: false });
    expect(s.plugin.play(s.vault.crawls.walk, 'a question')).toBe(false);
    expect(s.dom.vars.get('--crawl-prompt')).toBe('1.0000');

    s.stage.warm();
    await flush();
    const facade = s.plugin.stage;
    expect(facade).not.toBeNull();
    // One object for as long as it is ready: the controller compares it every frame.
    expect(s.plugin.stage).toBe(facade);
    expect(facade!.canvas).toBe(s.stage.canvas);
    expect(facade!.locked).toBe(true);
    s.host.frame();
    expect(s.host.entered).toBe(1);
    expect(s.ui()).toMatchObject({ status: 'sentinel', scene: 'prompt', interactive: true });
    expect(s.ui().focus).toBe(1);
    const f = s.stage.frame!;
    expect(f.scene!.atRest).toBe(true);
    expect(f.sentinel).toBe(true);
    // The prompt scene holds the camera on the perch shot.
    expect(s.host.cam).toEqual(f.scene!.camera);
    expect(s.dom.vars.get('--crawl-frame-below')).toMatch(/px$/);
    expect(s.stage.log).toContain('snap');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the brain out of sight while the stage starts, and not once it is ready', async () => {
    const s = setup();
    expect(s.plugin.veil).toBe(true);
    await flush();
    s.host.frame();
    expect(s.plugin.veil).toBe(true);
    s.stage.warm();
    await flush();
    expect(s.plugin.veil).toBe(false);
    s.plugin.dispose();
    expect(s.plugin.veil).toBe(false);
  });

  it('shows the brain on the trail: the walk is drawn over it', async () => {
    const s = setup({ loadStage: () => Promise.reject(new Error('offline')) });
    await flush();
    expect(s.ui().status).toBe('trail');
    expect(s.plugin.veil).toBe(false);
  });

  it('plays nothing unless it is asked to', async () => {
    const s = await ready();
    s.host.frames(600);
    expect(s.snaps.every((snap) => snap.state === 'idle')).toBe(true);
    expect(s.stage.frame!.scene!.atRest).toBe(true);
    expect(s.ui().scene).toBe('prompt');
  });

  it('creates no stage when it goes before the import lands', async () => {
    let land: (f: StageFactory) => void = () => {};
    const s = setup({ loadStage: () => new Promise<StageFactory>((resolve) => (land = resolve)) });
    s.host.frame();
    s.plugin.dispose();
    land(s.factory);
    await flush();
    s.host.frames(3);
    expect(s.factory).not.toHaveBeenCalled();
    expect(s.dom.vars.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing of a compile that fails after it went', async () => {
    const s = setup();
    await flush();
    s.host.frame();
    s.plugin.dispose();
    expect(s.stage.disposed).toBe(true);
    s.stage.warm(false);
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up after ten seconds of frames, not ten seconds of a hidden tab', async () => {
    const s = setup();
    await flush();
    s.host.frame();
    // A background tab: no frames for a minute, and the one after it counts 64 ms.
    s.host.now += 60_000;
    s.host.frame();
    expect(s.ui().status).toBe('starting');
    s.host.frames(9_800 / 16);
    expect(s.ui().status).toBe('starting');
    s.host.frames(20);
    expect(s.ui()).toMatchObject({
      status: 'trail',
      failure: 'the stage took too long to start',
      interactive: true,
    });
    expect(s.stage.disposed).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('CrawlPlugin on the trail', () => {
  it('takes a send at the prompt when the chunk fails, and walks it over the brain', async () => {
    const s = setup({ loadStage: () => Promise.reject(new Error('a stale chunk')) });
    await flush();
    expect(s.ui()).toMatchObject({
      status: 'trail',
      failure: 'the stage failed to load',
      scene: 'prompt',
      interactive: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Sentinel: the stage failed to load');
    s.host.frames(3);
    expect(s.plugin.stage).toBeNull();
    // Nothing loaded, nothing drawn.
    expect(s.host.ctx.calls).not.toContain('createRadialGradient');

    expect(s.plugin.play(s.vault.crawls.walk, 'a question')).toBe(true);
    expect(s.ui()).toMatchObject({ scene: 'crawl', interactive: false });
    expect(s.dom.vars.get('--crawl-panel')).toBe('0.0000');
    s.host.frame();
    expect(s.dom.vars.get('--crawl-panel')).toBe('1.0000');
    s.host.until(() => s.snap().state === 'walking');
    // Followed as the brain's walk is followed: twelve of its links away.
    expect(s.plugin.follow()!.dist).toBeCloseTo(typicalLink(s.vault.model) * 12, 6);
    // The light where the walk is; then what it found, haloed and labelled.
    expect(s.host.ctx.calls).toContain('createRadialGradient');
    s.host.until(() => s.snap().found.named > 0);
    s.host.frame();
    expect(s.host.ctx.calls).toContain('fillText');
    expect(s.plugin.stage).toBeNull();
  });

  it('disposes a software stage at once', async () => {
    const stage = new FakeStage();
    stage.software = true;
    const s = setup({ stage });
    await flush();
    s.host.frame();
    expect(stage.disposed).toBe(true);
    expect(stage.builds).toBe(0);
    expect(s.ui()).toMatchObject({ status: 'trail', failure: 'a software renderer' });
  });

  it('falls back when there is no WebGL, or a shader fails', async () => {
    const none = setup({
      loadStage: () =>
        Promise.resolve(() => {
          throw new Error('no context');
        }),
    });
    await flush();
    none.host.frame();
    expect(none.ui()).toMatchObject({ status: 'trail', failure: 'no WebGL for the stage' });

    const shader = setup();
    await flush();
    shader.host.frame();
    shader.stage.warm(false);
    await flush();
    expect(shader.ui()).toMatchObject({ status: 'trail', failure: 'a shader failed to compile' });
    expect(shader.stage.disposed).toBe(true);
    expect(shader.plugin.stage).toBeNull();
  });

  it('goes back to the prompt on New search: the walk cleared, the prompt focused again', async () => {
    const s = setup({ loadStage: () => Promise.reject(new Error('offline')) });
    await flush();
    s.host.frame();
    const focus = s.ui().focus;
    expect(s.plugin.play(s.vault.crawls.walk, 'a question')).toBe(true);
    s.host.until(() => s.snap().state === 'walking');
    expect(s.plugin.newSearch()).toBe(true);
    expect(s.ui()).toMatchObject({ scene: 'prompt', interactive: true });
    expect(s.ui().focus).toBe(focus + 1);
    expect(s.snap().state).toBe('idle');
    expect(s.snap().log).toHaveLength(0);
    s.host.frame();
    expect(s.dom.vars.get('--crawl-prompt')).toBe('1.0000');
    expect(s.dom.vars.get('--crawl-panel')).toBe('0.0000');
  });
});

describe('CrawlPlugin in the Sentinel view', () => {
  it('goes into the crawl on a send and back to the frame on New search, even paused', async () => {
    const s = await ready();
    expect(s.plugin.play(s.vault.crawls.walk, 'a question')).toBe(true);
    expect(s.ui()).toMatchObject({ scene: 'crawl', interactive: false });
    // On the way in the camera is the user's to take again.
    s.host.frame();
    expect(s.plugin.stage!.locked).toBe(false);
    s.host.until(() => arrived(s.stage));
    expect(s.snaps.some((snap) => snap.state === 'walking')).toBe(true);
    // Followed from the space's own distance, not the brain's.
    const build = clusterOf(s.vault.model);
    expect(s.plugin.follow()!.dist).toBeCloseTo(build.unit * build.camera.follow, 6);

    s.plugin.setPlaying(false);
    expect(s.plugin.newSearch()).toBe(true);
    expect(s.ui()).toMatchObject({ scene: 'prompt', interactive: false });
    expect(s.plugin.stage!.locked).toBe(true);
    // The way back runs on the walk's clock: it lands although the walk had been paused.
    s.host.until(() => s.ui().interactive);
    expect(s.ui().focus).toBe(2);
    expect(s.stage.frame!.scene!.atRest).toBe(true);
  });

  it('tells the stage what records a decision: the graph, and the crawl on screen', async () => {
    const s = await ready();
    expect(s.stage.decisions).toEqual(new Set());
    s.plugin.play(s.vault.crawls.walk, 'a question');
    const path = s.vault.crawls.walk.notes.find((n) => n.isDecision)!.path;
    const id = s.vault.model.nodes.find((n) => n.path === path)!.id;
    expect(s.stage.decisions).toEqual(new Set([id]));
  });

  it('plays a crawl again over the brain when the context is lost mid-walk', async () => {
    const s = await ready();
    s.plugin.play(s.vault.crawls.walk, 'a question');
    s.host.until(() => arrived(s.stage));
    s.stage.onLost!();
    expect(s.plugin.stage).toBeNull();
    expect(s.stage.disposed).toBe(true);
    expect(s.ui()).toMatchObject({
      status: 'trail',
      scene: 'crawl',
      failure: 'the WebGL context was lost',
    });
    expect(s.snap().state).not.toBe('done');
    expect(s.snap().coverage).toEqual(s.vault.crawls.walk.coverage);
    s.host.until(() => s.snap().state === 'walking');
    expect(s.plugin.follow()!.dist).toBeCloseTo(typicalLink(s.vault.model) * 12, 6);
  });

  it('shows a finished crawl at its end over the brain when the context is lost', async () => {
    const s = await ready();
    s.plugin.play(s.vault.crawls.walk, 'a question');
    s.host.until(() => arrived(s.stage));
    s.plugin.setReducedMotion(true);
    s.plugin.setReducedMotion(false);
    expect(s.snap().state).toBe('done');
    s.stage.onLost!();
    expect(s.snap().state).toBe('done');
    expect(s.ui().scene).toBe('crawl');
  });

  it('falls back on a frame that throws, never into the controller', async () => {
    const s = await ready();
    s.stage.breakRender = true;
    expect(() => s.host.frame()).not.toThrow();
    expect(s.ui()).toMatchObject({ status: 'trail', failure: 'a frame failed', scene: 'prompt' });
    s.host.frame();
    expect(s.host.staged).toBeNull();
  });

  it('skips to the end of the walk on request, and does nothing at the prompt', async () => {
    const s = await ready();
    s.plugin.skipToEnd();
    expect(s.snap().state).toBe('idle');
    s.plugin.play(s.vault.crawls.walk, 'a question');
    s.host.until(() => s.snap().state === 'walking');
    s.plugin.skipToEnd();
    expect(s.snap().state).toBe('done');
    const { found, reached } = s.snap();
    expect(reached).toHaveLength(found.named + found.linked + found.decision);
    expect(reached.length).toBeGreaterThan(0);
  });

  it('rings the note the panel points at, over the trail, and lets it go', async () => {
    const s = setup({ loadStage: () => Promise.reject(new Error('offline')) });
    await flush();
    s.host.frame();
    expect(s.plugin.play(s.vault.crawls.walk, 'a question')).toBe(true);
    s.host.until(() => s.snap().reached.length > 0);
    const key = s.snap().reached[0]!;
    const title = s.vault.model.nodes.find((n) => n.path === key)!.label;
    s.plugin.mark(key);
    s.host.ctx.texts.length = 0;
    s.host.frame();
    // The mark says the bare title; the walk's own labels say why it was found.
    expect(s.host.ctx.texts).toContain(title);
    s.plugin.mark(null);
    s.host.ctx.texts.length = 0;
    s.host.frame();
    expect(s.host.ctx.texts).not.toContain(title);
    // A key the graph does not show rings nothing, and breaks nothing.
    s.plugin.mark('no/such/note.md');
    expect(() => s.host.frame()).not.toThrow();
  });

  it('changes nothing when reduced motion is set to what it already is', async () => {
    const s = await ready();
    s.plugin.play(s.vault.crawls.walk, 'a question');
    s.host.until(() => arrived(s.stage));
    s.plugin.setReducedMotion(false);
    expect(s.snap().state).not.toBe('done');
  });
});

describe('CrawlPlugin and a rebuilt model', () => {
  /** The model with its index notes gone, as the indexes layer turned off leaves it. */
  function withoutIndexes(m: GraphModel): GraphModel {
    const nodes = m.nodes.filter((n) => !n.isIndex);
    const kept = new Set(nodes);
    return {
      ...m,
      nodes,
      edges: m.edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
      adjacency: new Map(
        nodes.map((n) => [n, (m.adjacency.get(n) ?? []).filter((x) => kept.has(x.node))]),
      ),
      labelOrder: m.labelOrder.filter((n) => kept.has(n)),
    };
  }

  it('builds nothing again for a model the cluster reads the same', async () => {
    const s = await ready();
    // The same vault built again: the same notes, as new objects.
    s.host.model = sampleVault().model;
    s.host.frames(60);
    expect(s.stage.builds).toBe(1);
  });

  it('builds again 300 ms after the layout changed, and rests on the frame again', async () => {
    const s = await ready();
    s.host.model = withoutIndexes(s.vault.model);
    s.host.frames(18);
    expect(s.stage.builds).toBe(1);
    s.host.frames(2);
    expect(s.stage.builds).toBe(2);
    expect(s.stage.log.at(-1)).not.toBe('dispose');
    s.stage.warm();
    await flush();
    s.host.frame();
    expect(s.ui()).toMatchObject({ status: 'sentinel', scene: 'prompt', interactive: true });
    expect(s.stage.frame!.scene!.atRest).toBe(true);
  });

  it('starts a walking crawl over from its first note, and shows a finished one at its end', async () => {
    const walking = await ready();
    walking.plugin.play(walking.vault.crawls.walk, 'a question');
    walking.host.until(() => arrived(walking.stage));
    walking.host.frames(60);
    const clock = walking.stage.frame!.view.clock;
    expect(clock).toBeGreaterThan(1);
    walking.host.model = withoutIndexes(walking.vault.model);
    walking.host.frames(20);
    expect(walking.stage.builds).toBe(2);
    expect(walking.stage.log.slice(-3)).toEqual(['build', 'snap', 'warmup']);
    expect(walking.stage.frame!.view.clock).toBeLessThan(0.1);
    expect(walking.stage.frame!.view.mode).not.toBe('done');
    expect(walking.ui().scene).toBe('crawl');

    const done = await ready();
    done.plugin.play(done.vault.crawls.walk, 'a question');
    done.host.until(() => arrived(done.stage));
    done.plugin.setReducedMotion(true);
    done.plugin.setReducedMotion(false);
    done.host.model = withoutIndexes(done.vault.model);
    done.host.frames(20);
    expect(done.stage.builds).toBe(2);
    expect(done.stage.log.slice(-3)).toEqual(['build', 'finalPose', 'warmup']);
    expect(done.stage.frame!.view.mode).toBe('done');
  });
});
