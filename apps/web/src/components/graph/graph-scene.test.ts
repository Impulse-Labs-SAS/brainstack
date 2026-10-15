// The scene in Node: three.js as it is but for its renderer, which needs a WebGL context Node has
// not got. What is checked is what the scene works out before it draws: the brain's fade, which
// notes pulse and by how much, and what it says of both to the frame loop that decides whether
// to draw at all.

import type * as Three from 'three';
import { describe, expect, it, vi } from 'vitest';

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof Three>();
  /** Draws nothing: there is no WebGL here. */
  class WebGLRenderer {
    setClearColor() {}
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
  }
  return { ...three, WebGLRenderer };
});

import { DEFAULT_LAYERS, buildGraphModel, type GraphModel } from '@/lib/graph-model';

import { GraphScene, type SceneFrame } from './graph-scene';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

/** Notes edited `daysAgo` days back each, laid out in a row (invented names). */
function notes(daysAgo: number[]): GraphModel {
  const model = buildGraphModel({
    nodes: daysAgo.map((d, i) => ({
      id: `me/Orbit/n${i}.md`,
      path: `Orbit/n${i}.md`,
      title: `Orbit note ${i}`,
      ownerId: 'me',
      project: { id: 'me|Orbit', label: 'Orbit' },
      createdAt: NOW - 400 * DAY,
      updatedAt: NOW - d * DAY,
    })),
    edges: [],
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
  model.nodes.forEach((n, i) => Object.assign(n, { x: i * 40, y: 0, z: 0 }));
  return model;
}

function frame(over: Partial<SceneFrame> = {}): SceneFrame {
  return {
    now: 1000,
    dt: 16,
    wallClock: NOW,
    cam: { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, dist: 800 },
    vp: { width: 800, height: 600 },
    dpr: 1,
    is3D: false,
    brainScale: 200,
    cloud: 0,
    view: 'network',
    landAlpha: 0,
    mapBlend: 0,
    hotCountry: null,
    edgeScale: 1,
    hops: null,
    pathNodes: null,
    pathEdges: null,
    matched: null,
    moved: false,
    edgesDirty: true,
    appear: () => 1,
    flash: () => 0,
    pulse: 1,
    reduceMotion: false,
    ...over,
  };
}

function sceneOf(model: GraphModel): GraphScene {
  const scene = new GraphScene({} as HTMLCanvasElement);
  scene.setModel(model);
  return scene;
}

/** How brightly each note glows in the last frame drawn. */
const glowOf = (scene: GraphScene) => [
  ...(scene as unknown as { buffers: { glow: Float32Array } }).buffers.glow,
];

describe('GraphScene', () => {
  it('fades the brain in and out and says so until it has arrived, exactly', () => {
    const scene = sceneOf(notes([30, 60]));
    expect(scene.easing).toBe(false);
    for (const is3D of [true, false]) {
      scene.render(frame({ is3D }));
      expect(scene.easing, `into ${is3D ? 'the brain' : 'Network'}`).toBe(true);
      let frames = 1;
      while (scene.easing && frames < 1000) {
        scene.render(frame({ is3D }));
        frames++;
      }
      // About a second and a half, not the hundreds an ease that only ever gets closer takes.
      expect(frames).toBeLessThan(120);
    }
    // Under reduced motion it is a cut: there by the first frame.
    scene.render(frame({ is3D: true, reduceMotion: true }));
    expect(scene.easing).toBe(false);
  });

  it('says it drew notes that pulse only when one edited this week is shown', () => {
    expect(sceneOf(notes([1, 30])).pulses).toBe(false);
    const cases: [string, number[], Partial<SceneFrame>, boolean][] = [
      ['one edited yesterday', [1, 30], {}, true],
      ['none this week', [8, 30], {}, false],
      ['under reduced motion', [1, 30], { reduceMotion: true }, false],
      ['not shown yet', [1, 30], { appear: () => 0 }, false],
    ];
    for (const [what, daysAgo, over, pulses] of cases) {
      const scene = sceneOf(notes(daysAgo));
      scene.render(frame(over));
      expect(scene.pulses, what).toBe(pulses);
    }
  });

  it('pulses them as much as it is told, and holds them still at none', () => {
    const scene = sceneOf(notes([1, 30]));
    const at = (now: number, pulse: number) => {
      scene.render(frame({ now, pulse }));
      return glowOf(scene);
    };
    const [active, still] = [0, 1];
    const full = [0, 400, 800, 1200].map((t) => at(t, 1));
    expect(new Set(full.map((g) => g[active])).size).toBeGreaterThan(1);
    // A note edited a month ago never pulses.
    expect(new Set(full.map((g) => g[still])).size).toBe(1);
    // At none, the active note glows the same whenever it is drawn.
    const none = [0, 400, 800, 1200].map((t) => at(t, 0));
    expect(new Set(none.map((g) => g[active])).size).toBe(1);
    expect(none[0]![active]).toBeGreaterThan(0);
    // Half the pulse swings half as far either way of that glow.
    const half = [0, 400, 800, 1200].map((t) => at(t, 0.5)[active]! - none[0]![active]!);
    // Read back from Float32Arrays: equal to six places.
    full.forEach((g, i) => expect(half[i]).toBeCloseTo((g[active]! - none[0]![active]!) / 2, 6));
  });
});
