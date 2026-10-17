// The line-art kit in Node, over the real layout, camera and render modules: three builds its
// scene without WebGL, and the renderer it would draw with is a stand-in that counts draws.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type GraphNode,
  type InputNode,
} from '@/lib/graph-model';

import type { KitFrame, KitHost } from '../graph-kit';
import type { Rect } from '../labels/placer';
import { LineArtKit } from './kit';
import { snapAz, type IsoCam } from './math/camera';
import type { QualityGovernor } from './quality';
import { CABLE, GROW_MS, routeWidth, type CableLayer } from './render/cables';
import type { GroundGrid } from './render/grid';

const T0 = Date.UTC(2026, 0, 1);

/** Notes in the viewer's vault and in a larger one somebody shared, a few linked. */
function vaults(extraShared = 0): GraphModel {
  const nodes: InputNode[] = [];
  const add = (owner: string, project: string, folder: string, i: number) =>
    nodes.push({
      id: `${owner}/${project}/${folder}/n${i}.md`,
      path: `${project}/${folder}/n${i}.md`,
      title: `${project} ${folder} ${i}`,
      ownerId: owner,
      project: { id: `${owner}|${project}`, label: project },
      createdAt: T0 + i * 1000,
      updatedAt: T0,
    });
  for (let i = 0; i < 12; i++) add('me', 'Orbit', i % 2 ? 'specs' : 'drafts', i);
  for (let i = 0; i < 30 + extraShared; i++) add('sam', 'Gondor', i % 3 ? 'charters' : 'notes', i);
  const id = (k: number) => nodes[k]!.id;
  return buildGraphModel({
    nodes,
    edges: [
      { source: id(0), target: id(1), weight: 1 },
      { source: id(0), target: id(2), weight: 1 },
      { source: id(12), target: id(13), weight: 1 },
    ],
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map([['sam', { label: 'Gondor', owner: 'sam' }]]),
    cache: new Map(),
  });
}

interface Inside {
  cam: IsoCam;
  fitted: string[] | null;
  tween: unknown;
  lifts: Map<number, { now: number; to: number }>;
  layout: { plates: { id: string; kind: string; shared: boolean }[] } | null;
  three: { cables: CableLayer; grid: GroundGrid } | null;
}
const inside = (kit: LineArtKit) => kit as unknown as Inside;

/** A 2D context that draws nothing and keeps the text it was asked to draw. */
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

