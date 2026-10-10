// The controller in Node, over stand-ins for the DOM, the 2D canvas and the WebGL scene, so what
// it draws can be recorded. The golden test is what keeps a feature built over the graph (a
// GraphPlugin) from changing Brain, Network or Territories: every scene call and every overlay
// operation of a scripted session through the three views, hashed, must stay what it was before
// the plugin seam existed.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { brainScaleFor } from '@/lib/graph-brain';
import { ANGLES, fitBrain, type Camera, type Viewport } from '@/lib/graph-camera';
import type { MapLand } from '@/lib/graph-map';
import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type GraphNode,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import {
  GraphController,
  type ControllerEvents,
  type GraphPlugin,
  type PluginFrame,
  type PluginStage,
} from './graph-controller';
import type { SceneFrame } from './graph-scene';

// -- Stand-ins ----------------------------------------------------------------------------------

/** Every call the controller makes on its WebGL scene, as made. */
const scene = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
  listener: null as ((name: string, args: readonly unknown[]) => void) | null,
}));

vi.mock('./graph-scene', () => {
  const note = (name: string, args: unknown[]) => {
    scene.calls.push({ name, args });
    scene.listener?.(name, args);
  };
  return {
    GraphScene: class {
      constructor() {
        note('new', []);
      }
      resize(vp: Viewport, dpr: number) {
        note('resize', [{ ...vp }, dpr]);
      }
      setModel(model: GraphModel) {
        note('setModel', [model]);
      }
      setLand(land: MapLand | null, model: GraphModel) {
        note('setLand', [land, model]);
      }
      lightCountries(projects: ReadonlySet<string> | null) {
        note('lightCountries', [projects ? [...projects].sort() : null]);
      }
      render(frame: SceneFrame) {
        note('render', [{ ...frame, cam: { ...frame.cam } }]);
      }
      dispose() {
        note('dispose', []);
      }
    },
  };
});

/** cyrb53, fed piece by piece: the golden log runs to hundreds of thousands of lines. */
class Digest {
  private h1 = 0xdeadbeef;
  private h2 = 0x41c6ce57;
  update(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      this.h1 = Math.imul(this.h1 ^ ch, 2654435761);
      this.h2 = Math.imul(this.h2 ^ ch, 1597334677);
    }
  }
  hex(): string {
    let h1 = this.h1;
    let h2 = this.h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }
}

/**
 * Where everything the stand-ins see is written. Numbers are rounded to six places before they
 * are hashed, so a Node or V8 upgrade that moves the last bits of a float flips nothing.
 */
class Tape {
  readonly counts = new Map<string, number>();
  readonly digest = new Digest();
  lines = 0;
  private readonly ids = new WeakMap<object, string>();
  private next = 0;

  constructor(readonly golden: boolean) {}

  tag<T extends object>(prefix: string, value: T): T {
    this.ids.set(value, `${prefix}${this.next++}`);
    return value;
  }

  ser(value: unknown): string {
    if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(6) : String(value);
    if (value === null || typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return `[${value.map((v) => this.ser(v)).join(',')}]`;
    return this.ids.get(value) ?? '?';
  }

  write(kind: string, line: string): void {
    if (!this.golden) return;
    this.lines++;
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    this.digest.update(line);
    this.digest.update('\n');
  }
}

interface Op {
  op: string;
  args: unknown[];
}

/** A 2D context that draws nothing and records everything: each call and each property written. */
function recorder(tape: Tape, name: string, ops: Op[] | null): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '10px sans-serif',
    lineWidth: 1,
  };
  return new Proxy(state, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        ops?.push({ op: key, args });
        tape.write(name, `${name}.${key}(${args.map((a) => tape.ser(a)).join(',')})`);
        if (key === 'measureText') return { width: String(args[0]).length * 6 };
        if (key.startsWith('create')) {
          return tape.tag('g', {
            addColorStop: (...stop: unknown[]) =>
              tape.write(name, `stop(${stop.map((s) => tape.ser(s)).join(',')})`),
          });
        }
        if (key === 'getLineDash') return [];
        return undefined;
      };
    },
    set(target, key, value: unknown) {
      if (typeof key !== 'string') return false;
      ops?.push({ op: `set:${key}`, args: [value] });
      tape.write(name, `${name}.${key}=${tape.ser(value)}`);
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** The size the stage element reports; a resize changes it and calls the observers. */
interface Box {
  width: number;
  height: number;
}

type FakeElement = HTMLCanvasElement & {
  ops: Op[] | null;
  removed: number;
  inserted: unknown[];
  captured: number;
};

/** An element: a box, a style and a 2D context, every write recorded. */
function element(tape: Tape, name: string, box: Box, ops: Op[] | null = null): FakeElement {
  const style = new Proxy<Record<string, string>>(
    {},
    {
      set(target, key, value: string) {
        if (typeof key !== 'string') return false;
        tape.write('dom', `${name}.style.${key}=${value}`);
        target[key] = value;
        return true;
      },
    },
  );
  const ctx = recorder(tape, name, ops);
  const base: Record<string, unknown> = {
    ops,
    removed: 0,
    inserted: [],
    captured: 0,
    style,
    hidden: false,
    width: 300,
    height: 150,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      width: box.width,
      height: box.height,
      right: box.width,
      bottom: box.height,
    }),
    getContext: () => ctx,
    setPointerCapture: (id: number) => {
      (base.captured as number)++;
      tape.write('dom', `${name}.capture(${id})`);
    },
    releasePointerCapture: (id: number) => tape.write('dom', `${name}.release(${id})`),
    before: (node: object) => {
      (base.inserted as unknown[]).push(node);
      tape.write('dom', `${name}.before(${tape.ser(node)})`);
    },
    remove: () => {
      (base.removed as number)++;
      tape.write('dom', `${name}.remove()`);
    },
  };
  const el = new Proxy(base, {
    set(target, key, value: unknown) {
      if (typeof key !== 'string') return false;
      tape.write('dom', `${name}.${key}=${tape.ser(value)}`);
      target[key] = value;
      return true;
    },
  });
  return tape.tag(name, el) as unknown as FakeElement;
}

