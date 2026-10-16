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
    vaultNames: new Map(),
    cache: new Map(),
  });
}

interface Inside {
  cam: IsoCam;
  fitted: string[] | null;
  tween: unknown;
  lifts: Map<number, { now: number; to: number }>;
  layout: { plates: { id: string; kind: string; shared: boolean }[] } | null;
}
const inside = (kit: LineArtKit) => kit as unknown as Inside;

function setup(width = 1200, height = 800, model = vaults()) {
  const renderer = { render: vi.fn() };
  const overlay = {
    canvas: { width, height },
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  };
  const host = {
    renderer,
    overlay,
    fonts: { sans: 'sans-serif', mono: 'monospace' },
    labelPx: 12,
    reduceMotion: false,
    onUserCamera: vi.fn(),
    setCursor: vi.fn(),
  } as unknown as KitHost & { onUserCamera: ReturnType<typeof vi.fn> };
  const kit = new LineArtKit();
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
  };
  const frame = (over: Partial<KitFrame> = {}, ms = 16) => {
    now += ms;
    Object.assign(base, over, { now });
    kit.frame({ ...base });
  };
  return { kit, host, renderer, model, frame, vp };
}

const pointer = (id: number, type: string, primary: boolean) =>
  ({ pointerId: id, pointerType: type, isPrimary: primary }) as PointerEvent;

describe('LineArtKit', () => {
  it('draws once, then nothing until something changes', () => {
    const { kit, renderer, frame } = setup();
    frame();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) frame();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    kit.resize({ width: 1000, height: 700 }, 1);
    frame({ vp: { width: 1000, height: 700 } });
    expect(renderer.render).toHaveBeenCalledTimes(2);
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
    kit.pointerUp(pointer(1, 'touch', true));
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
      vaultNames: new Map(),
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

  it('leaves zoom, Fit and the arrows to the controller', () => {
    const { kit } = setup();
    for (const key of ['+', '-', '=', 'f', 'F', 'ArrowLeft', 'Escape', 'Enter'])
      expect(kit.key({ key } as KeyboardEvent), key).toBe(false);
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
});
