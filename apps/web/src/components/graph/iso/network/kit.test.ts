// Network's line art in Node, over the real camera and render modules: three builds its scene
// without WebGL, the renderer is a stand-in that counts draws, and the notes stand where a test
// puts them, as the engine's forces would.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  findPath,
  type GraphModel,
  type GraphNode,
  type InputNode,
} from '@/lib/graph-model';

import type { KitFrame, KitHost } from '../../graph-kit';
import type { Rect } from '../../labels/placer';
import { isoProject, isoUnproject, type IsoCam } from '../math/camera';
import { STATE, type BoxLayer } from '../render/boxes';
import { CABLE, type CableLayer } from '../render/cables';
import { NetworkKit } from './kit';

const T0 = Date.UTC(2026, 0, 1);

/** Two projects of a vault, a few links in each, two between them, and a shared topic. */
function board(): GraphModel {
  const nodes: InputNode[] = [];
  const add = (project: string, i: number) =>
    nodes.push({
      id: `me/${project}/n${i}.md`,
      path: `${project}/n${i}.md`,
      title: `${project} ${i}`,
      ownerId: 'me',
      project: { id: `me|${project}`, label: project },
      createdAt: T0 + i * 1000,
      updatedAt: T0,
    });
  for (let i = 0; i < 8; i++) add('Orbit', i);
  for (let i = 0; i < 8; i++) add('Ledger', i);
  const id = (p: string, i: number) => `me/${p}/n${i}.md`;
  const link = (a: string, b: string) => ({ source: a, target: b, weight: 1 });
  const model = buildGraphModel({
    nodes,
    edges: [
      link(id('Orbit', 0), id('Orbit', 1)),
      link(id('Orbit', 0), id('Orbit', 2)),
      link(id('Orbit', 2), id('Orbit', 3)),
      link(id('Ledger', 0), id('Ledger', 1)),
      link(id('Orbit', 0), id('Ledger', 0)),
      link(id('Orbit', 3), id('Ledger', 4)),
    ],
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
  place(model);
  // Two notes that only share a topic, across the projects: no link anyone wrote.
  const [a, b] = [model.nodes[6]!, model.nodes[14]!];
  const topic = { source: a, target: b, kind: 'affinity' as const, weight: 1, shared: ['design'] };
  model.edges.push(topic);
  model.adjacency.get(a)!.push({ node: b, edge: topic });
  model.adjacency.get(b)!.push({ node: a, edge: topic });
  return model;
}

/** Where the forces would put them: Orbit to the west, Ledger to the east, engine units. */
function place(model: GraphModel, shift = 0): void {
  model.nodes.forEach((n, i) => {
    const east = n.project?.label === 'Ledger';
    n.x = (east ? 120 : -120) + ((i % 4) - 1.5) * 36 + shift;
    n.y = (Math.floor(i / 4) % 2) * 40 - 20;
    n.bornAt = -Infinity;
  });
}

interface Inside {
  cam: IsoCam;
  tween: unknown;
  autoFit: boolean;
  lifts: Map<number, { now: number; to: number }>;
  three: {
    boxes: BoxLayer;
    board: CableLayer;
    focus: CableLayer;
    grid: { mesh: { visible: boolean } };
  };
  pos: Float32Array;
}
const inside = (kit: NetworkKit) => kit as unknown as Inside;

function fakeContext(width: number, height: number) {
  const texts: string[] = [];
  const target: Record<string | symbol, unknown> = {
    canvas: { width, height },
    texts,
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (t: string) => texts.push(t),
  };
  return new Proxy(target, {
    get: (o, key) => (key in o ? o[key] : () => undefined),
    set: (o, key, value) => {
      o[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { texts: string[] };
}

function setup(model = board(), width = 1200, height = 800) {
  const renderer = { render: vi.fn() };
  const overlay = fakeContext(width, height);
  const host = {
    renderer,
    overlay,
    fonts: { sans: 'sans-serif', mono: 'monospace' },
    labelPx: 12,
    reduceMotion: false,
    onUserCamera: vi.fn(),
    setCursor: vi.fn(),
    select: vi.fn(),
    pick: vi.fn(),
    clearSelection: vi.fn(),
    open: vi.fn(),
    onPlace: vi.fn(),
    onCursor: vi.fn(),
    setPixelRatio: vi.fn(),
    minimap: null,
  } as unknown as KitHost &
    Record<
      'onUserCamera' | 'pick' | 'clearSelection' | 'open' | 'onPlace',
      ReturnType<typeof vi.fn>
    >;
  const kit = new NetworkKit();
  const vp = { width, height };
  kit.enter(host, model, vp, 1);
  let now = performance.now();
  const base: KitFrame = {
    now,
    dt: 16,
    vp,
    dpr: 1,
    model,
    chrome: [],
    selected: null,
    previewed: null,
    matches: null,
    routes: false,
    path: null,
  };
  const frame = (over: Partial<KitFrame> = {}, ms = 16) => {
    now += ms;
    Object.assign(base, over, { now });
    kit.frame({ ...base });
  };
  const settle = (over: Partial<KitFrame> = {}) => {
    for (let i = 0; i < 40; i++) frame(over, 30);
  };
  const at = (n: GraphNode) => kit.screenOf(n)!;
  return { kit, host, renderer, model, frame, settle, overlay, at, vp };
}

const pointer = (id: number, type = 'mouse', primary = true, shiftKey = false) =>
  ({ pointerId: id, pointerType: type, isPrimary: primary, shiftKey }) as PointerEvent;
const states = (kit: NetworkKit) =>
  inside(kit).three.boxes.mesh.geometry.getAttribute('iState').array as Float32Array;
/** Each cable drawn, by its points, from the layer's segments. */
function cables(layer: CableLayer) {
  const g = layer.visible.geometry;
  const along = g.getAttribute('iAlong').array;
  const start = g.getAttribute('iStart').array;
  const end = g.getAttribute('iEnd').array;
  const out: number[][][] = [];
  for (let i = 0; i < layer.count; i++) {
    const a = [start[i * 3]!, start[i * 3 + 1]!, start[i * 3 + 2]!];
    const b = [end[i * 3]!, end[i * 3 + 1]!, end[i * 3 + 2]!];
    if (along[i * 2] === 0) out.push([a, b]);
    else out.at(-1)!.push(b);
  }
  return out;
}

describe('NetworkKit', () => {
  it('stands each note where the forces put it, and draws nothing at rest', () => {
    const { kit, renderer, model, frame, settle } = setup();
    expect(kit.usesEngine()).toBe(true);
    expect(kit.handles('network')).toBe(true);
    expect(kit.handles('territories')).toBe(false);
    settle();
    const drawn = renderer.render.mock.calls.length;
    expect(drawn).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) frame();
    expect(renderer.render).toHaveBeenCalledTimes(drawn);
    // A column at a twelfth of the engine's units.
    const n = model.nodes[3]!;
    const pos = inside(kit).pos;
    expect(pos[3 * 2]).toBeCloseTo(n.x / 12, 5);
    // The forces move it: the board is drawn again.
    n.x += 30;
    frame();
    expect(renderer.render.mock.calls.length).toBeGreaterThan(drawn);
    expect(pos[3 * 2]).toBeCloseTo(n.x / 12, 5);
  });

  it('shows a note only once it has a place and has come in', () => {
    const model = board();
    const n = model.nodes[5]!;
    n.bornAt = Infinity;
    const { kit, frame } = setup(model);
    frame();
    expect(states(kit)[6]).toBe(STATE.hidden);
    n.bornAt = -Infinity;
    frame();
    expect(states(kit)[6]).toBe(STATE.rest);
    n.x = Number.NaN;
    frame();
    expect(states(kit)[6]).toBe(STATE.hidden);
  });

  it('lays links flat within a project and arcs those between projects; a shared topic is no link', () => {
    const { kit, settle } = setup();
    settle();
    const drawn = cables(inside(kit).three.board);
    const flat = drawn.filter((c) => c.length === 2);
    const arcs = drawn.filter((c) => c.length > 2);
    expect(flat).toHaveLength(4);
    expect(arcs).toHaveLength(2);
    // Flat ones lie on the board; an arc rises over it in the middle.
    for (const c of flat) for (const p of c) expect(p[2]).toBeCloseTo(0.01, 5);
    for (const c of arcs) expect(Math.max(...c.map((p) => p[2]!))).toBeGreaterThan(1);
  });

  it('lifts a selection to the second level and its links to the first, wired square between them', () => {
    const { kit, model, settle } = setup();
    settle();
    const sel = model.nodes[0]!;
    settle({ selected: sel });
    const lifts = inside(kit).lifts;
    expect(lifts.get(0)!.now).toBeCloseTo(2.4, 5);
    // Its three links (two in its project, one across), and nothing else lifted.
    expect(
      [...lifts.entries()]
        .filter(([, l]) => l.now === 1.2)
        .map(([k]) => k)
        .sort(),
    ).toEqual([1, 2, 8]);
    const st = states(kit);
    expect(st[1]).toBe(STATE.selected);
    expect(st[5]).toBe(STATE.dim);
    const wires = cables(inside(kit).three.focus);
    expect(wires).toHaveLength(3);
    for (const w of wires) {
      // Each stretch runs along one axis only: square, never diagonal.
      for (let i = 1; i < w.length; i++) {
        const moved = [0, 1, 2].filter((a) => Math.abs(w[i]![a]! - w[i - 1]![a]!) > 1e-6);
        expect(moved.length).toBeLessThanOrEqual(1);
      }
      expect(w[0]![2]).toBeCloseTo(2.4, 5);
      expect(w.at(-1)![2]).toBeCloseTo(1.2 + 0.5, 5);
    }
    // The links out of focus fade; the focus's are not drawn on the board too.
    const board = inside(kit).three.board;
    expect(board.visible.material.uniforms.uFade!.value).toBeLessThan(0.5);
    expect(cables(board)).toHaveLength(3);
  });

  it('wires a path from each step to the next, out of the higher column into the lower one', () => {
    const { kit, model, settle, overlay } = setup();
    settle();
    const path = findPath(model, model.nodes[1]!, model.nodes[3]!)!;
    expect(path.nodes.map((n) => n.title)).toEqual(['Orbit 1', 'Orbit 0', 'Orbit 2', 'Orbit 3']);
    settle({ path });
    const wires = cables(inside(kit).three.focus);
    expect(wires).toHaveLength(3);
    for (const w of wires) {
      const from = w[0]![2]!;
      const to = w.at(-1)![2]!;
      // Never up into a column from below.
      expect(from).toBeGreaterThanOrEqual(to - 0.5 - 1e-6);
    }
    for (const n of ['1', '2', '3', '4'])
      expect(overlay.texts.some((t) => t.startsWith(`${n} · `))).toBe(true);
  });

  it('picks the note under the pointer where it is drawn, and opens it on a double click mid-flight', () => {
    const { kit, host, model, settle, frame, at } = setup();
    settle();
    const n = model.nodes[6]!;
    const p = at(n);
    const click = () => {
      kit.pointerDown(pointer(1), p.x, p.y - 2);
      kit.pointerUp(pointer(1), p.x, p.y - 2, false);
    };
    click();
    expect(host.pick).toHaveBeenLastCalledWith(n, false);
    // The controller selects it and the kit flies to it; the second click comes mid-flight.
    kit.reveal(n);
    frame({ selected: n }, 120);
    click();
    // The flight goes on: the second press of a double click does not stop it.
    expect(inside(kit).tween).not.toBeNull();
    expect(host.pick).toHaveBeenCalledTimes(1);
    expect(host.clearSelection).not.toHaveBeenCalled();
    kit.doubleClick(p.x, p.y - 2);
    expect(host.open).toHaveBeenCalledWith(n);
    // With Shift, a path's end.
    settle({ selected: n });
    const q = at(model.nodes[2]!);
    kit.pointerDown(pointer(2, 'mouse', true, true), q.x, q.y - 2);
    kit.pointerUp(pointer(2, 'mouse', true, true), q.x, q.y - 2, false);
    expect(host.pick).toHaveBeenLastCalledWith(model.nodes[2], true);
  });

  it('follows the settling layout until the camera is moved; Escape fits it again', () => {
    const { kit, model, settle, frame } = setup();
    settle();
    const before = { ...inside(kit).cam };
    place(model, 200);
    settle();
    expect(inside(kit).cam.tx).not.toBeCloseTo(before.tx, 1);
    kit.wheel({ deltaY: -120, deltaMode: 0, ctrlKey: false } as WheelEvent, 600, 400);
    frame();
    const held = { ...inside(kit).cam };
    place(model, -200);
    settle();
    expect(inside(kit).cam).toEqual(held);
    expect(kit.up()).toBe(true);
    settle();
    expect(inside(kit).cam.tx).not.toBeCloseTo(held.tx, 1);
    expect(kit.up()).toBe(false);
    // A growth replay is the engine's: the camera follows it again.
    kit.wheel({ deltaY: -120, deltaMode: 0, ctrlKey: false } as WheelEvent, 600, 400);
    expect(inside(kit).autoFit).toBe(false);
    expect(kit.startGrowth()).toBe(false);
    expect(inside(kit).autoFit).toBe(true);
    expect(kit.growthStatus()).toBeNull();
  });

  it('keeps what was lifted when the model is rebuilt with a note more, at its new index', () => {
    const model = board();
    const { kit, settle, frame } = setup(model);
    const sel = model.nodes[3]!;
    settle({ selected: sel });
    expect(inside(kit).lifts.get(3)!.now).toBeCloseTo(2.4, 5);
    // The same notes and one more ahead of them: every index moves along by one.
    const extra = { ...model.nodes[0]!, id: 'me/Orbit/new.md', title: 'Orbit new' } as GraphNode;
    const next = {
      ...model,
      nodes: [extra, ...model.nodes],
      edges: [...model.edges],
    } as GraphModel;
    next.adjacency.set(extra, []);
    frame({ model: next, selected: sel });
    // Still up, the moment the new model comes, at the index it now has.
    expect(inside(kit).lifts.get(4)!.now).toBeGreaterThan(2);
  });

  it('lifts and wires only what a person wrote: a topic shared by chance is no link', () => {
    const model = board();
    const { kit, settle } = setup(model);
    // Orbit 6 shares a topic with Ledger 6 and links to nothing.
    settle({ selected: model.nodes[6]! });
    expect([...inside(kit).lifts.entries()].filter(([, l]) => l.to > 0).map(([k]) => k)).toEqual([
      6,
    ]);
    expect(cables(inside(kit).three.focus)).toEqual([]);
  });

  it('hands a pinch to a drag when a finger lifts, and pinches afresh between the two left of three', () => {
    const { kit, settle } = setup();
    settle();
    kit.pointerDown(pointer(1, 'touch', true), 500, 400);
    kit.pointerDown(pointer(2, 'touch', false), 700, 400);
    kit.pointerMove(pointer(2, 'touch', false), 800, 400);
    const pinched = inside(kit).cam.ppu;
    kit.pointerDown(pointer(3, 'touch', false), 600, 600);
    kit.pointerUp(pointer(1, 'touch', false), 500, 400, false);
    // Two left: their own pinch, from where they are.
    kit.pointerMove(pointer(2, 'touch', false), 801, 400);
    expect(inside(kit).cam.ppu).toBeCloseTo(pinched, 0);
    kit.pointerUp(pointer(3, 'touch', false), 600, 600, false);
    // One left: it drags the board.
    const cam = { ...inside(kit).cam };
    kit.pointerMove(pointer(2, 'touch', false), 760, 360);
    expect(inside(kit).cam.tx !== cam.tx || inside(kit).cam.ty !== cam.ty).toBe(true);
  });

  it('frames a note just flown to again when the preview comes up over it', () => {
    const { kit, model, settle, frame, at, vp } = setup();
    settle();
    const n = model.nodes[4]!;
    kit.reveal(n);
    settle({ selected: n });
    const centred = at(n);
    // A sheet over the bottom half: the note moves into the half left free.
    const sheet: Rect[] = [{ x: 0, y: vp.height / 2, w: vp.width, h: vp.height / 2 }];
    frame({ selected: n, chrome: sheet });
    settle({ selected: n, chrome: sheet });
    expect(at(n).y).toBeLessThan(centred.y - 80);
  });

  it('draws no dot grid until there is a board', () => {
    const model = board();
    for (const n of model.nodes) n.bornAt = Infinity;
    const { kit, frame } = setup(model);
    frame();
    expect(inside(kit).three.grid.mesh.visible).toBe(false);
    for (const n of model.nodes) n.bornAt = -Infinity;
    frame();
    expect(inside(kit).three.grid.mesh.visible).toBe(true);
  });

  it('draws the board from above on the minimap, and moves the camera to a point on it', () => {
    const { kit, host, settle, frame, vp } = setup();
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (o, key) => (key in o ? o[key] : (..._: unknown[]) => calls.push(String(key))),
      set: (o, key, value) => {
        o[key] = value;
        return true;
      },
    });
    const canvas = {
      clientWidth: 176,
      clientHeight: 116,
      width: 0,
      height: 0,
      getContext: () => ctx,
    };
    (host as unknown as { minimap: unknown }).minimap = canvas;
    settle();
    expect(calls.filter((c) => c === 'fillRect').length).toBeGreaterThan(16);
    const mini = (
      kit as unknown as { mini: { cam: IsoCam; vp: { width: number; height: number } } }
    ).mini;
    const world = isoUnproject(mini.cam, mini.vp, 40, 60, 0);
    kit.minimapPoint(40, 60);
    frame();
    // Where it was clicked is now in the middle of the stage.
    const p = isoProject(inside(kit).cam, vp)(world.x, world.y, 0);
    expect(Math.abs(p.x - vp.width / 2)).toBeLessThan(2);
    expect(Math.abs(p.y - vp.height / 2)).toBeLessThan(2);
    expect(host.onUserCamera).toHaveBeenCalled();
  });

  it('has no places for the breadcrumb, and nothing to step out of but the camera', () => {
    const { kit, host } = setup();
    expect(host.onPlace).toHaveBeenCalledWith([]);
    expect(kit.up()).toBe(false);
  });
});

void CABLE;