/** A Path2D that records what is traced in it. */
function path(tape: Tape): object {
  const id = { name: '' };
  const p = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== 'string') return undefined;
        return (...args: unknown[]) =>
          tape.write('path', `${id.name}.${key}(${args.map((a) => tape.ser(a)).join(',')})`);
      },
    },
  );
  tape.tag('p', p);
  id.name = tape.ser(p);
  tape.write('path', `${id.name} new`);
  return p;
}

interface EventRecord {
  name: keyof ControllerEvents;
  args: unknown[];
}

const nodeId = (n: GraphNode | null | undefined) => n?.id ?? 'null';

/** One line per event, naming notes by id. */
function eventLine(name: keyof ControllerEvents, args: readonly unknown[]): string {
  const [a] = args;
  switch (name) {
    case 'onSelection': {
      const s = a as Parameters<ControllerEvents['onSelection']>[0];
      if (!s) return 'null';
      return s.kind === 'note'
        ? `note ${s.node.id}`
        : `path ${s.path.nodes.map((n) => n.id).join('>')}`;
    }
    case 'onHover':
    case 'onOpen':
      return nodeId(a as GraphNode | null);
    case 'onHoverCountry': {
      const c = a as Parameters<ControllerEvents['onHoverCountry']>[0];
      return c ? `${c.id}|${c.label}|${c.vault}|${c.notes}|${c.folders}|${c.routes}` : 'null';
    }
    default:
      return args.map((v) => String(v)).join(',');
  }
}

/** A scene frame as one line: its numbers, its flags, and where every note is drawn. */
function renderLine(tape: Tape, f: SceneFrame, model: GraphModel | null): string {
  const c = f.cam;
  const nums = [
    f.now,
    f.dt,
    f.wallClock,
    c.tx,
    c.ty,
    c.tz,
    c.yaw,
    c.pitch,
    c.dist,
    f.vp.width,
    f.vp.height,
    f.dpr,
  ];
  const more = [f.brainScale, f.cloud, f.landAlpha, f.mapBlend, f.edgeScale];
  const sizes = [f.hops, f.pathNodes, f.pathEdges, f.matched].map((s) => (s ? s.size : '-'));
  const flags = [f.view, f.is3D, f.hotCountry, f.moved, f.edgesDirty, f.reduceMotion, ...sizes];
  const notes = (model?.nodes ?? [])
    .map((n) => tape.ser([n.x, n.y, n.z || 0, n.ox, n.oy, n.oz, n.lift, f.appear(n), f.flash(n)]))
    .join(';');
  return `render ${tape.ser([...nums, ...more])} ${flags.join(' ')} ${notes}`;
}

interface HarnessOptions {
  /** Hash everything into the tape (the golden test); otherwise only the overlay's ops are kept. */
  golden?: boolean;
  reduceMotion?: boolean;
}

/**
 * A controller over stand-ins, with a clock of its own: frames run only when `step` says so,
 * and `performance.now`, `Date.now` and `Math.random` follow the test, not the machine.
 *
 * The globals go in here, after the controller's modules were imported: d3-timer binds
 * `requestAnimationFrame` when it loads if a `window` has one, and its wake-ups would then take
 * the place of the controller's frame.
 */
