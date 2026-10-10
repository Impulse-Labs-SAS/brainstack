import { describe, expect, it } from 'vitest';

import { basis, boundsOf, projector, type Bounds, type Viewport } from '@/lib/graph-camera';

import { CrawlReplay } from '../crawl-replay';
import type { ReplayView } from '../replay-view';
import { sampleVault, type SampleVault } from '../sample-vault';
import { BODY_SCALE, EYE } from '../sentinel/anatomy';
import { bodyGoal, createBody, createGoal } from '../sentinel/body';
import { LENS_POINT } from '../sentinel/geometry';
import { DEFAULT_MOTION, SentinelMotion } from '../sentinel/motion';
import { largeVault } from '../space/large-vault';
import { polylineThreadField } from '../space/polyline-field';
import { volumeLayout } from '../space/volume/layout';
import { notesReach, overviewCamera } from '../stage/overview';
import type { ThreadField } from '../threads';
import { cross, dist, dot, len, sub, type Vec3 } from '../vec';

import { UP_FAR, replayPerch, withPerch } from './perch-field';
import {
  CLAW_ROOM,
  DEFAULT_PERCH,
  GAP_MIN,
  perchShot,
  type PerchKnobs,
  type ScreenRect,
} from './perch-geometry';

const VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

/** The prompt's box as the page lays it out: min(560px, 80vw) wide, 56 px tall, centred, 16 px corners. */
function boxOn(vp: Viewport, dx = 0, dy = 0): ScreenRect {
  const width = Math.min(560, 0.8 * vp.width);
  return {
    left: (vp.width - width) / 2 + dx,
    top: (vp.height - 56) / 2 + dy,
    width,
    height: 56,
    radius: 16,
  };
}

/** A vault laid out as the dormant network lays it out: the cluster, its field and its bounds. */
function cluster(vault: SampleVault) {
  const layout = volumeLayout(vault.model);
  const field = polylineThreadField({
    nodes: layout.positions,
    routes: layout.routes,
    adjacency: layout.adjacency,
    cell: layout.unit,
  });
  const bounds = boundsOf([...layout.positions.values()].map(([x, y, z]) => ({ x, y, z })))!;
  return { vault, positions: layout.positions, field, unit: layout.unit, bounds };
}

const sample = cluster(sampleVault());
const large = cluster(largeVault());

/** The shot over a cluster, from the lab's angle, at the defaults or the knobs given. */
function shotOver(
  c: ReturnType<typeof cluster>,
  vp: Viewport,
  knobs: PerchKnobs = DEFAULT_PERCH,
  rect = boxOn(vp),
) {
  const overview = overviewCamera(c.bounds, vp, 0.5, 0.3);
  const radius = notesReach(c.positions.values(), [overview.tx, overview.ty, overview.tz], c.unit);
  return { overview, shot: perchShot({ overview, vp, rect, unit: c.unit, radius, knobs })! };
}

/** `o` plus each vector times its weight. */
function at(o: Vec3, ...terms: Array<[Vec3, number]>): Vec3 {
  const p: Vec3 = [o[0], o[1], o[2]];
  for (const [v, w] of terms) for (let i = 0; i < 3; i++) p[i]! += v[i]! * w;
  return p;
}

