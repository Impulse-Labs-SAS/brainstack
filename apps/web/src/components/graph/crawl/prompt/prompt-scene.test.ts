import { describe, expect, it, vi } from 'vitest';

import { boundsOf, type Camera, type Viewport } from '@/lib/graph-camera';

import { CrawlReplay } from '../crawl-replay';
import { sampleVault } from '../sample-vault';
import { GRIP_SLOTS } from '../sentinel/anatomy';
import { polylineThreadField } from '../space/polyline-field';
import type { SpaceBuild } from '../space/space';
import { volumeLayout } from '../space/volume/layout';
import { notesReach, overviewCamera } from '../stage/overview';
import type { Vec3 } from '../vec';

import { PERCH_ID, PERCH_RAIL_SET } from './perch-field';
import {
  PromptScene,
  defaultPromptKnobs,
  type PromptFrame,
  type PromptLayout,
} from './prompt-scene';
import { AT_CRAWL, AT_PROMPT } from './transition';

const PHONE: Viewport = { width: 375, height: 812 };
const LAPTOP: Viewport = { width: 1280, height: 800 };
const WIDE: Viewport = { width: 2560, height: 1440 };

/** The sample vault laid out as the dormant network builds it: a cluster, its field, bounds round its notes. */
function space(): { build: SpaceBuild; vault: ReturnType<typeof sampleVault> } {
  const vault = sampleVault();
  const l = volumeLayout(vault.model);
  const field = polylineThreadField({
    nodes: l.positions,
    routes: l.routes,
    adjacency: l.adjacency,
    cell: l.unit,
  });
  const bounds = boundsOf([...l.positions.values()].map(([x, y, z]) => ({ x, y, z })))!;
  return {
    vault,
    build: {
      positions: l.positions,
      field,
      unit: l.unit,
      bounds,
      pace: 9 * l.unit,
      camera: { pitch: 0.3, follow: 8 },
    },
  };
}

/** The scene laid out on `vp`: the box centred as the page lays it out, the overview from the lab's angle. */
function layoutOf(build: SpaceBuild, vp: Viewport, dy = 0, width?: number): PromptLayout {
  const w = width ?? Math.min(560, 0.8 * vp.width);
  const overview = overviewCamera(build.bounds, vp, 0.5, build.camera.pitch);
  const target: Vec3 = [overview.tx, overview.ty, overview.tz];
  return {
    vp,
    rect: {
      left: (vp.width - w) / 2,
      top: (vp.height - 56) / 2 + dy,
      width: w,
      height: 56,
      radius: 16,
    },
    overview,
    radius: notesReach(build.positions.values(), target, build.unit),
  };
}

/** A scene resting at the prompt on `vp`. */
function atPrompt(vp = LAPTOP) {
  const { build, vault } = space();
  const replay = new CrawlReplay(() => {});
  const scene = new PromptScene(replay);
  scene.setSpace(build, vault.model);
  const layout = layoutOf(build, vp);
  expect(scene.layout(layout)).toBe(true);
  expect(scene.reset()).toBe(true);
  return { scene, replay, build, vault, layout };
}

/**
 * Runs the scene and its replay together at `fps` from `t` until `done`, the
 * replay advanced by real time as the host advances it. Returns the frames
 * and the time it stopped at.
 */
function play(
  s: { scene: PromptScene; replay: CrawlReplay },
  t: number,
  done: (f: PromptFrame) => boolean,
  fps = 60,
): { frames: Array<PromptFrame & { t: number; hereId: string | null }>; t: number } {
  const frames: Array<PromptFrame & { t: number; hereId: string | null }> = [];
  let f = s.scene.frame(t, false);
  let guard = 0;
  while (!done(f) && guard++ < 10_000) {
    t += 1 / fps;
    s.replay.update(1 / fps);
    s.replay.drain();
    f = s.scene.frame(t, false);
    frames.push({ ...f, t, hereId: s.replay.view.hereId });
  }
  expect(done(f)).toBe(true);
  return { frames, t };
}