function harness(Graph: typeof GraphController, opts: HarnessOptions = {}) {
  reset();
  const tape = new Tape(!!opts.golden);
  const clock = { now: 1000 };
  const box: Box = { width: 800, height: 600 };
  let pending: FrameRequestCallback | null = null;
  let rafId = 0;
  const observers: (() => void)[] = [];
  let seed = 7;

  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending = cb;
    return ++rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    if (id === rafId) pending = null;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: (tag: string) => element(tape, `<${tag}>`, { width: 64, height: 64 }),
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('Path2D', function Path2D() {
    return path(tape);
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  vi.spyOn(Date, 'now').mockImplementation(() => 1_760_000_000_000 + clock.now);
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  });

  const overlayOps: Op[] | null = opts.golden ? null : [];
  const el = {
    stage: element(tape, 'stage', box),
    gl: element(tape, 'gl', box),
    overlay: element(tape, 'overlay', box, overlayOps),
    minimap: element(tape, 'minimap', box),
    tooltip: element(tape, 'tooltip', box),
    timeChip: element(tape, 'chip', box),
  };
  const events: EventRecord[] = [];
  const listen = <K extends keyof ControllerEvents>(name: K) =>
    ((...args: unknown[]) => {
      events.push({ name, args });
      tape.write('event', `${name} ${eventLine(name, args)}`);
    }) as ControllerEvents[K];
  const handlers: ControllerEvents = {
    onSelection: listen('onSelection'),
    onHover: listen('onHover'),
    onHoverCountry: listen('onHoverCountry'),
    onToast: listen('onToast'),
    onGrowth: listen('onGrowth'),
    onSpin: listen('onSpin'),
    onAngle: listen('onAngle'),
    onOpen: listen('onOpen'),
    onSettled: listen('onSettled'),
  };

  let controller: GraphController | null = null;
  scene.listener = (name, args) => {
    if (!tape.golden) return;
    if (name === 'render')
      tape.write('scene', renderLine(tape, args[0] as SceneFrame, controller?.model ?? null));
    else if (name === 'setModel') {
      const m = args[0] as GraphModel;
      tape.write('scene', `setModel ${m.nodes.map((n) => n.id).join(',')} ${m.edges.length}`);
    } else if (name === 'setLand') {
      const land = args[0] as MapLand | null;
      tape.write('scene', `setLand ${land ? land.sites.map((s) => s.project).join(',') : 'null'}`);
    } else tape.write('scene', `${name} ${tape.ser(args)}`);
  };
  controller = new Graph(
    el as unknown as ConstructorParameters<typeof GraphController>[0],
    handlers,
    !!opts.reduceMotion,
  );

  const pointer = (
    x: number,
    y: number,
    o: { shift?: boolean; button?: number; deltaY?: number } = {},
  ) =>
    ({
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: o.button ?? 0,
      shiftKey: !!o.shift,
      deltaY: o.deltaY ?? 0,
      preventDefault: () => tape.write('dom', 'preventDefault'),
    }) as unknown as PointerEvent & WheelEvent;

  const c = controller;
  return {
    controller: c,
    tape,
    el,
    box,
    clock,
    events,
    overlayOps,
    /** Run `frames` frames, `ms` apart. */
    step(frames: number, ms = 16) {
      for (let i = 0; i < frames; i++) {
        clock.now += ms;
        const cb = pending;
        pending = null;
        cb?.(clock.now);
      }
    },
    resize(width: number, height: number) {
      box.width = width;
      box.height = height;
      for (const cb of observers) cb();
    },
    down: (x: number, y: number, o?: { shift?: boolean; button?: number }) =>
      c.pointerDown(pointer(x, y, o)),
    move: (x: number, y: number) => c.pointerMove(pointer(x, y)),
    up: (x: number, y: number, cancelled = false) => c.pointerUp(pointer(x, y), cancelled),
    leave: () => c.pointerLeave(),
    drag(x0: number, y0: number, x1: number, y1: number, o?: { shift?: boolean; button?: number }) {
      c.pointerDown(pointer(x0, y0, o));
      for (let i = 1; i <= 6; i++) {
        c.pointerMove(pointer(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6));
        this.step(1);
      }
      c.pointerUp(pointer(x1, y1));
    },
    click(x: number, y: number, o?: { shift?: boolean }) {
      c.pointerDown(pointer(x, y, o));
      c.pointerUp(pointer(x, y, o));
    },
    wheel: (x: number, y: number, deltaY: number) => c.wheel(pointer(x, y, { deltaY })),
    doubleClick: (x: number, y: number) => c.doubleClick(pointer(x, y)),
    minimap: (x: number, y: number) => c.minimapPoint(pointer(x, y)),
    key(key: string) {
      const handled = c.keyDown({ key } as KeyboardEvent);
      tape.write('key', `${key} ${handled}`);
      return handled;
    },
  };
}
type Harness = ReturnType<typeof harness>;

/** The globals and spies back as they were, and the scene's record emptied. */
function reset(): void {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  scene.calls.length = 0;
  scene.listener = null;
}

afterEach(reset);

// -- A vault -------------------------------------------------------------------------------------

const T0 = 1_750_000_000_000;
const HOUR = 3_600_000;

/** Forty notes in two vaults (invented names): chains inside each project, a few links across. */
function twoVaults(cache = new Map<string, GraphNode>(), extra = false): GraphModel {
  const nodes: InputNode[] = [];
  const projects = ['Orbit', 'Ledger', 'Atlas'];
  for (let i = 0; i < 28; i++) {
    const p = projects[i % 3]!;
    nodes.push({
      id: `me/${p}/n${i}.md`,
      path: `${p}/${i % 2 ? 'notes/' : ''}n${i}.md`,
      title: `${p} note ${i}`,
      ownerId: 'me',
      project: { id: `me|${p}`, label: p },
      createdAt: T0 + i * HOUR,
      updatedAt: T0 + (i % 7) * 24 * HOUR,
    });
  }
  for (let i = 0; i < (extra ? 13 : 12); i++) {
    const p = i < 7 ? 'Erebor' : 'Lumen';
    nodes.push({
      id: `ana/${p}/m${i}.md`,
      path: `${p}/m${i}.md`,
      title: `${p} page ${i}`,
      ownerId: 'ana',
      project: { id: `ana|${p}`, label: p },
      createdAt: T0 + (40 + i) * HOUR,
      updatedAt: T0 + i * HOUR,
    });
  }
  const edges: InputEdge[] = [];
  const byProject = new Map<string, InputNode[]>();
  for (const n of nodes) byProject.set(n.project.id, [...(byProject.get(n.project.id) ?? []), n]);
  for (const list of byProject.values()) {
    for (let i = 1; i < list.length; i++)
      edges.push({ source: list[i]!.id, target: list[i - 1]!.id, weight: 1 });
  }
  edges.push({ source: 'me/Orbit/n0.md', target: 'me/Ledger/n4.md', weight: 2 });
  edges.push({ source: 'me/Atlas/n2.md', target: 'me/Orbit/n9.md', weight: 1 });
  edges.push({ source: 'me/Ledger/n1.md', target: 'ana/Erebor/m3.md', weight: 1 });
  return buildGraphModel({
    nodes,
    edges,
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map([['ana', { label: 'Erebor', owner: 'Ana' }]]),
    cache,
  });
}