describe('perchShot', () => {
  it('puts the box exactly where the DOM box is, on any viewport', () => {
    for (const vp of VIEWPORTS) {
      for (const [dx, dy] of [
        [0, 0],
        [-40, 120],
      ] as const) {
        const rect = boxOn(vp, dx, dy);
        const { shot } = shotOver(sample, vp, DEFAULT_PERCH, rect);
        const { right, up } = basis(shot.cam);
        const project = projector(shot.cam, vp);
        const hw = rect.width / 2 / shot.pixels;
        const hh = rect.height / 2 / shot.pixels;
        for (const [sx, sy] of [
          [-1, 1],
          [1, 1],
          [1, -1],
          [-1, -1],
        ] as const) {
          const p = at(shot.box, [right, sx * hw], [up, sy * hh]);
          const s = project(p[0], p[1], p[2])!;
          expect(Math.abs(s.x - (rect.left + ((sx + 1) / 2) * rect.width))).toBeLessThan(1e-6);
          expect(Math.abs(s.y - (rect.top + ((1 - sy) / 2) * rect.height))).toBeLessThan(1e-6);
          // On the plane `depth` ahead of the shot.
          expect(s.depth).toBeCloseTo(shot.depth, 6);
        }
      }
    }
  });

  it('keeps the box `size` units tall on every viewport, so the creature is the same size against it', () => {
    const scales = VIEWPORTS.map((vp) => {
      const { shot } = shotOver(sample, vp);
      expect(56 / shot.pixels).toBeCloseTo(DEFAULT_PERCH.size * sample.unit, 9);
      // Pixels per creature unit at the box: the box's height over its size.
      expect(shot.pixels * sample.unit).toBeCloseTo(56 / DEFAULT_PERCH.size, 6);
      return shot.pixels;
    });
    for (const s of scales) expect(s).toBeCloseTo(scales[0]!, 9);
  });

  it("looks along the overview's axis from closer in, or from further out", () => {
    for (const vp of VIEWPORTS) {
      const { overview, shot } = shotOver(large, vp);
      expect(shot.cam.yaw).toBe(overview.yaw);
      expect(shot.cam.pitch).toBe(overview.pitch);
      const o = basis(overview);
      const p = basis(shot.cam);
      // Its viewer is where the shot's camera is, and both lie on the overview's axis with the box.
      expect(dist(p.position, shot.viewer)).toBeLessThan(1e-9 * large.unit * 1000);
      const toBox = sub(shot.box, o.position);
      expect(len(cross(toBox, o.forward))).toBeLessThan(1e-6 * len(toBox));
      expect(dot(toBox, o.forward)).toBeCloseTo(shot.along, 6);
      expect(dot(sub(shot.viewer, o.position), o.forward)).toBeCloseTo(shot.pulled, 6);
      expect(shot.along - shot.pulled).toBeCloseTo(shot.depth, 6);
    }
  });

  it('sets the perch a fixed gap before the notes: the crossing is as long on any viewport', () => {
    for (const c of [sample, large]) {
      const lengths = VIEWPORTS.map((vp) => {
        const { overview, shot } = shotOver(c, vp);
        // No note within UP_FAR of the node: the walk among them never feels the frame's up.
        for (const p of c.positions.values()) {
          expect(dist(p, shot.perch.node) / c.unit).toBeGreaterThan(UP_FAR);
        }
        const from = replayPerch(shot).at!;
        return dist(from, [overview.tx, overview.ty, overview.tz]);
      });
      for (const l of lengths) expect(l).toBeCloseTo(lengths[0]!, 6);
    }
  });

  it('lays the defaults out as they are: the gap at its floor, the margin above its own', () => {
    const vp = VIEWPORTS[1]!;
    const { shot } = shotOver(sample, vp);
    // A unit more gap puts the box's plane a unit nearer the camera: the default was used as it is.
    const further = shotOver(sample, vp, { ...DEFAULT_PERCH, gap: DEFAULT_PERCH.gap + 1 }).shot;
    expect(shot.along - further.along).toBeCloseTo(sample.unit, 9);
    // Below the floor, the floor.
    const under = shotOver(sample, vp, { ...DEFAULT_PERCH, gap: GAP_MIN - 1 }).shot;
    expect(under.along).toBe(shot.along);
    expect(DEFAULT_PERCH.gap).toBe(GAP_MIN);
    expect(DEFAULT_PERCH.margin).toBeGreaterThanOrEqual(DEFAULT_PERCH.band / 2 + CLAW_ROOM);
  });

  it('backs the camera out to the overview, or closes in on a cluster too small to back out from', () => {
    const vp = VIEWPORTS[1]!;
    const unit = 10;
    const shotOf = (half: number) => {
      const b: Bounds = { cx: 5, cy: -3, cz: 2, w: 2 * half, h: 2 * half, d: 2 * half };
      const overview = overviewCamera(b, vp, 0.5, 0.3);
      return perchShot({
        overview,
        vp,
        rect: boxOn(vp),
        unit,
        radius: half,
        knobs: DEFAULT_PERCH,
      })!;
    };
    expect(shotOf(10).pulled).toBeLessThan(0);
    expect(shotOf(1000).pulled).toBeGreaterThan(0);
    // Either way, the same gap before the notes.
    for (const half of [10, 1000]) {
      const shot = shotOf(half);
      const along = dot(sub(shot.perch.node, [5, -3, 2]), basis(shot.cam).forward);
      expect(-along - half).toBeGreaterThan(UP_FAR * unit);
    }
  });

  it('perches the body exactly where body.ts puts it over the perch node', () => {
    for (const tilt of [0, 20, 55, 90]) {
      const { shot } = shotOver(sample, VIEWPORTS[1]!, { ...DEFAULT_PERCH, tilt, bodyX: 0.3 });
      const { node, body, up, heading } = shot.perch;
      const field: ThreadField = {
        has: () => false,
        point: () => false,
        closest: () => null,
        node: (_id, out) => {
          out[0] = node[0];
          out[1] = node[1];
          out[2] = node[2];
          return true;
        },
        around: () => [],
        up: (_p, out) => {
          out[0] = up[0];
          out[1] = up[1];
          out[2] = up[2];
        },
      };
      const view = {
        mode: 'dwell',
        unit: sample.unit,
        hereId: 'perch',
        dir: heading,
        walk: null,
        field,
      } as unknown as ReplayView;
      const goal = createGoal();
      expect(bodyGoal(view, createBody(), DEFAULT_MOTION, goal)).toBe(true);
      expect(dist(goal.p, body)).toBeLessThan(1e-9 * sample.unit * 100);
      expect(dist(goal.heading, heading)).toBeLessThan(1e-9);
    }
  });

  it("turns up from the viewer's way to the screen's up as it leans, its right the screen's", () => {
    let last: Vec3 | null = null;
    for (let tilt = 0; tilt <= 90; tilt += 5) {
      const { shot } = shotOver(sample, VIEWPORTS[1]!, { ...DEFAULT_PERCH, tilt });
      const { right, up: screenUp, forward } = basis(shot.cam);
      const { up, heading } = shot.perch;
      expect(len(up)).toBeCloseTo(1, 12);
      expect(len(heading)).toBeCloseTo(1, 12);
      expect(dot(up, heading)).toBeCloseTo(0, 12);
      expect(dist(cross(up, heading), right)).toBeLessThan(1e-12);
      if (tilt === 0) expect(dist(up, forward)).toBeLessThan(1e-12);
      if (tilt === 90) expect(dist(up, screenUp)).toBeLessThan(1e-12);
      if (last) expect(dot(last, up)).toBeLessThan(1);
      last = up;
    }
  });

  it("never lets the bezel's band reach the box: the margin grows to make room for a claw", () => {
    for (const knobs of [
      { ...DEFAULT_PERCH, margin: 0.01, band: 0.3 },
      { ...DEFAULT_PERCH, margin: 0, band: 0.09 },
      DEFAULT_PERCH,
    ]) {
      const vp = VIEWPORTS[1]!;
      const { shot } = shotOver(sample, vp, knobs);
      const u = sample.unit;
      const inner = shot.bezel.height / 2 - shot.bezel.band / 2;
      expect(inner).toBeGreaterThanOrEqual(56 / 2 / shot.pixels + CLAW_ROOM * u - 1e-9);
      const innerX = shot.bezel.width / 2 - shot.bezel.band / 2;
      expect(innerX).toBeGreaterThanOrEqual(
        boxOn(vp).width / 2 / shot.pixels + CLAW_ROOM * u - 1e-9,
      );
    }
  });

  it('runs the rails along the rounded centreline, corner to corner, cut at the arcs’ middles', () => {
    for (const vp of VIEWPORTS) {
      const { shot } = shotOver(sample, vp);
      const { right, up, normal } = shot.bezel;
      const u = sample.unit;
      const rw = shot.bezel.width / 2;
      const rh = shot.bezel.height / 2;
      const rc = shot.bezel.radius;
      // Concentric with the box's 16 px corners, the margin further out.
      expect(rc).toBeCloseTo(16 / shot.pixels + DEFAULT_PERCH.margin * u, 9);
      const forward = (DEFAULT_PERCH.railForward * DEFAULT_PERCH.thickness * u) / 2;
      const centres: Vec3[] = [
        [-1, 1],
        [1, 1],
        [1, -1],
        [-1, -1],
      ].map(([sx, sy]) =>
        at(shot.box, [right, sx! * (rw - rc)], [up, sy! * (rh - rc)], [normal, forward]),
      );
      const mids = [135, 45, -45, -135].map((d) => (d * Math.PI) / 180);
      expect(shot.rails).toHaveLength(4);
      shot.rails.forEach((rail, i) => {
        const next = (i + 1) % 4;
        // Five points on each half arc, and the straight edge between them.
        expect(rail).toHaveLength(10);
        rail.forEach((p, k) => {
          expect(dot(sub(p, shot.box), normal)).toBeCloseTo(forward, 9);
          const c = k < 5 ? centres[i]! : centres[next]!;
          expect(dist(p, c)).toBeCloseTo(rc, 9);
        });
        // Each starts on its corner, at its arc's middle, and ends on the next one's.
        expect(dist(rail[0]!, shot.corners[i]!)).toBe(0);
        expect(dist(rail.at(-1)!, shot.rails[next]![0]!)).toBeLessThan(1e-9 * u);
        const a = mids[i]!;
        const mid = at(centres[i]!, [right, rc * Math.cos(a)], [up, rc * Math.sin(a)]);
        expect(dist(shot.corners[i]!, mid)).toBeLessThan(1e-9 * u);
      });
    }
  });

  it('says how far below the box the bar is drawn, as three projects it', () => {
    for (const vp of VIEWPORTS) {
      for (const dy of [0, 120, -120]) {
        const rect = boxOn(vp, 0, dy);
        const { shot } = shotOver(sample, vp, DEFAULT_PERCH, rect);
        const b = shot.bezel;
        const project = projector(shot.cam, vp);
        // The bar's outer bottom edge, at its nearer face and its further one: the lower on screen.
        const edge = at(shot.box, [b.up, -(b.height / 2 + b.band / 2)]);
        const lowest = Math.max(
          ...[1, -1].map((side) => {
            const p = at(edge, [b.normal, (side * b.thickness) / 2]);
            return project(p[0], p[1], p[2])!.y;
          }),
        );
        expect(Math.abs(shot.below - (lowest - (rect.top + rect.height)))).toBeLessThan(1e-6);
        // The margin and half the band, on the box's plane: one of the bar's
        // faces always lies lower, the more so the further the box sits off
        // the screen's middle.
        const u = sample.unit;
        const m = Math.max(DEFAULT_PERCH.margin, DEFAULT_PERCH.band / 2 + CLAW_ROOM);
        const planar = (m * u + (DEFAULT_PERCH.band * u) / 2) * shot.pixels;
        expect(shot.below).toBeGreaterThanOrEqual(planar - 1e-9);
        expect(shot.below / planar).toBeLessThan(dy === 0 ? 1.02 : 1.04);
      }
    }
  });

  it('moves the room below the box with the frame’s knobs, and not with the creature’s', () => {
    const vp = VIEWPORTS[1]!;
    const u = sample.unit;
    const base = shotOver(sample, vp).shot;
    const wider = shotOver(sample, vp, { ...DEFAULT_PERCH, margin: DEFAULT_PERCH.margin + 0.1 });
    expect((wider.shot.below - base.below) / (0.1 * u * base.pixels)).toBeCloseTo(1, 1);
    // A wider band reaches half its widening further out; the margin is still its own.
    const band = shotOver(sample, vp, { ...DEFAULT_PERCH, band: DEFAULT_PERCH.band + 0.04 });
    expect((band.shot.below - base.below) / (0.02 * u * base.pixels)).toBeCloseTo(1, 1);
    for (const knobs of [{ bodyY: 0.1 }, { tilt: 30 }, { bodyBehind: 0.6 }]) {
      expect(shotOver(sample, vp, { ...DEFAULT_PERCH, ...knobs }).shot.below).toBe(base.below);
    }
  });

  it('is null for a box or a viewport with no size', () => {
    const vp = VIEWPORTS[1]!;
    const overview = overviewCamera(sample.bounds, vp, 0.5, 0.3);
    const base = {
      overview,
      vp,
      rect: boxOn(vp),
      unit: sample.unit,
      radius: 100,
      knobs: DEFAULT_PERCH,
    };
    expect(perchShot(base)).not.toBeNull();
    expect(perchShot({ ...base, rect: { ...boxOn(vp), height: 0 } })).toBeNull();
    expect(perchShot({ ...base, rect: { ...boxOn(vp), width: 0 } })).toBeNull();
    expect(perchShot({ ...base, vp: { width: 0, height: 800 } })).toBeNull();
    expect(perchShot({ ...base, unit: 0 })).toBeNull();
    expect(perchShot({ ...base, radius: Number.NaN })).toBeNull();
  });
});