const holdsOf = (r: CrawlReplay) => r.view.holds.map((h) => (h ? { key: h.key, u: h.u } : null));

describe('PromptScene', () => {
  it('rests on the frame after a reset, holding the camera on the perch shot', () => {
    const { scene, replay } = atPrompt();
    expect(scene.name).toBe('prompt');
    expect(scene.available).toBe(true);
    expect(scene.field).not.toBeNull();
    const f = scene.frame(0, false);
    expect(f.scene).toBe('prompt');
    expect(f.moving).toBe(false);
    expect(f.levels).toEqual(AT_PROMPT);
    expect(f.camera).toEqual(scene.shot!.cam);
    expect(f.handoff).toBeNull();
    expect(f.atRest).toBe(true);
    expect(f.interactive).toBe(true);
    expect(replay.resting).toBe(true);
    expect(replay.view.hereId).toBe(PERCH_ID);
    // The eye rests where the knob says.
    expect(f.gaze).toBe(scene.shot!.viewer);
    scene.knobs.gaze = 'box';
    expect(scene.frame(0, false).gaze).toBe(scene.shot!.box);
    scene.knobs.gaze = 'perch';
    expect(scene.frame(0, false).gaze).toBeNull();
  });

  it('takes hold of the frame with every claw at the defaults, on a phone, a laptop and a wide screen', () => {
    for (const vp of [PHONE, LAPTOP, WIDE]) {
      const { replay } = atPrompt(vp);
      const holds = replay.view.holds;
      expect(holds.every((h) => h !== null)).toBe(true);
      for (const side of [-1, 1]) {
        expect(holds.filter((h, g) => h && GRIP_SLOTS[g]!.side === side)).toHaveLength(3);
      }
      for (const h of holds) expect(PERCH_RAIL_SET.has(h!.key)).toBe(true);
      // It holds the frame round about, not one rail: on a wide box the top and the
      // sides, on a phone's narrow one the sides and the bottom.
      expect(new Set(holds.map((h) => h!.key)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('sets out from the frame on a submit: the timeline holds the camera, hands it over, and ends at the crawl', () => {
    const s = atPrompt();
    const { scene, replay, vault, layout } = s;
    const t0 = 10;
    expect(scene.submit(vault.crawls.tour, t0, false)).toBe(true);
    expect(scene.name).toBe('crawl');
    expect(replay.view.hereId).toBe(PERCH_ID);
    expect(replay.view.walk!.void).toBe(true);
    const arrive = replay.view.walk!.duration;
    const first = scene.frame(t0, false);
    expect(first.camera).toEqual(scene.shot!.cam);
    expect(first.levels).toEqual(AT_PROMPT);
    expect(first.interactive).toBe(false);
    expect(first.gaze).toBeNull();
    const handoff = scene.knobs.times.handoff;
    const { frames } = play(s, t0, (f) => !f.moving);
    let lastDist = first.camera!.dist;
    for (const f of frames) {
      const t = f.t - t0;
      if (t < arrive - 1e-9) {
        // Backing out to the overview while it crosses.
        expect(f.camera).not.toBeNull();
        expect(f.camera!.dist).toBeGreaterThanOrEqual(lastDist - 1e-9);
        lastDist = f.camera!.dist;
        expect(f.hereId).toBe(PERCH_ID);
      } else if (t < arrive + handoff - 1e-9) {
        // Landed as the camera did; the overview handed over, eased.
        expect(f.camera).toBeNull();
        expect(f.handoff!.camera).toEqual(layout.overview);
        expect(f.handoff!.k).toBeGreaterThanOrEqual(0);
        expect(f.handoff!.k).toBeLessThanOrEqual(1);
        // On the clock the replay keeps, a rounding apart from this one.
        if (t > arrive + 1e-6) expect(f.hereId).not.toBe(PERCH_ID);
      }
    }
    const last = frames.at(-1)!;
    expect(last.t - t0).toBeGreaterThanOrEqual(arrive + handoff - 1e-9);
    expect(last.levels).toEqual(AT_CRAWL);
    expect(last.camera).toBeNull();
    expect(last.handoff).toBeNull();
    expect(last.interactive).toBe(false);
    // A second send is refused: there is no input in the crawl.
    expect(scene.submit(vault.crawls.walk, last.t, false)).toBe(false);
  });

  it('goes back on "new search": the walk recalled, the camera eased from where it was to the shot', () => {
    const s = atPrompt();
    const { scene, replay, vault } = s;
    expect(scene.submit(vault.crawls.tour, 0, false)).toBe(true);
    let { t } = play(s, 0, (f) => !f.moving);
    ({ t } = play(s, t, () => replay.view.clock > 6));
    const from: Camera = { tx: 3, ty: 4, tz: 5, yaw: 0.9, pitch: 0.5, dist: 250 };
    expect(scene.back(t, false, from)).toBe(true);
    expect(scene.name).toBe('prompt');
    expect(replay.view.walk!.void).toBe(true);
    expect(replay.view.nextId).toBe(PERCH_ID);
    // Already going there.
    expect(scene.back(t, false, from)).toBe(false);
    const first = scene.frame(t, false);
    expect(first.camera).toEqual(from);
    expect(first.gaze).toBe(scene.shot!.viewer);
    const { frames } = play(s, t, (f) => f.interactive);
    for (const f of frames) {
      // The prompt holds the camera all the way.
      expect(f.camera).not.toBeNull();
      expect(f.handoff).toBeNull();
      if (f.moving) expect(f.interactive).toBe(false);
      if (!replay.resting) expect(f.interactive).toBe(false);
    }
    const last = frames.at(-1)!;
    expect(last.camera).toEqual(scene.shot!.cam);
    expect(last.levels).toEqual(AT_PROMPT);
    expect(last.moving).toBe(false);
    expect(replay.resting).toBe(true);
    // The input whole and the camera home as the claws close on the frame.
    const landed = frames.findIndex((f) => f.hereId === PERCH_ID);
    expect(frames[landed]!.camera).toEqual(scene.shot!.cam);
    expect(frames[landed]!.levels.prompt).toBe(1);
  });

  it('cuts every change under reduced motion: levels and camera final in the same frame', () => {
    const { scene, replay, vault } = atPrompt();
    expect(scene.submit(vault.crawls.walk, 0, true)).toBe(true);
    const there = scene.frame(0, true);
    expect(there.levels).toEqual(AT_CRAWL);
    expect(there.camera).toBeNull();
    expect(there.handoff).toBeNull();
    expect(there.moving).toBe(false);
    replay.skipToEnd();
    const from: Camera = { tx: 0, ty: 0, tz: 0, yaw: 0.5, pitch: 0.3, dist: 300 };
    expect(scene.back(1, true, from)).toBe(true);
    // The host jumps the replay to its end: back on the frame, its grips landed.
    replay.skipToEnd();
    const back = scene.frame(1, true);
    expect(back.levels).toEqual(AT_PROMPT);
    expect(back.camera).toEqual(scene.shot!.cam);
    expect(back.moving).toBe(false);
    expect(back.interactive).toBe(true);
    // A transition started with motion ends at once when motion is turned off midway.
    expect(scene.submit(vault.crawls.walk, 2, false)).toBe(true);
    expect(scene.frame(2.3, false).moving).toBe(true);
    const cut = scene.frame(2.4, true);
    expect(cut.moving).toBe(false);
    expect(cut.levels).toEqual(AT_CRAWL);
  });

  it('refuses a send while going back, and turns round from where it was when sent back midway', () => {
    const s = atPrompt();
    const { scene, replay, vault } = s;
    expect(scene.submit(vault.crawls.tour, 0, false)).toBe(true);
    const { t } = play(s, 0, (f) => f.levels.prompt < 0.6 && f.levels.panel > 0.5);
    const midway = scene.frame(t, false);
    expect(midway.moving).toBe(true);
    expect(scene.back(t, false, midway.camera!)).toBe(true);
    const turned = scene.frame(t, false);
    expect(turned.levels).toEqual(midway.levels);
    expect(turned.camera).toEqual(midway.camera);
    expect(scene.submit(vault.crawls.walk, t, false)).toBe(false);
    const { t: home } = play(s, t, (f) => f.interactive);
    expect(replay.resting).toBe(true);
    expect(scene.submit(vault.crawls.walk, home, false)).toBe(true);
  });

  it('lets the camera go when the user takes it midway, for the rest of the transition', () => {
    const s = atPrompt();
    const { scene, vault } = s;
    expect(scene.submit(vault.crawls.tour, 0, false)).toBe(true);
    let { t } = play(s, 0, (f) => f.camera !== null && f.levels.cluster > 0.2);
    scene.takeCamera();
    const { frames } = play(s, t, (f) => !f.moving);
    for (const f of frames) {
      expect(f.camera).toBeNull();
      expect(f.handoff).toBeNull();
    }
    t = frames.at(-1)!.t;
    expect(scene.frame(t, false).levels).toEqual(AT_CRAWL);
  });

  it('moves the frame under the claws on a resize, takes hold again when asked, and only moves it mid-crawl', () => {
    const { scene, replay, build, vault } = atPrompt();
    const field = scene.field!;
    const epoch = replay.view.history.epoch;
    const holds = holdsOf(replay);
    const before: Vec3 = [0, 0, 0];
    const after: Vec3 = [0, 0, 0];
    const h = replay.view.holds[0]!;
    field.point(h.key, h.u, before);
    // The box moved, its size kept: the claws keep their place along the rails as they move.
    expect(scene.layout(layoutOf(build, LAPTOP, 80))).toBe(true);
    expect(replay.view.history.epoch).toBe(epoch);
    expect(holdsOf(replay)).toEqual(holds);
    field.point(h.key, h.u, after);
    expect(
      Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]),
    ).toBeGreaterThan(0.3 * build.unit);
    expect(replay.view.field).toBe(field);
    // Asked to, it takes hold again; and on its own when the frame is a tenth narrower or more.
    expect(scene.layout(layoutOf(build, LAPTOP, 80), true)).toBe(true);
    expect(replay.view.history.epoch).toBe(epoch + 1);
    expect(replay.resting).toBe(true);
    expect(scene.layout(layoutOf(build, LAPTOP, 80, 540))).toBe(true);
    expect(replay.view.history.epoch).toBe(epoch + 1);
    expect(scene.layout(layoutOf(build, LAPTOP, 80, 440))).toBe(true);
    expect(replay.view.history.epoch).toBe(epoch + 2);
    for (const hold of replay.view.holds) expect(PERCH_RAIL_SET.has(hold!.key)).toBe(true);
    // Mid-crawl the frame moves, and nothing else.
    expect(scene.submit(vault.crawls.tour, 0, false)).toBe(true);
    const loaded = replay.view.history.epoch;
    const node: Vec3 = [0, 0, 0];
    expect(scene.layout(layoutOf(build, LAPTOP, -120), true)).toBe(true);
    expect(replay.view.history.epoch).toBe(loaded);
    expect(replay.resting).toBe(false);
    expect(field.node(PERCH_ID, node)).toBe(true);
    expect(node).toEqual(scene.shot!.perch.node);
    // Nothing to place it on: the last shot stays.
    const shot = scene.shot;
    expect(
      scene.layout({
        ...layoutOf(build, LAPTOP),
        rect: { left: 0, top: 0, width: 0, height: 0, radius: 0 },
      }),
    ).toBe(false);
    expect(scene.shot).toBe(shot);
  });

  it('takes the grips asked for on its way back once it has landed, along the new heading', () => {
    const s = atPrompt();
    const { scene, replay, vault, layout } = s;
    expect(scene.submit(vault.crawls.tour, 0, false)).toBe(true);
    let { t } = play(s, 0, (f) => !f.moving);
    expect(scene.back(t, false, layout.overview)).toBe(true);
    ({ t } = play(s, t, () => (replay.view.walk?.t ?? 0) > 0.3));
    // A knob turned on the way: it leans 40° back from the top edge, and asks for fresh grips.
    const old = scene.shot!.perch.heading;
    scene.knobs.tilt -= 40;
    expect(scene.layout(layout, true)).toBe(true);
    expect(replay.resting).toBe(false);
    const heading = scene.shot!.perch.heading;
    expect(
      Math.hypot(heading[0] - old[0], heading[1] - old[1], heading[2] - old[2]),
    ).toBeGreaterThan(0.5);
    play(s, t, (f) => f.interactive);
    expect(replay.resting).toBe(true);
    // Facing the frame's heading as it is now, not the one it was recalled with.
    const l = Math.hypot(...heading);
    replay.view.dir.forEach((v, i) => expect(v).toBeCloseTo(heading[i]! / l, 9));
    expect(replay.view.holds.some((h) => h !== null)).toBe(true);
    for (const h of replay.view.holds) if (h) expect(PERCH_RAIL_SET.has(h.key)).toBe(true);
  });

  it('lands the camera with the creature at any playback speed, on the clock the replay is advanced by', () => {
    for (const speed of [0.25, 1, 2.5]) {
      const s = atPrompt();
      const { scene, replay, vault } = s;
      // A host's frames, uneven and some past the 64 ms cap: each step the capped time at the
      // playback speed, the scene's clock that step added up and moved first, as the lab does.
      const raw = [16, 16, 120, 33, 16, 250, 16];
      let clock = 5;
      expect(scene.submit(vault.crawls.tour, clock, false)).toBe(true);
      const arrive = replay.view.walk!.duration;
      let crossed = false;
      let f = scene.frame(clock, false);
      for (let i = 0; f.moving && i < 10_000; i++) {
        const step = (Math.min(64, raw[i % raw.length]!) / 1000) * speed;
        clock += step;
        f = scene.frame(clock, false);
        replay.update(step);
        replay.drain();
        const t = clock - 5;
        // Rounding apart, the two clocks are one: the shot is the timeline's while it crosses, and handed over as it lands.
        if (Math.abs(t - arrive) < 1e-9) continue;
        const crossing = replay.view.hereId === PERCH_ID;
        expect(f.camera !== null).toBe(crossing);
        if (!crossing && f.moving) expect(f.handoff).not.toBeNull();
        crossed ||= !crossing;
      }
      expect(f.moving).toBe(false);
      expect(crossed).toBe(true);
    }
  });

  it('plans over the model it is handed after a rebuild, with nothing cut or laid out again', () => {
    const { scene, replay, vault, layout } = atPrompt();
    const shot = scene.shot;
    // The same vault built again: the same notes, as new objects.
    const rebuilt = sampleVault().model;
    scene.setModel(rebuilt);
    expect(scene.shot).toBe(shot);
    expect(scene.name).toBe('prompt');
    expect(scene.frame(0, false).interactive).toBe(true);
    const rest = vi.spyOn(replay, 'rest');
    expect(scene.layout(layout, true)).toBe(true);
    expect(rest.mock.calls.at(-1)![0]).toBe(rebuilt);
    const load = vi.spyOn(replay, 'load');
    expect(scene.submit(vault.crawls.walk, 0, false)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![1]).toBe(rebuilt);
    const first = rebuilt.nodes.find((n) => n.id === replay.view.nextId);
    expect(first).toBeDefined();
    // Without a space it is ignored: the next space brings its own model.
    scene.setSpace(null, null);
    scene.setModel(vault.model);
    expect(scene.field).toBeNull();
  });

  it('cuts a transition to where it was going when the space changes under it', () => {
    const s = atPrompt();
    const { scene, replay, vault } = s;
    expect(scene.submit(vault.crawls.tour, 0, false)).toBe(true);
    play(s, 0, (f) => f.levels.cluster > 0.3);
    const again = space();
    scene.setSpace(again.build, vault.model);
    expect(scene.name).toBe('crawl');
    const f = scene.frame(1, false);
    expect(f.moving).toBe(false);
    expect(f.levels).toEqual(AT_CRAWL);
    expect(f.camera).toBeNull();
    // The host lays it out and loads the crawl plainly over the new field.
    expect(scene.layout(layoutOf(again.build, LAPTOP))).toBe(true);
    replay.load(vault.crawls.tour, vault.model, { field: scene.field!, unit: again.build.unit });
    replay.update(1);
    // Going back when it changes: the prompt, then a reset on the new frame.
    expect(
      scene.back(2, false, f.camera ?? { tx: 0, ty: 0, tz: 0, yaw: 0.5, pitch: 0.3, dist: 300 }),
    ).toBe(true);
    scene.frame(2.2, false);
    scene.setSpace(again.build, vault.model);
    expect(scene.name).toBe('prompt');
    expect(scene.frame(2.3, false).levels).toEqual(AT_PROMPT);
    expect(scene.layout(layoutOf(again.build, LAPTOP))).toBe(true);
    expect(scene.reset()).toBe(true);
    expect(replay.resting).toBe(true);
    expect(scene.frame(2.4, false).interactive).toBe(true);
  });

  it('goes to the crawl and back twenty times and comes to rest on the frame each time', () => {
    const s = atPrompt();
    const { scene, replay, vault, layout } = s;
    const epoch = replay.view.history.epoch;
    const presets = ['walk', 'gap', 'ask', 'tour'] as const;
    let t = 0;
    for (let i = 0; i < 20; i++) {
      expect(scene.submit(vault.crawls[presets[i % 4]!], t, false)).toBe(true);
      ({ t } = play(s, t, (f) => !f.moving, 30));
      ({ t } = play(s, t, () => replay.view.clock > 6 || replay.view.mode === 'done', 30));
      expect(scene.back(t, false, layout.overview)).toBe(true);
      ({ t } = play(s, t, (f) => f.interactive, 30));
      // Its claws close on the frame within the second.
      ({ t } = play(s, t, () => replay.view.swings.length === 0 && replay.view.clock > 0, 30));
      ({ t } = play(s, t, () => replay.view.holds.every((h) => h !== null), 30));
      for (const h of replay.view.holds) expect(PERCH_RAIL_SET.has(h!.key)).toBe(true);
      expect(replay.view.swings).toHaveLength(0);
    }
    expect(replay.view.history.epoch).toBe(epoch + 20);
    expect(scene.frame(t, false).atRest).toBe(true);
  });

  it('is the crawl for good without a space, and has nothing to show', () => {
    const replay = new CrawlReplay(() => {});
    const scene = new PromptScene(replay, defaultPromptKnobs());
    const { build, vault } = space();
    const check = () => {
      expect(scene.name).toBe('crawl');
      expect(scene.available).toBe(false);
      expect(scene.field).toBeNull();
      expect(scene.shot).toBeNull();
      expect(scene.layout(layoutOf(build, LAPTOP))).toBe(false);
      expect(scene.reset()).toBe(false);
      expect(scene.submit(vault.crawls.walk, 0, false)).toBe(false);
      expect(scene.back(0, false, { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, dist: 1 })).toBe(false);
      const f = scene.frame(0, false);
      expect(f.scene).toBe('crawl');
      expect(f.levels).toEqual(AT_CRAWL);
      expect(f.camera).toBeNull();
      expect(f.gaze).toBeNull();
      expect(f.interactive).toBe(false);
    };
    check();
    scene.setSpace(build, vault.model);
    expect(scene.layout(layoutOf(build, LAPTOP))).toBe(true);
    expect(scene.reset()).toBe(true);
    scene.setSpace(null, null);
    check();
  });

  it('hands out a fresh copy of its knobs each time', () => {
    const a = defaultPromptKnobs();
    const b = defaultPromptKnobs();
    a.times.enter.camera.duration = 9;
    a.idle.bob = 1;
    expect(b.times.enter.camera.duration).not.toBe(9);
    expect(b.idle.bob).not.toBe(1);
  });
});