/** Notes drawn on screen this frame, in model order. */
const shown = (model: GraphModel) => model.nodes.filter((n) => n.onScreen && Number.isFinite(n.sx));

/** Territories: a point over land and off every note, found by sweeping the pointer. */
function countryUnderPointer(h: Harness): { x: number; y: number } | null {
  for (let y = 30; y < h.box.height; y += 30) {
    for (let x = 30; x < h.box.width; x += 30) {
      h.move(x, y);
      const last = h.events.at(-1);
      if (last?.name === 'onHoverCountry' && last.args[0]) return { x, y };
    }
  }
  return null;
}

// -- Tests ---------------------------------------------------------------------------------------

describe('GraphController without a plugin', () => {
  it('draws Brain, Network and Territories exactly as it did before the plugin seam', async () => {
    // A fresh graph-overlay: its text widths and glow sprites are cached per module, so what it
    // measures and paints depends on what ran before in the same instance.
    vi.resetModules();
    const fresh = await import('./graph-controller');
    const h = harness(fresh.GraphController, { golden: true });
    const c = h.controller;
    const cache = new Map<string, GraphNode>();
    const model = twoVaults(cache);

    c.initView('brain');
    c.setModel(model, 'init');
    h.step(90);
    h.drag(20, 20, 140, 70);
    h.step(10);
    h.wheel(400, 300, -100);
    h.wheel(400, 300, -100);
    h.wheel(380, 320, 100);
    h.step(10);
    c.setMatches(model.nodes.filter((n) => n.project?.label === 'Atlas').slice(0, 5));
    h.step(30);
    c.frameMatches();
    h.step(20);
    c.preview(model.nodes[3]!);
    h.step(5);
    c.preview(null);
    c.setMatches(null);
    h.step(20);
    const [a, b, d] = shown(model);
    expect(a && b && d).toBeTruthy();
    h.click(a!.sx, a!.sy);
    h.step(30);
    h.key('ArrowRight');
    h.step(10);
    h.key('Enter');
    h.key('Escape');
    h.step(5);
    const [p, q] = shown(model).slice(4);
    h.click(p!.sx, p!.sy, { shift: true });
    h.step(3);
    h.click(q!.sx, q!.sy, { shift: true });
    h.step(30);
    c.clearSelection();
    const [r] = shown(model).slice(6);
    h.doubleClick(r!.sx, r!.sy);
    h.drag(r!.sx, r!.sy, r!.sx + 40, r!.sy + 25);
    h.step(10);
    c.setAngle('top');
    h.step(40);
    c.setSpin(true);
    h.step(20);
    c.startGrowth();
    h.step(40);
    c.stopGrowth();
    h.step(10);
    c.zoom(1.25);
    c.zoom(0.8);
    h.step(5);
    h.resize(1024, 640);
    h.step(10);

    c.setView('network');
    h.step(90);
    c.setModel(twoVaults(cache, true), 'data');
    h.step(30);
    const [s] = shown(c.model!).slice(2);
    h.move(s!.sx, s!.sy);
    h.step(5);
    h.leave();
    c.fit();
    h.step(40);
    h.minimap(60, 40);
    h.step(5);
    h.drag(30, 600, 120, 560);
    h.step(10);
    h.key('-');
    h.key('x');
    h.step(5);

    c.setView('territories');
    h.step(120);
    const spot = countryUnderPointer(h);
    expect(spot).not.toBeNull();
    h.step(10);
    c.setRoutes(true);
    h.step(20);
    h.click(spot!.x, spot!.y);
    h.step(30);
    c.setRoutes(false);
    c.setView('brain');
    h.step(60);
    h.tape.write('snapshot', JSON.stringify(c.snapshot()));
    c.dispose();

    expect({
      lines: h.tape.lines,
      counts: Object.fromEntries(h.tape.counts),
      digest: h.tape.digest.hex(),
    }).toMatchInlineSnapshot(`
        {
          "counts": {
            "<canvas>": 14,
            "dom": 312,
            "event": 74,
            "key": 5,
            "minimap": 11216,
            "overlay": 142038,
            "path": 495,
            "scene": 850,
            "snapshot": 1,
          },
          "digest": "0f55b04bfe1c86",
          "lines": 155005,
        }
      `);
  });
});

// -- Stage mode ----------------------------------------------------------------------------------

/** The scene frames rendered so far, in order. */
const renders = () =>
  scene.calls.filter((c) => c.name === 'render').map((c) => c.args[0] as SceneFrame);
const sceneResizes = () => scene.calls.filter((c) => c.name === 'resize').map((c) => c.args);

/** What a scene frame shows, without its closures. */
const summary = (f: SceneFrame) => ({
  cam: f.cam,
  view: f.view,
  is3D: f.is3D,
  brainScale: f.brainScale,
  cloud: f.cloud,
  moved: f.moved,
  edgesDirty: f.edgesDirty,
  hops: f.hops?.size ?? null,
  matched: f.matched?.size ?? null,
});