describe('the Sentinel on the frame at the defaults', () => {
  it('holds its lens clear above the bezel, and keeps every part in front of the box out of it', () => {
    for (const vp of [VIEWPORTS[0]!, VIEWPORTS[1]!, VIEWPORTS[3]!]) {
      const { shot } = shotOver(large, vp);
      const u = large.unit;
      const replay = new CrawlReplay(() => {});
      replay.rest(large.vault.model, {
        field: withPerch(large.field, shot),
        unit: u,
        perch: replayPerch(shot, { reach: 1 }),
      });
      expect(replay.resting).toBe(true);
      const m = new SentinelMotion();
      m.setTier(3);
      m.gaze = shot.viewer;
      m.snap(replay.view);
      const pose = m.pose;
      const project = projector(shot.cam, vp);
      const rect = boxOn(vp);

      // Where the view draws the lens: the hull's frame, body scale and all, at LENS_POINT.
      const h = pose.hull;
      const lens = [0, 1, 2].map(
        (i) =>
          pose.anchor[i]! +
          u *
            (h[i]! * LENS_POINT[0] +
              h[4 + i]! * LENS_POINT[1] +
              h[8 + i]! * LENS_POINT[2] +
              h[12 + i]!),
      ) as Vec3;
      const s = project(lens[0], lens[1], lens[2])!;
      const radius = EYE.radius * BODY_SCALE * u * s.scale;
      const barTop =
        rect.top + rect.height / 2 - (shot.bezel.height / 2 + shot.bezel.band / 2) * shot.pixels;
      expect(s.y + radius).toBeLessThan(barTop);

      // A tentacle in front of the box's plane is drawn over the box, under the
      // glass, which dims it into reading as behind: it may curl over the top
      // edge and down the face, but never into the box's lower third, where the
      // text's baseline runs.
      const forward = basis(shot.cam).forward;
      let ahead = 0;
      for (let j = 0; j < m.debug.jointCount; j++) {
        const q = [0, 1, 2].map((k) => pose.anchor[k]! + m.debug.joints[j * 3 + k]! * u) as Vec3;
        if (dot(sub(q, shot.box), forward) >= 0) continue;
        ahead++;
        const p = project(q[0], q[1], q[2])!;
        const low =
          p.x > rect.left &&
          p.x < rect.left + rect.width &&
          p.y > rect.top + (rect.height * 2) / 3 &&
          p.y < rect.top + rect.height;
        expect(low).toBe(false);
      }
      // The front claws do come over the edge toward the viewer.
      expect(ahead).toBeGreaterThan(0);
    }
  });
});