/** One vault of three projects: Orbit links to Ledger three times and to Atlas once. */
function projects(): GraphModel {
  const nodes: InputNode[] = [];
  for (const [project, n] of [
    ['Orbit', 6],
    ['Ledger', 6],
    ['Atlas', 4],
  ] as const)
    for (let i = 0; i < n; i++)
      nodes.push({
        id: `me/${project}/notes/n${i}.md`,
        path: `${project}/notes/n${i}.md`,
        title: `${project} ${i}`,
        ownerId: 'me',
        project: { id: `me|${project}`, label: project },
        createdAt: T0 + i * 1000,
        updatedAt: T0,
      });
  const link = (a: string, b: string) => ({
    source: `me/${a}.md`,
    target: `me/${b}.md`,
    weight: 1,
  });
  return buildGraphModel({
    nodes,
    edges: [
      link('Orbit/notes/n0', 'Ledger/notes/n0'),
      link('Orbit/notes/n1', 'Ledger/notes/n1'),
      link('Ledger/notes/n2', 'Orbit/notes/n2'),
      link('Orbit/notes/n3', 'Atlas/notes/n0'),
      // Within one project: no route between projects.
      link('Orbit/notes/n4', 'Orbit/notes/n5'),
    ],
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
}

/** The cables drawn: how many, of which kind, and how wide each is. */
function cablesOf(kit: LineArtKit) {
  const layer = inside(kit).three!.cables;
  const g = layer.visible.geometry;
  const kind = g.getAttribute('iKind').array;
  const width = g.getAttribute('iWidth').array;
  const along = g.getAttribute('iAlong').array;
  const out: { kind: number; width: number }[] = [];
  // A cable's first stretch starts at its beginning.
  for (let i = 0; i < layer.count; i++)
    if (along[i * 2] === 0) out.push({ kind: kind[i]!, width: width[i]! });
  return out;
}
const progressOf = (kit: LineArtKit) =>
  inside(kit).three!.cables.visible.material.uniforms.uProgress!.value as number;

function setup(width = 1200, height = 800, model = vaults(), dpr = 1) {
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
    clearSelection: vi.fn(),
    open: vi.fn(),
    onPlace: vi.fn(),
    onCursor: vi.fn(),
    setPixelRatio: vi.fn(),
  } as unknown as KitHost &
    Record<
      | 'onUserCamera'
      | 'setCursor'
      | 'select'
      | 'clearSelection'
      | 'open'
      | 'onPlace'
      | 'onCursor'
      | 'setPixelRatio',
      ReturnType<typeof vi.fn>
    >;
  const kit = new LineArtKit();
  const vp = { width, height };
  kit.enter(host, model, vp, dpr);
  let now = performance.now();
  const base: KitFrame = {
    now,
    dt: 16,
    vp,
    dpr,
    model,
    chrome: [],
    selected: null,
    previewed: null,
    matches: null,
    routes: false,
  };
  const frame = (over: Partial<KitFrame> = {}, ms = 16) => {
    now += ms;
    Object.assign(base, over, { now });
    kit.frame({ ...base });
  };
  /** Where a note's block is drawn now, on the stage. */
  const at = (n: GraphNode) => kit.screenOf(n)!;
  return { kit, host, renderer, model, frame, vp, overlay, at };
}

const pointer = (id: number, type: string, primary: boolean) =>
  ({ pointerId: id, pointerType: type, isPrimary: primary }) as PointerEvent;

describe('LineArtKit', () => {
  it('draws until its labels settle, then nothing until something changes', () => {
    const { kit, renderer, frame } = setup();
    for (let i = 0; i < 5; i++) frame();
    const drawn = renderer.render.mock.calls.length;
    // The first frame, and at most a few more while the labels find their places.
    expect(drawn).toBeGreaterThanOrEqual(1);
    expect(drawn).toBeLessThanOrEqual(4);
    for (let i = 0; i < 20; i++) frame();
    expect(renderer.render).toHaveBeenCalledTimes(drawn);
    kit.resize({ width: 1000, height: 700 }, 1);
    frame({ vp: { width: 1000, height: 700 } });
    expect(renderer.render.mock.calls.length).toBeGreaterThan(drawn);
  });

  it('opens a narrow stage on the viewer’s own vault, even when a shared one is larger', () => {
    const { kit, frame } = setup(390, 844);
    frame();
    const { layout, fitted } = inside(kit);
    const own = layout!.plates.find((p) => p.kind === 'vault' && !p.shared)!;
    expect(fitted).toEqual([own.id]);
  });

  it('forgets a finger whose lifting never came: the next touch pans, it does not pinch', () => {
    const { kit, frame } = setup();
    frame();
    kit.pointerDown(pointer(1, 'touch', true), 100, 100);
    // The app was switched away; that finger's pointerup never reached the page.
    kit.pointerDown(pointer(2, 'touch', true), 300, 300);
    const before = { ...inside(kit).cam };
    kit.pointerMove(pointer(2, 'touch', true), 360, 330);
    const after = inside(kit).cam;
    expect(after.ppu).toBe(before.ppu);
    expect(after.tx !== before.tx || after.ty !== before.ty).toBe(true);
  });

  it('pinches between the two fingers left when a third lifts', () => {
    const { kit, frame } = setup();
    frame();
    kit.pointerDown(pointer(1, 'touch', true), 300, 300);
    kit.pointerDown(pointer(2, 'touch', false), 500, 300);
    kit.pointerDown(pointer(3, 'touch', false), 400, 500);
    kit.pointerUp(pointer(1, 'touch', true), 300, 300, false);
    const ppu = inside(kit).cam.ppu;
    // Fingers 2 and 3 spread apart: the map zooms in.
    kit.pointerMove(pointer(2, 'touch', false), 560, 260);
    expect(inside(kit).cam.ppu).toBeGreaterThan(ppu);
  });

  it('frames notes in two vaults by the two vaults', () => {
    const { kit, model, frame } = setup();
    frame();
    const mine = model.nodes.find((n) => n.vault === 'own')!;
    const theirs = model.nodes.find((n) => n.vault !== 'own')!;
    // First one note's folder, so what follows has something to change.
    kit.frameNotes([mine]);
    expect(inside(kit).fitted).toHaveLength(1);
    kit.frameNotes([mine, theirs]);
    const vaultIds = inside(kit)
      .layout!.plates.filter((p) => p.kind === 'vault')
      .map((p) => p.id)
      .sort();
    expect([...inside(kit).fitted!].sort()).toEqual(vaultIds);
  });

  it('aims a flight again when the preview comes up over where it was going', () => {
    const { kit, model, frame, vp } = setup();
    frame();
    const n: GraphNode = model.nodes[0]!;
    kit.reveal(n);
    frame({ selected: n }, 2000);
    const middleOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const drawn = () => kit.screenOf(n)!;
    expect(drawn().x).toBeCloseTo(vp.width / 2, -1);
    // The preview docks on the right: the note is framed again in what is left.
    const sheet: Rect = { x: vp.width - 400, y: 0, w: 400, h: vp.height };
    frame({ selected: n, chrome: [sheet] }, 16);
    frame({ selected: n, chrome: [sheet] }, 2000);
    expect(drawn().x).toBeLessThan(
      middleOf({ x: 0, y: 0, w: vp.width - 400, h: vp.height }).x + 20,
    );
    expect(drawn().x).toBeGreaterThan(
      middleOf({ x: 0, y: 0, w: vp.width - 400, h: vp.height }).x - 20,
    );
  });

  it('does not aim again once the person has moved the camera', () => {
    const { kit, model, frame, vp } = setup();
    frame();
    const n = model.nodes[0]!;
    kit.reveal(n);
    frame({ selected: n }, 2000);
    kit.wheel({ deltaY: -100, deltaMode: 0, ctrlKey: false } as WheelEvent, 200, 200);
    const cam = { ...inside(kit).cam };
    frame({ selected: n, chrome: [{ x: vp.width - 400, y: 0, w: 400, h: vp.height }] }, 2000);
    expect(inside(kit).cam).toEqual(cam);
  });

  it('keeps a lifted block up when the same notes come back in a new model', async () => {
    const { kit, model, frame } = setup();
    frame();
    const n = model.nodes[0]!;
    frame({ selected: n }, 16);
    for (let i = 0; i < 40; i++) frame({ selected: n }, 16);
    const up = [...inside(kit).lifts.values()].map((l) => l.now);
    expect(up).toEqual([0.55]);
    // The same notes, rebuilt: a layer toggled, a refetch that changed nothing here.
    const again = buildGraphModel({
      nodes: model.nodes.map((m) => ({
        id: m.id,
        path: m.path,
        title: m.title,
        ownerId: m.ownerId,
        project: m.project!,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
      edges: [],
      affinity: null,
      layers: DEFAULT_LAYERS,
      viewerId: 'me',
      vaultNames: new Map([['sam', { label: 'Gondor', owner: 'sam' }]]),
      cache: new Map(),
    });
    const boxes = (kit as unknown as { three: { boxes: { setBoxes(): void } } }).three.boxes;
    const rebuilt = vi.spyOn(boxes, 'setBoxes');
    kit.setModel(again);
    await Promise.resolve();
    await Promise.resolve();
    // The same layout comes back: nothing is uploaded again, and the block stays up.
    expect(rebuilt).not.toHaveBeenCalled();
    expect([...inside(kit).lifts.values()].map((l) => l.now)).toEqual([0.55]);
    // A note more moves blocks about: the lifted one is found again where it is now.
    const more = vaults(1);
    kit.setModel(more);
    await new Promise((r) => setTimeout(r, 0));
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect([...inside(kit).lifts.values()].map((l) => l.now)).toEqual([0.55]);
  });

  it('ends a turn at a corner when a drag cuts it short', () => {
    const { kit, frame } = setup();
    frame();
    expect(kit.key({ key: 'e' } as KeyboardEvent)).toBe(true);
    frame({}, 120);
    expect(inside(kit).cam.az).not.toBeCloseTo(snapAz(1, false), 6);
    kit.pointerDown(pointer(1, 'mouse', true), 400, 400);
    expect(inside(kit).tween).toBeNull();
    expect(inside(kit).cam.az).toBeCloseTo(snapAz(1, false), 12);
  });

  it('leaves zoom, Fit, Escape and Back to the controller', () => {
    const { kit } = setup();
    for (const key of ['+', '-', '=', 'f', 'F', 'Escape', 'Backspace', 'Enter', ' ', ']'])
      expect(kit.key({ key } as KeyboardEvent), key).toBe(false);
  });

  it('names the vaults and projects on the map, and every note once close enough', () => {
    const { kit, model, frame, overlay } = setup();
    frame();
    expect(overlay.texts.some((t) => t.startsWith('@sam'))).toBe(true);
    expect(overlay.texts).toContain('ORBIT');
    const n = model.nodes[0]!;
    kit.reveal(n);
    for (let i = 0; i < 4; i++) kit.zoom(1.5);
    overlay.texts.length = 0;
    frame({}, 4000);
    expect(overlay.texts).toContain(n.label);
  });

  it('selects the note clicked, and clears the selection on bare ground', () => {
    const { kit, host, model, frame, at } = setup();
    frame();
    const n = model.nodes[3]!;
    kit.reveal(n);
    // Out a little, where the notes have no labels yet: a label drawn over a block picks its own note.
    kit.zoom(0.6);
    frame({}, 4000);
    const p = at(n);
    // Just under the middle of its top: on its front faces, whichever turn the map is at.
    kit.pointerDown(pointer(1, 'mouse', true), p.x, p.y + 4);
    kit.pointerUp(pointer(1, 'mouse', true), p.x, p.y + 4, false);
    expect(host.select).toHaveBeenCalledWith(n);
    // A drag selects nothing.
    host.select.mockClear();
    kit.pointerDown(pointer(1, 'mouse', true), p.x, p.y + 4);
    kit.pointerMove(pointer(1, 'mouse', true), p.x + 40, p.y + 30);
    kit.pointerUp(pointer(1, 'mouse', true), p.x + 40, p.y + 30, false);
    expect(host.select).not.toHaveBeenCalled();
    // Far out on the ground, with something selected: nothing is.
    kit.fit();
    frame({ selected: n }, 4000);
    kit.pointerDown(pointer(1, 'mouse', true), 2, 2);
    kit.pointerUp(pointer(1, 'mouse', true), 2, 2, false);
    expect(host.clearSelection).toHaveBeenCalled();
  });

  it('opens a note double-clicked', () => {
    const { kit, host, model, frame, at } = setup();
    frame();
    const n = model.nodes[5]!;
    kit.reveal(n);
    frame({}, 4000);
    const p = at(n);
    kit.doubleClick(p.x, p.y + 4);
    expect(host.open).toHaveBeenCalledWith(n);
  });

  it('lifts the block the mouse is over, and lets it down when the mouse leaves', () => {
    const { kit, model, frame, at, host } = setup();
    frame();
    const n = model.nodes[2]!;
    kit.reveal(n);
    frame({}, 4000);
    const p = at(n);
    kit.pointerMove(pointer(1, 'mouse', true), p.x, p.y + 4);
    for (let i = 0; i < 30; i++) frame();
    expect([...inside(kit).lifts.values()].map((l) => l.now)).toEqual([0.36]);
    expect(host.setCursor).toHaveBeenLastCalledWith('pointer');
    kit.pointerLeave();
    for (let i = 0; i < 60; i++) frame();
    expect(inside(kit).lifts.size).toBe(0);
  });

  it('moves a cursor between blocks with the arrows, and Space selects the one it is on', () => {
    const { kit, host, model, frame } = setup();
    const cursorSaid: unknown[] = [];
    host.onCursor = vi.fn((n: unknown) => cursorSaid.push(n));
    frame();
    kit.reveal(model.nodes[0]!);
    frame({}, 4000);
    const cursor = () => (kit as unknown as { cursor: number | null }).cursor;
    expect(kit.key({ key: 'ArrowRight' } as KeyboardEvent)).toBe(true);
    const first = cursor();
    expect(first).not.toBeNull();
    expect(kit.key({ key: 'ArrowRight' } as KeyboardEvent)).toBe(true);
    expect(cursor()).not.toBe(first);
    // A screen reader is told each note the cursor reaches.
    expect(cursorSaid).toHaveLength(2);
    expect(kit.key({ key: ' ' } as KeyboardEvent)).toBe(true);
    expect(host.select).toHaveBeenCalledTimes(1);
    // Enter on a note other than the one selected opens it.
    expect(kit.key({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    expect(host.open).toHaveBeenCalledTimes(1);
  });

  it("walks the selected note's links with ] and [, as the controller feeds each selection back", () => {
    const { kit, host, model, frame } = setup();
    frame();
    // The note with the most links, so the walk has somewhere to go past the first.
    const a = [...model.nodes].sort(
      (p, q) => (model.adjacency.get(q)?.length ?? 0) - (model.adjacency.get(p)?.length ?? 0),
    )[0]!;
    frame({ selected: a });
    const links = [...new Set(model.adjacency.get(a)!.map((x) => x.node))].sort((p, q) =>
      p.title.localeCompare(q.title),
    );
    expect(links.length).toBeGreaterThanOrEqual(2);
    const press = (key: string) => {
      expect(kit.key({ key } as KeyboardEvent)).toBe(true);
      // As the controller does: the selection comes back on the next frame.
      frame({ selected: host.select.mock.lastCall![0] as GraphNode });
      return (host.select.mock.lastCall![0] as GraphNode).id;
    };
    expect(press(']')).toBe(links[0]!.id);
    expect(press(']')).toBe(links[1]!.id);
    expect(press('[')).toBe(links[0]!.id);
    // A selection made some other way starts a new walk; [ first goes to the last link.
    frame({ selected: a }, 16);
    frame({ selected: null }, 16);
    frame({ selected: a }, 16);
    expect(press('[')).toBe(links.at(-1)!.id);
  });

  it('opens what the first click of a double click picked, though its flight moved the map', () => {
    const { kit, host, model, frame, at } = setup();
    frame();
    // Far from the middle, so the flight the first click starts moves it from under the pointer.
    const n = [...model.nodes].sort((a, b) => {
      const pa = at(a);
      const pb = at(b);
      return Math.hypot(pb.x - 600, pb.y - 400) - Math.hypot(pa.x - 600, pa.y - 400);
    })[0]!;
    const p = at(n);
    const click = () => {
      kit.pointerDown(pointer(1, 'mouse', true), p.x, p.y + 4);
      kit.pointerUp(pointer(1, 'mouse', true), p.x, p.y + 4, false);
    };
    click();
    expect(host.select).toHaveBeenLastCalledWith(n);
    // The controller selects it and the kit flies to it; the second click comes mid-flight.
    kit.reveal(n);
    frame({ selected: n }, 200);
    expect(Math.hypot(at(n).x - p.x, at(n).y - p.y)).toBeGreaterThan(20);
    click();
    expect(host.select).toHaveBeenCalledTimes(1);
    kit.doubleClick(p.x, p.y + 4);
    expect(host.open).toHaveBeenCalledWith(n);
  });

  it('works out where the map is again after the zoom buttons, and Escape never steps in', () => {
    const { kit, host, model, frame } = setup();
    frame();
    const n = model.nodes.find((m) => m.path.includes('specs'))!;
    kit.frameNotes([n]);
    frame({}, 4000);
    const said = () => (host.onPlace.mock.lastCall![0] as { label: string }[]).map((s) => s.label);
    expect(said().at(-1)).toBe('specs');
    for (let i = 0; i < 6; i++) kit.zoom(0.7);
    frame({}, 4000);
    frame({}, 16);
    expect(said().at(-1)).not.toBe('specs');
    const before = inside(kit).cam.ppu;
    if (kit.up()) {
      frame({}, 4000);
      expect(inside(kit).cam.ppu).toBeLessThanOrEqual(before * 1.0001);
    }
  });

  it('shows the cursor only once the keyboard moves it, and the pointer hides it', () => {
    const { kit, model, frame } = setup();
    frame();
    const shown = () =>
      (kit as unknown as { keyboard: boolean; cursor: number | null }).keyboard &&
      (kit as unknown as { cursor: number | null }).cursor !== null;
    // A selection made by the pointer moves the cursor but does not show it.
    frame({ selected: model.nodes[0]! });
    expect(shown()).toBe(false);
    expect(kit.key({ key: 'ArrowDown' } as KeyboardEvent)).toBe(true);
    expect(shown()).toBe(true);
    kit.pointerDown(pointer(1, 'mouse', true), 10, 10);
    expect(shown()).toBe(false);
    // Enter opens the cursor's note only when the keyboard put it there.
    expect(kit.key({ key: 'Enter' } as KeyboardEvent)).toBe(false);
    // Nor does a note once selected by the pointer stay lifted when the selection goes.
    kit.pointerUp(pointer(1, 'mouse', true), 10, 10, true);
    frame({ selected: null }, 16);
    for (let i = 0; i < 60; i++) frame({ selected: null });
    expect(inside(kit).lifts.size).toBe(0);
  });

  it('steps out a level at a time, says where the map is, and stops at the whole map', () => {
    const { kit, host, model, frame } = setup();
    frame();
    const n = model.nodes.find((m) => m.path.includes('specs'))!;
    kit.frameNotes([n]);
    frame({}, 4000);
    const said = () => (host.onPlace.mock.lastCall![0] as { label: string }[]).map((s) => s.label);
    expect(said()).toEqual(['Your vault', 'Orbit', 'specs']);
    expect(kit.up()).toBe(true);
    frame({}, 4000);
    expect(said()).toEqual(['Your vault', 'Orbit']);
    expect(kit.up()).toBe(true);
    frame({}, 4000);
    expect(said()).toEqual(['Your vault']);
    expect(kit.up()).toBe(true);
    frame({}, 4000);
    expect(said()).toEqual([]);
    expect(kit.up()).toBe(false);
    // A step of the breadcrumb flies to its plate.
    kit.focusPlace(inside(kit).layout!.plates.find((p) => p.kind === 'vault' && p.shared)!.id);
    frame({}, 4000);
    expect(said()).toHaveLength(1);
  });

  it('says where a note is drawn, and nothing for one off the stage', () => {
    const { kit, model, frame } = setup();
    frame();
    const n = model.nodes[0]!;
    const p = kit.screenOf(n)!;
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
    // Far in on another note: this one is off the stage.
    kit.reveal(model.nodes.at(-1)!);
    for (let i = 0; i < 6; i++) kit.zoom(1.5);
    frame({}, 4000);
    expect(kit.screenOf(n)).toBeNull();
  });

  it("cables the selected note's links, grown in from it, and nothing without a selection", () => {
    const { kit, host, model, frame } = setup();
    frame();
    expect(cablesOf(kit)).toEqual([]);
    // n0 links to n1 and n2.
    const n = model.nodes[0]!;
    frame({ selected: n });
    expect(cablesOf(kit).map((c) => c.kind)).toEqual([CABLE.link, CABLE.link]);
    expect(progressOf(kit)).toBeLessThan(0.3);
    let last = progressOf(kit);
    for (let t = 0; t < GROW_MS; t += 16) {
      frame();
      expect(progressOf(kit)).toBeGreaterThanOrEqual(last);
      last = progressOf(kit);
    }
    frame();
    expect(progressOf(kit)).toBe(1);
    // The same selection's cables laid again (a layer turned on) stay grown.
    frame({ routes: true });
    expect(cablesOf(kit)).toHaveLength(2);
    expect(progressOf(kit)).toBe(1);
    frame({ routes: false });
    frame({ selected: null });
    expect(cablesOf(kit)).toEqual([]);
    expect(inside(kit).three!.cables.visible.visible).toBe(false);
    // Asked for less motion, the links are there at once.
    (host as { reduceMotion: boolean }).reduceMotion = true;
    frame({ selected: model.nodes[1]! });
    expect(cablesOf(kit)).toHaveLength(1);
    expect(progressOf(kit)).toBe(1);
  });

  it('runs one cable per pair of linked projects with All routes on, labelled with its links', () => {
    const model = projects();
    const { kit, frame, overlay } = setup(1200, 800, model);
    frame();
    expect(cablesOf(kit)).toEqual([]);
    for (let i = 0; i < 4; i++) frame({ routes: true });
    const routes = cablesOf(kit);
    expect(routes.map((c) => c.kind)).toEqual([CABLE.route, CABLE.route]);
    // As the buffer holds them: in single precision.
    expect(routes.map((c) => c.width).sort()).toEqual(
      [routeWidth(1), routeWidth(3)].map(Math.fround).sort(),
    );
    expect(overlay.texts).toContain('3');
    expect(overlay.texts).toContain('1');
    // A selection's links ride over them, drawn after.
    frame({ selected: model.nodes[0]! });
    expect(cablesOf(kit).map((c) => c.kind)).toEqual([CABLE.route, CABLE.route, CABLE.link]);
    frame({ routes: false, selected: null });
    expect(cablesOf(kit)).toEqual([]);
    overlay.texts.length = 0;
    for (let i = 0; i < 4; i++) frame({}, 16);
    kit.invalidate();
    frame();
    expect(overlay.texts).not.toContain('3');
    // Its buffers go with the kit.
    const free = vi.spyOn(inside(kit).three!.cables, 'dispose');
    kit.dispose();
    expect(free).toHaveBeenCalledOnce();
  });

  it('brackets what a search found on the stage, two hundred at the most', () => {
    const model = vaults(300);
    const { kit, frame } = setup(1200, 800, model);
    frame();
    const bracket = vi.spyOn(kit as unknown as { bracket: () => boolean }, 'bracket');
    const drawn = () => bracket.mock.results.filter((r) => r.value === true).length;
    frame({ matches: new Set(model.nodes.slice(0, 3)) });
    expect(drawn()).toBe(3);
    bracket.mockClear();
    frame({ matches: new Set(model.nodes) });
    expect(drawn()).toBe(200);
    bracket.mockClear();
    // Far in on one note: the others, in another vault, are off the stage and not bracketed.
    kit.reveal(model.nodes[0]!);
    for (let i = 0; i < 6; i++) kit.zoom(1.5);
    frame({ matches: new Set([model.nodes[0]!, ...model.nodes.slice(-2)]) }, 4000);
    expect(drawn()).toBe(1);
  });

  it('draws coarser while the camera moves and frames come late, and at its sharpest at rest', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    expect(host.setPixelRatio).not.toHaveBeenCalled();
    const grid = () => inside(kit).three!.grid.mesh.visible;
    // A drag whose frames come 30 ms apart: a missed vsync each.
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    let x = 600;
    const drag = (frames: number, ms: number) => {
      for (let i = 0; i < frames; i++) {
        x += 3;
        kit.pointerMove(pointer(1, 'mouse', true), x, 400);
        frame({}, ms);
      }
    };
    drag(45, 30);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    // The window resized under it: the controller drew the buffer at the page's ratio again,
    // and the kit asks for its step back on its next frame.
    kit.resize({ width: 1200, height: 800 }, 2);
    host.setPixelRatio.mockClear();
    drag(1, 30);
    expect(host.setPixelRatio).toHaveBeenCalledWith(1.5);
    // Down every step, and past the last the dot grid goes too.
    drag(200, 30);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(grid()).toBe(false);
    // Held still mid-drag, it stays as it is.
    const calls = host.setPixelRatio.mock.calls.length;
    for (let i = 0; i < 20; i++) frame({}, 16);
    expect(host.setPixelRatio).toHaveBeenCalledTimes(calls);
    kit.pointerUp(pointer(1, 'mouse', true), x, 400, false);
    for (let i = 0; i < 20; i++) frame({}, 16);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(2);
    expect(grid()).toBe(true);
  });

  it('judges a step by the frames drawn at it, not the ones drawn at the step before', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    const gov = (kit as unknown as { quality: QualityGovernor }).quality;
    const seen: { step: number; ms: number }[] = [];
    const moving = gov.moving.bind(gov);
    vi.spyOn(gov, 'moving').mockImplementation((ms: number) => {
      seen.push({ step: gov.step, ms });
      return moving(ms);
    });
    // A frame drawn at 2 costs 30 ms, at any lower ratio 17: the time until the next frame.
    let ratio = 2;
    host.setPixelRatio.mockImplementation((r: number) => {
      ratio = r;
    });
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    let cost = 16;
    for (let i = 1; i <= 90; i++) {
      kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 3, 400);
      frame({}, cost);
      cost = ratio === 2 ? 30 : 17;
    }
    expect(host.setPixelRatio).toHaveBeenCalledWith(1.5);
    const after = seen.filter((s) => s.step === 1);
    expect(after.length).toBeGreaterThan(20);
    // Not one of them is the slow frame drawn at 2 that came before the step.
    expect(after.every((s) => Math.abs(s.ms - 17) < 1e-6)).toBe(true);
  });

  it("steps down when a draw's cost comes a frame late, as the GPU catches up", () => {
    // A slow draw, then a frame at once that draws nothing, then the wait for the GPU: the cost
    // lands on the frame the camera moves in next.
    const drag = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) drag.frame();
    drag.kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 60; i++) {
      drag.kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 3, 400);
      drag.frame({}, 125);
      drag.frame({}, 7);
    }
    expect(drag.host.setPixelRatio).toHaveBeenCalledWith(1.5);
    // Wheel notches on a slow machine, the frame between two of them as slow as they are: not
    // the browser's cadence, which is only measured well clear of a draw.
    const wheel = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) wheel.frame();
    const notch = { deltaY: -10, deltaMode: 0, ctrlKey: false } as WheelEvent;
    for (let i = 0; i < 60; i++) {
      wheel.kit.wheel(notch, 600, 400);
      wheel.frame({}, 200);
      wheel.frame({}, 200);
    }
    expect(wheel.host.setPixelRatio).toHaveBeenCalledWith(1.5);
  });

  it('takes a browser that draws at 30 fps for what it is, and moves a 1.75 screen at 1.75', () => {
    // Every frame 33 ms apart, at rest as while moving: nothing to gain from fewer pixels.
    const capped = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 40; i++) capped.frame({}, 33.3);
    capped.kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 300; i++) {
      capped.kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 2, 400);
      capped.frame({}, 33.3);
    }
    expect(capped.host.setPixelRatio).not.toHaveBeenCalled();
    expect(inside(capped.kit).three!.grid.mesh.visible).toBe(true);
    // A ratio between two steps, frames on time: drawn at the screen's own throughout.
    const between = setup(1200, 800, vaults(), 1.75);
    for (let i = 0; i < 6; i++) between.frame();
    between.kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 60; i++) {
      between.kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 2, 400);
      between.frame({}, 16);
    }
    between.kit.pointerUp(pointer(1, 'mouse', true), 720, 400, false);
    for (let i = 0; i < 20; i++) between.frame({}, 16);
    expect(between.host.setPixelRatio).not.toHaveBeenCalled();
  });

  it('takes no gap between two notches of the wheel for rest on a slow machine', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 45; i++) {
      kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 3, 400);
      frame({}, 30);
    }
    kit.pointerUp(pointer(1, 'mouse', true), 735, 400, false);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    host.setPixelRatio.mockClear();
    // Frames 300 ms apart, a notch every other one: never long enough still to draw it sharp.
    const notch = { deltaY: -40, deltaMode: 0, ctrlKey: false } as WheelEvent;
    for (let i = 0; i < 12; i++) {
      kit.wheel(notch, 600, 400);
      frame({}, 300);
      frame({}, 300);
    }
    expect(host.setPixelRatio.mock.calls.filter(([r]) => r === 2)).toEqual([]);
    // Still for a few of its frames: sharp again.
    for (let i = 0; i < 4; i++) frame({}, 300);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(2);
  });

  it('judges only frames the camera moved for: cables growing and blocks lifting are not', () => {
    const { kit, host, model, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    // A new selection every 450 ms, its links growing in and its block lifting, frames 30 ms apart.
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 15; j++) frame({ selected: model.nodes[i % 3]! }, 30);
    expect(host.setPixelRatio).not.toHaveBeenCalled();
    expect((kit as unknown as { quality: QualityGovernor }).quality.step).toBe(0);
  });

  it('takes no quick run of frames for rest: still for a while, too', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 45; i++) {
      kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 3, 400);
      frame({}, 30);
    }
    kit.pointerUp(pointer(1, 'mouse', true), 735, 400, false);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    host.setPixelRatio.mockClear();
    // A fast screen, frames 8 ms apart, a notch every six: three still frames are no rest.
    const notch = { deltaY: -10, deltaMode: 0, ctrlKey: false } as WheelEvent;
    for (let i = 0; i < 20; i++) {
      kit.wheel(notch, 600, 400);
      for (let j = 0; j < 6; j++) frame({}, 8);
    }
    expect(host.setPixelRatio.mock.calls.filter(([r]) => r === 2)).toEqual([]);
  });

  it('starts a sharper screen at its own sharpest, when the last one never stepped down', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 1);
    for (let i = 0; i < 6; i++) frame();
    // Dragged onto a 2× screen: the controller sizes the buffer for it, then tells the kit.
    kit.resize({ width: 1200, height: 800 }, 2);
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 40; i++) {
      kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 3, 400);
      frame({ dpr: 2 }, 16);
    }
    expect(host.setPixelRatio).not.toHaveBeenCalled();
  });

  it('does not count the draw a resize of the buffer is in, so short pans keep their step', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    const gov = () => (kit as unknown as { quality: QualityGovernor }).quality;
    // Down a step first, on late frames.
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 45; i++) {
      kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 3, 400);
      frame({}, 30);
    }
    kit.pointerUp(pointer(1, 'mouse', true), 735, 400, false);
    expect(gov().step).toBe(1);
    // Then short pans with rests between, each starting and ending with a resize whose draw
    // misses a vsync; every other frame makes it.
    let resized = false;
    let late = false;
    host.setPixelRatio.mockImplementation(() => {
      resized = true;
    });
    // The frame after the one that resized comes late.
    const tick = () => {
      frame({}, late ? 40 : 16.7);
      late = resized;
      resized = false;
    };
    for (let pan = 0; pan < 30; pan++) {
      kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
      for (let i = 1; i <= 12; i++) {
        kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 5, 400);
        tick();
      }
      kit.pointerUp(pointer(1, 'mouse', true), 660, 400, false);
      for (let i = 0; i < 20; i++) tick();
    }
    expect(gov().step).toBeLessThanOrEqual(1);
  });

  it('charges a lone wheel notch with the wait for the GPU that comes frames after it', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    const notch = { deltaY: -10, deltaMode: 0, ctrlKey: false } as WheelEvent;
    // A notch every 200 ms or so: its draw, a frame at once, then the stall, then calm.
    for (let i = 0; i < 60; i++) {
      kit.wheel(notch, 600, 400);
      frame({}, 16.7);
      frame({}, 7);
      frame({}, 125);
      for (let j = 0; j < 4; j++) frame({}, 16.7);
    }
    expect(host.setPixelRatio).toHaveBeenCalledWith(1.5);
  });

  it('charges a draw only with the frames just after it, not a hitch long after', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    const notch = { deltaY: -10, deltaMode: 0, ctrlKey: false } as WheelEvent;
    // Each notch drawn in time; a hitch of the page's own a few frames later, then calm.
    for (let i = 0; i < 80; i++) {
      kit.wheel(notch, 600, 400);
      for (let j = 0; j < 4; j++) frame({}, 16.7);
      frame({}, 150);
      for (let j = 0; j < 3; j++) frame({}, 16.7);
    }
    expect(host.setPixelRatio).not.toHaveBeenCalled();
  });

  it('does not count the draw after the window was resized, which the resizing is in', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    // The stage resized under a drag, frame after frame: each draw after it misses a vsync.
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 1; i <= 120; i++) {
      kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 2, 400);
      const vp = { width: 1200 - (i % 2), height: 800 };
      kit.resize(vp, 2);
      frame({ vp }, 16.7);
      frame({ vp }, 40);
    }
    expect(host.setPixelRatio).not.toHaveBeenCalled();
  });

  it('takes a drag whose lifting never came for rest, after a while', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    kit.pointerDown(pointer(1, 'touch', true), 600, 400);
    for (let i = 1; i <= 45; i++) {
      kit.pointerMove(pointer(1, 'touch', true), 600 + i * 4, 400);
      frame({}, 30);
    }
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    // No pointerup: an app switch took it. Held a moment, still coarse; held a second, rest.
    for (let i = 0; i < 20; i++) frame({}, 16);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    for (let i = 0; i < 60; i++) frame({}, 16);
    expect(host.setPixelRatio).toHaveBeenLastCalledWith(2);
  });

  it('counts a pause as no frame at all', () => {
    const { kit, host, frame } = setup(1200, 800, vaults(), 2);
    for (let i = 0; i < 6; i++) frame();
    kit.pointerDown(pointer(1, 'mouse', true), 600, 400);
    for (let i = 0; i < 60; i++) {
      kit.pointerMove(pointer(1, 'mouse', true), 600 + i * 3, 400);
      frame({}, 2000);
    }
    expect(host.setPixelRatio).not.toHaveBeenCalled();
  });
});