function expectCam(actual: Camera | undefined, expected: Camera, digits = 6): void {
  expect(actual).toBeDefined();
  for (const k of ['tx', 'ty', 'tz', 'yaw', 'pitch', 'dist'] as const) {
    expect(actual![k]).toBeCloseTo(expected[k], digits);
  }
}

/** Where a stage's Fit goes, and the distances it zooms between. */
const OVERVIEW: Camera = { tx: 12, ty: -40, tz: 6, yaw: 0.5, pitch: 0.3, dist: 900 };
const RANGE = { min: 150, max: 3000 };

/** A stage that draws nothing and records what it is asked; `held` is the camera it holds. */
function fakeStage(h: Harness, locked = false) {
  const calls: string[] = [];
  const rendered: PluginFrame[] = [];
  const stage = {
    canvas: element(h.tape, 'stage-canvas', h.box),
    locked,
    held: null as Camera | null,
    calls,
    rendered,
    overview: (): Camera => {
      calls.push('overview');
      return { ...OVERVIEW };
    },
    zoomRange: () => {
      calls.push('zoomRange');
      return { ...RANGE };
    },
    resize: (vp: Viewport, dpr: number) => {
      calls.push(`resize ${vp.width}x${vp.height} ${dpr}`);
    },
    camera: (): Camera | null => {
      calls.push('camera');
      return stage.held ? { ...stage.held } : null;
    },
    render: (f: PluginFrame) => {
      calls.push('render');
      rendered.push({ ...f, cam: { ...f.cam } });
    },
  } satisfies PluginStage & Record<string, unknown>;
  return stage;
}

/** A plugin whose stage is whatever the test sets, and that follows `target`. */
class FakePlugin implements GraphPlugin {
  stage: PluginStage | null = null;
  veil = false;
  target: { x: number; y: number; z: number; dist: number } | null = null;
  userCamera = 0;
  readonly frames: PluginFrame[] = [];

  constructor(private readonly h: Harness) {}

  draw(_ctx: CanvasRenderingContext2D, f: PluginFrame): void {
    this.frames.push({ ...f, cam: { ...f.cam } });
    this.h.overlayOps?.push({ op: 'plugin.draw', args: [] });
  }
  follow() {
    return this.target;
  }
  onUserCamera(): void {
    this.userCamera++;
  }
}
const fakePlugin = (h: Harness) => new FakePlugin(h);

/** The brain with its first layout settled, spinning: a frame moves nothing unless asked. */
function restingBrain(opts: HarnessOptions = {}) {
  const h = harness(GraphController, opts);
  const model = twoVaults();
  h.controller.initView('brain');
  h.controller.setModel(model, 'init');
  h.step(400);
  expect(renders().at(-1)!.moved).toBe(false);
  return { h, c: h.controller, model };
}

/** Attach a plugin and give it a ready stage: the next frame enters stage mode. */
function staged(h: Harness, locked = false) {
  const plugin = fakePlugin(h);
  const stage = fakeStage(h, locked);
  h.controller.setPlugin(plugin);
  plugin.stage = stage;
  return { plugin, stage };
}

const eventsSince = (h: Harness, from: number) =>
  h.events.slice(from).map((e) => `${e.name} ${eventLine(e.name, e.args)}`);

