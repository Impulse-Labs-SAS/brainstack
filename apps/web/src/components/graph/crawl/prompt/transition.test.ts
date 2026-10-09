import { describe, expect, it } from 'vitest';

import { basis, boundsOf, interpolate, type Camera } from '@/lib/graph-camera';

import { largeVault } from '../space/large-vault';
import { volumeLayout } from '../space/volume/layout';
import { notesReach, overviewCamera } from '../stage/overview';
import { dot, sub } from '../vec';

import { DEFAULT_PERCH, perchShot } from './perch-geometry';
import {
  AT_CRAWL,
  AT_PROMPT,
  cameraBetween,
  defaultTimes,
  transition,
  transitionAt,
  transitionLength,
  type Levels,
} from './transition';

const CHANNELS: readonly (keyof Levels)[] = ['prompt', 'panel', 'cluster'];

describe('transition', () => {
  it('starts from the levels it is handed and ends at the scene’s', () => {
    const times = defaultTimes();
    for (const [to, from, end] of [
      ['crawl', AT_PROMPT, AT_CRAWL],
      ['prompt', AT_CRAWL, AT_PROMPT],
    ] as const) {
      const tr = transition(to, from, times, false);
      expect(transitionAt(tr, 0).levels).toEqual(from);
      expect(transitionAt(tr, 0).camera).toBe(0);
      const last = transitionAt(tr, transitionLength(tr));
      expect(last.levels).toEqual(end);
      expect(last.camera).toBe(1);
      expect(last.done).toBe(true);
    }
  });

  it('keeps each channel to its span, monotonic and within [0, 1]', () => {
    const times = defaultTimes();
    for (const to of ['crawl', 'prompt'] as const) {
      const from = to === 'crawl' ? AT_PROMPT : AT_CRAWL;
      const end = to === 'crawl' ? AT_CRAWL : AT_PROMPT;
      const tr = transition(to, from, times, false);
      const spans = to === 'crawl' ? times.enter : times.leave;
      const length = transitionLength(tr);
      let last = transitionAt(tr, 0);
      for (let i = 1; i <= 600; i++) {
        const t = (length * 1.1 * i) / 600;
        const now = transitionAt(tr, t);
        for (const c of CHANNELS) {
          const v = now.levels[c];
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
          // Toward its end, never back.
          expect((v - last.levels[c]) * (end[c] - from[c])).toBeGreaterThanOrEqual(-1e-12);
          const span = spans[c];
          if (t <= span.start) expect(v).toBe(from[c]);
          if (t >= span.start + span.duration) expect(v).toBe(end[c]);
        }
        expect(now.camera).toBeGreaterThanOrEqual(last.camera);
        last = now;
      }
    }
  });

  it('turns round midway from wherever the levels were, without a jump', () => {
    const times = defaultTimes();
    const going = transition('crawl', AT_PROMPT, times, false);
    const midway = transitionAt(going, 0.5).levels;
    expect(midway.prompt).toBeGreaterThan(0);
    expect(midway.prompt).toBeLessThan(1);
    expect(midway.panel).toBeGreaterThan(0);
    const back = transition('prompt', midway, times, false);
    expect(transitionAt(back, 0).levels).toEqual(midway);
    // A frame later, close by.
    const next = transitionAt(back, 1 / 60).levels;
    for (const c of CHANNELS) expect(Math.abs(next[c] - midway[c])).toBeLessThan(0.15);
    expect(transitionAt(back, transitionLength(back)).levels).toEqual(AT_PROMPT);
  });

  it('is done when its last span ends, the hand-off included, and at once under reduced motion', () => {
    const times = defaultTimes();
    const enter = transition('crawl', AT_PROMPT, times, false);
    const cameraEnd = times.enter.camera.start + times.enter.camera.duration;
    expect(transitionLength(enter)).toBeCloseTo(
      Math.max(
        cameraEnd + times.handoff,
        ...CHANNELS.map((c) => times.enter[c].start + times.enter[c].duration),
      ),
      12,
    );
    expect(transitionAt(enter, transitionLength(enter) - 1e-6).done).toBe(false);
    expect(transitionAt(enter, transitionLength(enter)).done).toBe(true);
    for (const to of ['crawl', 'prompt'] as const) {
      const still = transition(to, to === 'crawl' ? AT_PROMPT : AT_CRAWL, times, true, 3);
      expect(transitionLength(still)).toBe(0);
      const at = transitionAt(still, 0);
      expect(at.done).toBe(true);
      expect(at.cameraDone).toBe(true);
      expect(at.camera).toBe(1);
      expect(at.handoff).toBeNull();
      expect(at.levels).toEqual(to === 'crawl' ? AT_CRAWL : AT_PROMPT);
    }
  });

  it('ends the camera’s way as the crossing lands, and going back the input too', () => {
    const times = defaultTimes();
    for (const arrive of [1.3, 2.8, 4.35]) {
      const enter = transition('crawl', AT_PROMPT, times, false, arrive);
      expect(enter.times.camera.start + enter.times.camera.duration).toBeCloseTo(arrive, 12);
      expect(enter.times.prompt).toEqual(times.enter.prompt);
      expect(transitionAt(enter, arrive - 1e-6).cameraDone).toBe(false);
      expect(transitionAt(enter, arrive).cameraDone).toBe(true);
      const leave = transition('prompt', AT_CRAWL, times, false, arrive);
      expect(leave.times.camera.start + leave.times.camera.duration).toBeCloseTo(arrive, 12);
      expect(leave.times.prompt.start + leave.times.prompt.duration).toBeCloseTo(arrive, 12);
      expect(transitionAt(leave, arrive).levels.prompt).toBe(1);
      expect(transitionAt(leave, arrive - 0.05).levels.prompt).toBeLessThan(1);
    }
    // Without a crossing, the spans as they are.
    expect(transition('crawl', AT_PROMPT, times, false).times.camera).toEqual(times.enter.camera);
  });

  it('hands the camera over once its way is done, entering only', () => {
    const times = defaultTimes();
    const enter = transition('crawl', AT_PROMPT, times, false, 2.5);
    expect(transitionAt(enter, 2.4).handoff).toBeNull();
    let last = -1;
    for (let t = 2.5; t < 2.5 + times.handoff; t += 0.01) {
      const k = transitionAt(enter, t).handoff!;
      expect(k).toBeGreaterThanOrEqual(last);
      expect(k).toBeLessThanOrEqual(1);
      last = k;
    }
    expect(transitionAt(enter, 2.5).handoff).toBe(0);
    expect(transitionAt(enter, 2.5 + times.handoff).handoff).toBeNull();
    expect(transitionAt(enter, 2.5 + times.handoff).done).toBe(true);
    const leave = transition('prompt', AT_CRAWL, times, false, 2);
    for (let t = 0; t < 3; t += 0.05) expect(transitionAt(leave, t).handoff).toBeNull();
  });
});

describe('cameraBetween', () => {
  const a: Camera = { tx: 1, ty: 2, tz: 3, yaw: 3, pitch: 0.2, dist: 10 };
  const b: Camera = { tx: -40, ty: 7.3, tz: 11, yaw: -3, pitch: 0.4, dist: 90 };

  it('ends exactly on either camera, and turns yaw the short way round', () => {
    expect(cameraBetween(a, b, 0)).toEqual(a);
    expect(cameraBetween(a, b, 1)).toEqual(b);
    // From 3 to −3 is 0.28 the short way, through π, not 6 the long way through 0.
    const mid = cameraBetween(a, b, 0.5);
    expect(Math.abs(mid.yaw)).toBeGreaterThan(3);
    expect(mid.dist).toBeCloseTo(50, 12);
    expect(mid.tx).toBeCloseTo(-19.5, 12);
  });

  it('backs straight out along the overview’s axis without lunging, where graph-camera’s interpolate lunges', () => {
    // The large vault's perch shot and its overview: the target runs ~70 units deep into the cluster.
    const { model } = largeVault();
    const l = volumeLayout(model);
    const bounds = boundsOf([...l.positions.values()].map(([x, y, z]) => ({ x, y, z })))!;
    const vp = { width: 1280, height: 800 };
    const overview = overviewCamera(bounds, vp, 0.5, 0.3);
    const radius = notesReach(
      l.positions.values(),
      [overview.tx, overview.ty, overview.tz],
      l.unit,
    );
    const shot = perchShot({
      overview,
      vp,
      rect: { left: 360, top: 372, width: 560, height: 56, radius: 16 },
      unit: l.unit,
      radius,
      knobs: DEFAULT_PERCH,
    })!;
    expect(shot.pulled).toBeGreaterThan(0);
    const axis = basis(overview).forward;
    const start = basis(shot.cam).position;
    const along = (c: Camera) => dot(sub(basis(c).position, start), axis);
    let last = 0;
    let lunge = 0;
    for (let i = 1; i <= 200; i++) {
      const e = i / 200;
      const now = along(cameraBetween(shot.cam, overview, e));
      // Backing out is going against the axis: never forward.
      expect(now).toBeLessThanOrEqual(last + 1e-9);
      last = now;
      lunge = Math.max(lunge, along(interpolate(shot.cam, overview, e)));
    }
    expect(last).toBeCloseTo(-shot.pulled, 6);
    // The geometric distance leaves the camera chasing its target into the cluster first.
    expect(lunge / l.unit).toBeGreaterThan(1);
  });
});