describe('GraphController with a plugin', () => {
  it('holds the spin while a plugin without a stage is attached, and otherwise draws as without one', () => {
    const run = (attach: boolean) => {
      const h = harness(GraphController);
      const c = h.controller;
      const model = twoVaults();
      c.initView('brain');
      c.setModel(model, 'init');
      h.step(60);
      c.select(model.nodes[2]!);
      c.setSpin(true);
      h.step(10);
      const plugin = fakePlugin(h);
      const from = h.events.length;
      if (attach) c.setPlugin(plugin);
      else {
        c.clearSelection();
        c.setSpin(false);
      }
      const attached = eventsSince(h, from);
      const start = renders().length;
      h.step(60);
      return { h, c, plugin, attached, frames: renders().slice(start).map(summary) };
    };
    const without = run(false);
    const { h, c, plugin, attached, frames } = run(true);

    expect(attached).toEqual(['onSelection null', 'onSpin false']);
    expect(frames).toEqual(without.frames);
    expect(plugin.frames).toHaveLength(60);
    expect(plugin.frames[0]!.settled).toBe(false);

    const from = h.events.length;
    c.setSpin(true);
    expect(h.events.length).toBe(from);
    h.step(300);
    expect(plugin.frames.at(-1)!.settled).toBe(true);
    expect(renders().at(-1)!.cam.yaw).toBe(renders().at(-2)!.cam.yaw);
    const detached = h.events.length;
    c.setPlugin(null);
    expect(eventsSince(h, detached)).toEqual(['onSpin true']);
    h.step(2);
    expect(renders().at(-1)!.cam.yaw).toBeGreaterThan(renders().at(-2)!.cam.yaw);
  });

  it('keeps the graph out of sight while a plugin is on its way, and while it asks to', () => {
    const { h, c } = restingBrain();
    const renderCalls = () => scene.calls.filter((s) => s.name === 'render').length;
    const ops = () => h.overlayOps!.map((o) => o.op);

    // Opening on a view that brings a plugin: nothing of the brain before it comes, from the call on.
    c.awaitPlugin(true);
    expect(h.el.gl.style.visibility).toBe('hidden');
    let rendered = renderCalls();
    h.overlayOps!.length = 0;
    h.step(3);
    expect(renderCalls()).toBe(rendered);
    expect(h.el.gl.style.visibility).toBe('hidden');
    expect(ops().every((op) => op === 'setTransform' || op === 'clearRect')).toBe(true);

    // Attached and starting: still dark, and the plugin draws (its prompt, its start-up).
    const plugin = fakePlugin(h);
    plugin.veil = true;
    c.setPlugin(plugin);
    h.overlayOps!.length = 0;
    h.step(3);
    expect(renderCalls()).toBe(rendered);
    expect(plugin.frames).toHaveLength(3);
    expect(ops().filter((op) => op === 'plugin.draw')).toHaveLength(3);

    // It falls back to drawing over the brain: the brain comes back, uploaded whole.
    plugin.veil = false;
    h.step(1);
    expect(renderCalls()).toBe(rendered + 1);
    expect(h.el.gl.style.visibility).toBe('');
    expect(renders().at(-1)!.moved).toBe(true);

    // Leaving the view: no plugin, nothing awaited, the brain as ever.
    c.setPlugin(null);
    c.awaitPlugin(false);
    rendered = renderCalls();
    h.step(2);
    expect(renderCalls()).toBe(rendered + 2);
  });

  it('draws the stage instead of the graph once it is ready', () => {
    const { h, c } = restingBrain();
    const { plugin, stage } = staged(h);
    const scenes = scene.calls.length;
    h.overlayOps!.length = 0;
    stage.held = { tx: 1, ty: 2, tz: 3, yaw: 0.4, pitch: 0.2, dist: 640 };
    h.step(1);

    expect(stage.calls).toEqual(['overview', 'resize 800x600 1', 'camera', 'render']);
    expect(scene.calls.slice(scenes)).toEqual([]);
    expect(h.el.overlay.inserted).toEqual([stage.canvas]);
    expect(h.overlayOps!.map((o) => `${o.op}(${o.args.join(',')})`)).toEqual([
      'setTransform(1,0,0,1,0,0)',
      'clearRect(0,0,800,600)',
      'plugin.draw()',
    ]);
    expect(stage.rendered[0]!.cam).toEqual(stage.held);
    expect(plugin.frames.at(-1)!.cam).toEqual(stage.held);

    h.step(20);
    expect(scene.calls.slice(scenes).filter((s) => s.name === 'render')).toEqual([]);
    expect(h.el.overlay.inserted).toHaveLength(1);
    expect(stage.calls.filter((s) => s === 'camera')).toHaveLength(21);
    c.setPlugin(null);
  });

  it('lets go of a held note and of the selection when the stage comes', () => {
    const { h, c, model } = restingBrain();
    const plugin = fakePlugin(h);
    c.setPlugin(plugin);
    const [a, b] = shown(model);
    h.click(a!.sx, a!.sy);
    expect(h.events.at(-1)).toMatchObject({ name: 'onSelection' });
    h.down(b!.sx, b!.sy);
    h.move(b!.sx + 30, b!.sy + 20);
    const pinned = model.nodes.filter((n) => n.fx != null);
    expect(pinned).toHaveLength(1);

    const from = h.events.length;
    plugin.stage = fakeStage(h);
    h.step(1);
    expect(pinned[0]!.fx).toBeNull();
    expect(eventsSince(h, from)).toEqual(
      expect.arrayContaining(['onSelection null', 'onHoverCountry null']),
    );
    h.up(b!.sx + 30, b!.sy + 20);
    // Unpinned, the layout cools again: the frames turn settled.
    h.step(300);
    expect(plugin.frames.at(-1)!.settled).toBe(true);
    expect(eventsSince(h, from).filter((e) => e.startsWith('onSelection note'))).toEqual([]);
  });

  it('takes the stage camera, then a Fit tween, then the plugin follow', () => {
    const { h, c } = restingBrain();
    const { plugin, stage } = staged(h);
    h.step(1);
    expectCam(stage.rendered.at(-1)!.cam, OVERVIEW);

    // Turned away, then Fit: back over the whole stage, the yaw and pitch the user chose kept.
    h.drag(200, 200, 320, 260);
    const turned = stage.rendered.at(-1)!.cam;
    expect(turned.yaw).not.toBe(OVERVIEW.yaw);
    const users = plugin.userCamera;
    c.fit();
    expect(plugin.userCamera).toBe(users + 1);
    // The tween (700 ms: 44 frames) goes first; what the plugin follows waits for it to land.
    plugin.target = { x: 500, y: 500, z: 500, dist: 2000 };
    h.step(44);
    expectCam(stage.rendered.at(-1)!.cam, { ...OVERVIEW, yaw: turned.yaw, pitch: turned.pitch });

    // No tween left: the follow eases in, a step at a time.
    const before = stage.rendered.at(-1)!.cam;
    h.step(1);
    const k = 1 - Math.exp(-16 / 450);
    expect(stage.rendered.at(-1)!.cam.tx).toBeCloseTo(before.tx + (500 - before.tx) * k, 9);
    h.step(600);
    expectCam(stage.rendered.at(-1)!.cam, { ...before, tx: 500, ty: 500, tz: 500, dist: 2000 }, 3);

    // A camera the stage holds wins over both, and ends the tween.
    c.fit();
    stage.held = { tx: -1, ty: -2, tz: -3, yaw: 0, pitch: 0, dist: 700 };
    h.step(1);
    expect(stage.rendered.at(-1)!.cam).toEqual(stage.held);
    stage.held = null;
    plugin.target = null;
    h.step(5);
    expect(stage.rendered.at(-1)!.cam).toEqual({
      tx: -1,
      ty: -2,
      tz: -3,
      yaw: 0,
      pitch: 0,
      dist: 700,
    });
    c.setPlugin(null);
  });

  it('cuts to what the plugin follows under reduced motion', () => {
    const { h } = restingBrain({ reduceMotion: true });
    const { plugin, stage } = staged(h);
    h.step(1);
    expect(stage.canvas.style.opacity).toBe('');
    plugin.target = { x: 40, y: 50, z: 60, dist: 800 };
    h.step(1);
    expect(stage.rendered.at(-1)!.cam).toMatchObject({ tx: 40, ty: 50, tz: 60, dist: 800 });
  });

  it('fades the stage in, then parks the graph until it goes', () => {
    const { h, c } = restingBrain();
    const { plugin, stage } = staged(h);
    const resizes = sceneResizes().length;
    h.step(1);
    expect(stage.canvas.style.opacity).toBe('0.04');
    h.step(10);
    expect(Number(stage.canvas.style.opacity)).toBeCloseTo(0.44, 6);
    expect(sceneResizes().slice(resizes)).toEqual([]);
    h.step(30);
    expect(stage.canvas.style.opacity).toBe('');
    expect(sceneResizes().slice(resizes)).toEqual([[{ width: 1, height: 1 }, 1]]);

    // Parked, a resize reaches only the stage; the graph takes the size when it comes back.
    h.resize(1000, 700);
    expect(stage.calls.at(-1)).toBe('resize 1000x700 1');
    h.step(5);
    expect(sceneResizes().slice(resizes)).toHaveLength(1);

    const frames = renders().length;
    plugin.stage = null;
    h.step(1);
    expect(sceneResizes().slice(resizes + 1)).toEqual([[{ width: 1000, height: 700 }, 1]]);
    expect(stage.canvas.removed).toBe(1);
    expect(stage.canvas.style.opacity).toBe('');
    expect(h.el.overlay.style.cursor).toBe('grab');
    h.step(1);
    expect(renders()[frames]).toMatchObject({ moved: true, edgesDirty: true });
    expect(renders()[frames + 1]).toMatchObject({ moved: false });
    c.setPlugin(null);
  });

  it('holds still while the stage is locked, and turns, pans and zooms within its range when not', () => {
    const { h, c, model } = restingBrain();
    const [a] = shown(model);
    const { plugin, stage } = staged(h, true);
    h.step(1);
    const from = h.events.length;
    const held = stage.rendered.at(-1)!.cam;
    expect(h.el.overlay.style.cursor).toBe('default');

    h.drag(100, 100, 300, 200);
    h.drag(100, 100, 300, 200, { shift: true });
    h.wheel(400, 300, -100);
    c.zoom(1.25);
    c.fit();
    expect(h.key('+')).toBe(true);
    h.step(50);
    expect(stage.rendered.at(-1)!.cam).toEqual(held);
    expect(plugin.userCamera).toBe(0);
    expect(h.el.overlay.captured).toBe(0);
    expect(stage.calls).not.toContain('zoomRange');

    stage.locked = false;
    h.step(1);
    expect(h.el.overlay.style.cursor).toBe('grab');
    const c0 = stage.rendered.at(-1)!.cam;
    h.down(100, 100);
    h.move(220, 160);
    h.step(1);
    expect(h.el.overlay.style.cursor).toBe('grabbing');
    h.up(220, 160);
    const c1 = stage.rendered.at(-1)!.cam;
    expect(c1.yaw).not.toBe(c0.yaw);
    expect([c1.tx, c1.ty, c1.tz, c1.dist]).toEqual([c0.tx, c0.ty, c0.tz, c0.dist]);

    h.drag(100, 100, 300, 160, { shift: true });
    const c2 = stage.rendered.at(-1)!.cam;
    expect([c2.yaw, c2.pitch]).toEqual([c1.yaw, c1.pitch]);
    expect(c2.tx).not.toBe(c1.tx);
    h.drag(100, 100, 300, 160, { button: 2 });
    const c3 = stage.rendered.at(-1)!.cam;
    expect([c3.yaw, c3.pitch]).toEqual([c1.yaw, c1.pitch]);
    expect(c3.tx).not.toBe(c2.tx);

    for (let i = 0; i < 40; i++) h.wheel(400, 300, -100);
    h.step(1);
    expect(stage.rendered.at(-1)!.cam.dist).toBe(RANGE.min);
    for (let i = 0; i < 60; i++) h.wheel(400, 300, 100);
    h.step(1);
    expect(stage.rendered.at(-1)!.cam.dist).toBe(RANGE.max);
    expect(h.key('-')).toBe(true);
    h.step(1);
    expect(stage.rendered.at(-1)!.cam.dist).toBe(RANGE.max);
    expect(h.key('+')).toBe(true);
    h.step(1);
    expect(stage.rendered.at(-1)!.cam.dist).toBeCloseTo(RANGE.max / 1.25, 6);
    for (const key of ['Escape', 'Enter', 'ArrowRight', '4']) expect(h.key(key)).toBe(false);

    const users = plugin.userCamera;
    const c4 = stage.rendered.at(-1)!.cam;
    c.fit();
    h.step(50);
    expect(plugin.userCamera).toBe(users + 1);
    expectCam(stage.rendered.at(-1)!.cam, { ...OVERVIEW, yaw: c4.yaw, pitch: c4.pitch });

    // Nothing of the brain's answers: no hover, no selection, no open, no spin.
    h.move(a!.sx, a!.sy);
    h.click(a!.sx, a!.sy);
    h.doubleClick(a!.sx, a!.sy);
    h.leave();
    c.select(a!);
    c.setAngle('top');
    c.preview(a!);
    c.startPathFrom(a!);
    c.frameMatches();
    c.startGrowth();
    h.minimap(20, 20);
    h.step(5);
    expect(eventsSince(h, from).filter((e) => !e.startsWith('onSettled'))).toEqual([]);
    c.setPlugin(null);
  });

  it('gives the brain its camera back when the stage goes, and the tween it was in', () => {
    const { h } = restingBrain();
    const resting = renders().at(-1)!.cam;
    const { plugin, stage } = staged(h);
    h.step(10);
    h.drag(100, 100, 300, 200);
    for (let i = 0; i < 5; i++) h.wheel(400, 300, -100);
    h.step(10);
    expect(stage.rendered.at(-1)!.cam).not.toEqual(resting);
    plugin.stage = null;
    h.step(1);
    expect(renders().at(-1)!.cam).toEqual(resting);

    // Mid-flight when the stage came: the brain lands where it was going.
    const flight = (withStage: boolean) => {
      const run = restingBrain();
      const p = fakePlugin(run.h);
      run.c.setPlugin(p);
      run.c.setAngle('top');
      run.h.step(5);
      if (withStage) p.stage = fakeStage(run.h);
      run.h.step(5);
      p.stage = null;
      run.h.step(60);
      return renders().at(-1)!.cam;
    };
    const landed = flight(false);
    expect(landed.pitch).toBeCloseTo(ANGLES.top.pitch, 6);
    expect(flight(true)).toEqual(landed);
  });

  it('frames a model laid out under the stage for the brain, not for the stage', () => {
    const { h, c } = restingBrain();
    const { plugin, stage } = staged(h);
    h.step(5);
    c.setModel(twoVaults(new Map(), true), 'init');
    h.step(5);
    expectCam(stage.rendered.at(-1)!.cam, OVERVIEW);
    plugin.stage = null;
    h.step(1);
    expectCam(renders().at(-1)!.cam, {
      ...fitBrain(brainScaleFor(41), h.box),
      ...ANGLES.threeQuarter,
    });
  });

  it('brings the brain back eased to a model that changed under the stage', () => {
    const run = (rebuild: boolean) => {
      const { h, c } = restingBrain();
      h.wheel(400, 300, -100);
      h.step(1);
      const { plugin } = staged(h);
      h.step(5);
      if (rebuild) c.setModel(twoVaults(new Map(), true), 'data');
      h.step(5);
      plugin.stage = null;
      h.step(1);
      const left = renders().at(-1)!.cam;
      h.step(30);
      return { left, later: renders().at(-1)!.cam };
    };
    // Where the user zoomed it stays; with notes added it eases to the brain's new size.
    const kept = run(false);
    expect(kept.later).toEqual(kept.left);
    const eased = run(true);
    expect(eased.later.dist).not.toBeCloseTo(eased.left.dist, 3);
  });

  it('brings the brain back to its new size when the layout settled under the stage', () => {
    const { h, c } = restingBrain();
    h.wheel(400, 300, -100);
    h.step(1);
    const zoomed = renders().at(-1)!.cam;
    const { plugin } = staged(h);
    h.step(5);
    c.setModel(twoVaults(new Map(), true), 'data');
    // Long enough on the stage for the new layout to come to rest unseen: nothing moves when
    // the brain comes back, so no ease would reach the new size on its own.
    h.step(400);
    expect(plugin.frames.at(-1)!.settled).toBe(true);
    plugin.stage = null;
    h.step(50);
    expect(renders().at(-1)!.moved).toBe(false);
    expectCam(renders().at(-1)!.cam, { ...zoomed, ...fitBrain(brainScaleFor(41), h.box) });
    c.setPlugin(null);
  });

  it('flies a tween the stage interrupted to the new size, at the angle it was heading for', () => {
    const { h, c } = restingBrain();
    const plugin = fakePlugin(h);
    c.setPlugin(plugin);
    c.setAngle('top');
    h.step(5);
    plugin.stage = fakeStage(h);
    h.step(5);
    c.setModel(twoVaults(new Map(), true), 'data');
    h.step(400);
    plugin.stage = null;
    h.step(50);
    expectCam(renders().at(-1)!.cam, {
      ...fitBrain(brainScaleFor(41), h.box),
      ...ANGLES.top,
    });
    c.setPlugin(null);
  });

  it('takes the stage canvas out when disposed in stage mode, and detaches quietly after', () => {
    const { h, c } = restingBrain();
    const { stage } = staged(h);
    h.step(30);
    const from = h.events.length;
    const calls = scene.calls.length;
    c.dispose();
    expect(stage.canvas.removed).toBe(1);
    // Parked, it stays parked: no full-size buffer for a renderer about to be freed.
    expect(scene.calls.slice(calls).map((s) => s.name)).toEqual(['dispose']);
    expect(() => c.setPlugin(null)).not.toThrow();
    expect(h.events.length).toBe(from);
    h.step(3);
    expect(stage.calls.filter((s) => s === 'render')).toHaveLength(30);
  });
});
