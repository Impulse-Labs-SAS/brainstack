import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  buildGraphModel,
  type GraphModel,
  type InputEdge,
  type InputNode,
} from '@/lib/graph-model';

import { findWalk } from '../crawl-plan';
import type { Hold } from '../replay-view';
import { sampleVault } from '../sample-vault';
import { polylineThreadField } from '../space/polyline-field';
import {
  graphThreadField,
  segmentLength,
  threadEnds,
  threadKey,
  typicalLink,
  type LegStretch,
  type ThreadField,
  type ThreadKey,
} from '../threads';
import type { Vec3 } from '../vec';

import { GRIP_SLOTS } from './anatomy';
import {
  DEFAULT_GRIP,
  planPerchGrips,
  planWalkGrips,
  swingDuration,
  type GripEvent,
  type PerchGrip,
} from './grips';

/** World units per creature unit in the hand-built vaults: one spine link is one unit. */
const UNIT = 10;

function build(
  notes: ReadonlyArray<[string, Vec3]>,
  links: ReadonlyArray<[string, string]>,
): GraphModel {
  const nodes: InputNode[] = notes.map(([name], i) => ({
    id: `me/${name}.md`,
    path: `${name}.md`,
    title: name,
    ownerId: 'me',
    project: { id: 'me|p', label: 'P' },
    createdAt: i,
    updatedAt: i,
  }));
  const edges: InputEdge[] = links.map(([a, b]) => ({
    source: `me/${a}.md`,
    target: `me/${b}.md`,
    weight: 1,
  }));
  const model = buildGraphModel({
    nodes,
    edges,
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: 'me',
    vaultNames: new Map(),
    cache: new Map(),
  });
  const at = new Map(notes.map(([name, p]) => [`me/${name}.md`, p]));
  for (const n of model.nodes) {
    const p = at.get(n.id)!;
    Object.assign(n, { x: p[0], y: p[1], z: p[2] });
  }
  return model;
}

const id = (name: string) => `me/${name}.md`;
const key = (a: string, b: string) => threadKey({ id: id(a) }, { id: id(b) });

/**
 * A spine of notes along +z — the walk — with a rail of threads a little
 * below it on either side, tied to the spine by rungs: threads to hold all
 * along the way. `rails` notes along the spine have them; beyond, the spine
 * runs on alone.
 */
function ladder(length = 12, rails = length) {
  const notes: Array<[string, Vec3]> = [];
  const links: Array<[string, string]> = [];
  for (let k = 0; k <= length; k++) {
    notes.push([`s${k}`, [0, 0, k * UNIT]]);
    if (k > 0) links.push([`s${k - 1}`, `s${k}`]);
    if (k > rails) continue;
    notes.push([`l${k}`, [-0.8 * UNIT, -0.1 * UNIT, k * UNIT]]);
    notes.push([`r${k}`, [0.8 * UNIT, -0.1 * UNIT, k * UNIT]]);
    links.push([`s${k}`, `l${k}`], [`s${k}`, `r${k}`]);
    if (k > 0) links.push([`l${k - 1}`, `l${k}`], [`r${k - 1}`, `r${k}`]);
  }
  const model = build(notes, links);
  const leg: LegStretch[] = [];
  for (let k = 0; k < length; k++) {
    leg.push({
      fromId: id(`s${k}`),
      toId: id(`s${k + 1}`),
      key: key(`s${k}`, `s${k + 1}`),
      length: UNIT,
    });
  }
  return { model, field: graphThreadField(model), leg, total: length * UNIT };
}

const none: readonly (Hold | null)[] = GRIP_SLOTS.map(() => null);

/** What each slot holds after every event up to and including `s`. */
function holdsAfter(events: readonly GripEvent[], s: number, held = none): (ThreadKey | null)[] {
  const out = held.map((h) => h?.key ?? null);
  for (const e of events) if (e.s <= s + 1e-9) out[e.slot] = e.key;
  return out;
}

/** The event positions of a leg, in order. */
const positions = (events: readonly GripEvent[]) => [...new Set(events.map((e) => e.s))];

const sideOf = (slot: number) => GRIP_SLOTS[slot]!.side;

describe('planWalkGrips', () => {
  it('grips threads within reach, the sides taking turns', () => {
    const { field, leg, total } = ladder();
    const events = planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held: none });
    const grips = events.filter((e) => e.key !== null);
    expect(grips.length).toBeGreaterThan(10);
    const spacing = (DEFAULT_GRIP.holdSpan * UNIT) / GRIP_SLOTS.length;
    const step = total / Math.round(total / spacing);
    const turn = (e: GripEvent) => Math.round(e.s / step - 0.5) % 2;
    const sideOnTurn = new Map<number, number>();
    for (const e of grips) {
      const seen = sideOnTurn.get(turn(e)) ?? sideOf(e.slot);
      expect(sideOf(e.slot)).toBe(seen);
      sideOnTurn.set(turn(e), seen);
    }
    expect(new Set(sideOnTurn.values())).toEqual(new Set([-1, 1]));
    // Every grip is on a thread that is there, near the walk.
    for (const e of grips) {
      const p: Vec3 = [0, 0, 0];
      expect(field.point(e.key!, e.u, p)).toBe(true);
      expect(Math.abs(p[2] - e.s)).toBeLessThan(2 * UNIT);
      expect(e.u).toBeGreaterThanOrEqual(DEFAULT_GRIP.uMin - 1e-9);
      expect(e.u).toBeLessThanOrEqual(DEFAULT_GRIP.uMax + 1e-9);
    }
  });

  it('keeps two threads held on each side while walking when there are threads to hold', () => {
    const { field, leg, total } = ladder();
    const events = planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held: none });
    // From empty, each side needs two of its turns to take two grips.
    for (const s of positions(events).slice(4)) {
      const held = holdsAfter(events, s);
      for (const side of [-1, 1]) {
        const count = held.filter((k, g) => k !== null && sideOf(g) === side).length;
        expect(count).toBeGreaterThanOrEqual(DEFAULT_GRIP.minPerSide);
      }
    }
  });

  it('lets go of threads left behind', () => {
    const { field, leg, total } = ladder(12, 2);
    const events = planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held: none });
    const spine = (k: ThreadKey) => threadEnds(k).every((end) => /\/s\d+\.md$/.test(end));
    const onRails = (k: ThreadKey | null) => k !== null && !spine(k);
    expect(events.some((e) => onRails(e.key))).toBe(true);
    expect(holdsAfter(events, total).filter(onRails)).toEqual([]);
    // A grip that lets go with nothing to take instead had been left behind:
    // the walk (along z, from 0) was past it.
    const holding: Array<{ key: ThreadKey; u: number } | null> = GRIP_SLOTS.map(() => null);
    let released = 0;
    for (const e of events) {
      const was = holding[e.slot];
      if (e.key === null && was && onRails(was.key)) {
        const p: Vec3 = [0, 0, 0];
        field.point(was.key, was.u, p);
        expect(e.s).toBeGreaterThan(p[2]);
        released++;
      }
      holding[e.slot] = e.key === null ? null : { key: e.key, u: e.u };
    }
    expect(released).toBeGreaterThan(0);
  });

  it('never grips the thread it walks along, and lets go of it when it gets there', () => {
    const { field, leg, total } = ladder();
    const walking = key('s0', 's1');
    const held: (Hold | null)[] = [...none];
    held[1] = { key: walking, u: 0.5, since: 0 };
    held[4] = { key: walking, u: 0.6, since: 0 };
    const events = planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held });
    for (const e of events) {
      const k = Math.min(leg.length - 1, Math.floor(e.s / UNIT));
      expect(e.key).not.toBe(leg[k]!.key);
    }
    expect(holdsAfter(events, positions(events)[0]!, held)).not.toContain(walking);

    // The same along a walk through the sample vault, threads chosen by the graph.
    const { model } = sampleVault();
    const vaultField = graphThreadField(model);
    const unit = typicalLink(model);
    const from = model.nodes.find((n) => n.path === 'Main/Ingest pipeline.md')!;
    const to = model.nodes.find((n) => n.path === 'Main/Changelog.md')!;
    const path = findWalk(model, from, to)!;
    const vaultLeg: LegStretch[] = path.slice(1).map((n, i) => {
      const a = path[i]!;
      const edge = model.adjacency.get(a)!.find((nb) => nb.node === n)!.edge;
      return {
        fromId: a.id,
        toId: n.id,
        key: threadKey(a, n),
        length: segmentLength({ from: a, to: n, edge }, unit),
      };
    });
    const vaultTotal = vaultLeg.reduce((s, x) => s + x.length, 0);
    const vaultEvents = planWalkGrips({
      leg: vaultLeg,
      total: vaultTotal,
      field: vaultField,
      unit,
      lit: new Set(),
      held: none,
    });
    expect(vaultEvents.length).toBeGreaterThan(0);
    for (const e of vaultEvents) {
      let d = e.s;
      let k = 0;
      while (k < vaultLeg.length - 1 && d > vaultLeg[k]!.length) d -= vaultLeg[k++]!.length;
      expect(e.key).not.toBe(vaultLeg[k]!.key);
    }
  });

  it('plans the same grips for the same walk', () => {
    const { model } = sampleVault();
    const field = graphThreadField(model);
    const unit = typicalLink(model);
    const from = model.nodes.find((n) => n.path === 'Main/Ingest pipeline.md')!;
    const to = model.nodes.find((n) => n.path === 'Main/Changelog.md')!;
    const path = findWalk(model, from, to)!;
    const leg: LegStretch[] = path.slice(1).map((n, i) => ({
      fromId: path[i]!.id,
      toId: n.id,
      key: threadKey(path[i]!, n),
      length: unit * 1.6,
    }));
    const plan = () =>
      planWalkGrips({
        leg,
        total: unit * 1.6 * leg.length,
        field,
        unit,
        lit: new Set(),
        held: none,
      });
    expect(plan()).toEqual(plan());
  });
});

/**
 * A field of pipes: notes by name, and lines from one note to another through
 * the corners given, whichever way round the key names them.
 */
function pipes(
  notes: ReadonlyArray<[string, Vec3]>,
  lines: ReadonlyArray<[string, string, Vec3[]]>,
) {
  const nodes = new Map(notes.map(([name, p]) => [id(name), p]));
  const routes = new Map<ThreadKey, Float32Array>();
  const adjacency = new Map<string, ThreadKey[]>();
  for (const [a, b, corners] of lines) {
    const k = key(a, b);
    const points = [nodes.get(id(a))!, ...corners, nodes.get(id(b))!];
    if (threadEnds(k)[0] !== id(a)) points.reverse();
    routes.set(k, Float32Array.from(points.flat()));
    for (const end of [id(a), id(b)]) adjacency.set(end, [...(adjacency.get(end) ?? []), k]);
  }
  return polylineThreadField({ nodes, routes, adjacency, cell: UNIT });
}

/** A walk along the spine `s0` → `s{n}` of a field, each stretch as long as the field draws it. */
function spineLeg(field: ReturnType<typeof pipes>, n: number) {
  const leg: LegStretch[] = [];
  for (let k = 0; k < n; k++) {
    const thread = key(`s${k}`, `s${k + 1}`);
    leg.push({
      fromId: id(`s${k}`),
      toId: id(`s${k + 1}`),
      key: thread,
      length: field.length(thread),
    });
  }
  return { leg, total: leg.reduce((s, x) => s + x.length, 0) };
}

/**
 * The ladder as a space draws it, in pipes with elbows: the spine jogs from
 * side to side, each stretch of it an L — along z, then across — and the
 * rails and rungs that run beside it are Ls too.
 */
function pipeLadder(length = 12) {
  const notes: Array<[string, Vec3]> = [];
  const lines: Array<[string, string, Vec3[]]> = [];
  const jog = (k: number) => (k % 2 === 0 ? 0 : 0.3 * UNIT);
  const low = -0.1 * UNIT;
  const side = 0.8 * UNIT;
  for (let k = 0; k <= length; k++) {
    const x = jog(k);
    const z = k * UNIT;
    notes.push([`s${k}`, [x, 0, z]], [`l${k}`, [x - side, low, z]], [`r${k}`, [x + side, low, z]]);
    // Rungs: down, then out to the rail.
    lines.push([`s${k}`, `l${k}`, [[x, low, z]]], [`s${k}`, `r${k}`, [[x, low, z]]]);
    if (k === 0) continue;
    const px = jog(k - 1);
    lines.push(
      [`s${k - 1}`, `s${k}`, [[px, 0, z]]],
      [`l${k - 1}`, `l${k}`, [[px - side, low, z]]],
      [`r${k - 1}`, `r${k}`, [[px + side, low, z]]],
    );
  }
  const field = pipes(notes, lines);
  return { field, ...spineLeg(field, length) };
}

/** Which stretch of a leg `s` falls on. */
function stretchOf(leg: readonly LegStretch[], s: number): LegStretch {
  let d = s;
  let k = 0;
  while (k < leg.length - 1 && d > leg[k]!.length) d -= leg[k++]!.length;
  return leg[k]!;
}

describe('planWalkGrips over pipes', () => {
  it('grips pipes with elbows within reach, the sides taking turns, never the one it walks', () => {
    const { field, leg, total } = pipeLadder();
    const events = planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held: none });
    const grips = events.filter((e) => e.key !== null);
    expect(grips.length).toBeGreaterThan(10);
    // Each event position is one side's turn, and the sides alternate.
    const step = total / Math.round(total / ((DEFAULT_GRIP.holdSpan * UNIT) / GRIP_SLOTS.length));
    const turn = (e: GripEvent) => Math.round(e.s / step - 0.5) % 2;
    const sideOnTurn = new Map<number, number>();
    for (const e of grips) {
      expect(sideOf(e.slot)).toBe(sideOnTurn.get(turn(e)) ?? sideOf(e.slot));
      sideOnTurn.set(turn(e), sideOf(e.slot));
    }
    expect(new Set(sideOnTurn.values())).toEqual(new Set([-1, 1]));
    for (const e of grips) {
      expect(e.key).not.toBe(stretchOf(leg, e.s).key);
      const p: Vec3 = [0, 0, 0];
      expect(field.point(e.key!, e.u, p)).toBe(true);
      expect(e.u).toBeGreaterThanOrEqual(DEFAULT_GRIP.uMin - 1e-9);
      expect(e.u).toBeLessThanOrEqual(DEFAULT_GRIP.uMax + 1e-9);
      // Near where the walk is: the leg runs along z, 1.3 units of it to each unit of z.
      expect(Math.abs(p[2] - (e.s / total) * leg.length * UNIT)).toBeLessThan(2 * UNIT);
    }

    // Holding the pipe it is about to walk, it lets go of it at once.
    const held: (Hold | null)[] = [...none];
    held[1] = { key: leg[0]!.key!, u: 0.3, since: 0 };
    held[4] = { key: leg[0]!.key!, u: 0.4, since: 0 };
    const first = planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held });
    expect(holdsAfter(first, positions(first)[0]!, held)).not.toContain(leg[0]!.key);
  });

  it('keeps two pipes held on each side while walking, taking hold again on its next turn after an elbow', () => {
    const { field, leg, total } = pipeLadder();
    const events = planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held: none });
    const count = Math.round(total / ((DEFAULT_GRIP.holdSpan * UNIT) / GRIP_SLOTS.length));
    const at = (i: number) => ((i + 0.5) * total) / count;
    const heldOn = (i: number, side: number) =>
      holdsAfter(events, at(i)).filter((k, g) => k !== null && sideOf(g) === side).length;
    let short = 0;
    // From empty, each side needs two of its turns to take two grips.
    for (let i = 4; i < count; i++) {
      for (const side of [-1, 1]) {
        const n = heldOn(i, side);
        expect(n).toBeGreaterThanOrEqual(1);
        if (n >= DEFAULT_GRIP.minPerSide) continue;
        // Round one of the walk's own elbows the body turns on the spot, and
        // what it held behind it is out of reach: the side's next turn — one
        // of the next two events — makes it up.
        short++;
        const next = [i + 1, i + 2].filter((j) => j < count);
        if (next.length === 2) {
          expect(Math.max(...next.map((j) => heldOn(j, side)))).toBeGreaterThanOrEqual(
            DEFAULT_GRIP.minPerSide,
          );
        }
      }
    }
    // Rare: two dozen elbows on this walk, and a side falls short at one or two.
    expect(short).toBeLessThanOrEqual(3);
  });

  it('takes hold of a pipe whose elbow comes near though its ends are far, linked to the walk or not', () => {
    // A straight walk along z, and on its left a pipe it is not linked to:
    // up from far below, along beside the walk, then on up far above. The
    // middle of its line lies on its chord, so the chord says it is far from
    // everywhere but the middle of the walk.
    const x = -0.75 * UNIT;
    const y = -0.3 * UNIT;
    const notes: Array<[string, Vec3]> = [
      ['za', [x, y - 6 * UNIT, UNIT]],
      ['zb', [x, y + 6 * UNIT, 5 * UNIT]],
    ];
    const lines: Array<[string, string, Vec3[]]> = [
      [
        'za',
        'zb',
        [
          [x, y, UNIT],
          [x, y, 5 * UNIT],
        ],
      ],
    ];
    for (let k = 0; k <= 6; k++) {
      notes.push([`s${k}`, [0, 0, k * UNIT]]);
      if (k > 0) lines.push([`s${k - 1}`, `s${k}`, []]);
    }
    const field = pipes(notes, lines);
    const { leg, total } = spineLeg(field, 6);
    const elbowed = key('za', 'zb');
    /** Where along z each grip on the elbowed pipe lands. */
    const gripsOnIt = (f: ThreadField) =>
      planWalkGrips({ leg, total, field: f, unit: UNIT, lit: new Set(), held: none })
        .filter((e) => e.key === elbowed)
        .map((e) => {
          const p: Vec3 = [0, 0, 0];
          field.point(elbowed, e.u, p);
          return p[2];
        });

    const near = gripsOnIt(field);
    expect(near.length).toBeGreaterThan(0);
    // Taken by its elbow, where the walk first comes alongside it.
    expect(Math.min(...near)).toBeLessThan(1.8 * UNIT);

    // The same pipes without `nearby`, every one of them a candidate: the
    // chord test lets the pipe be held only around its middle.
    const chordOnly: ThreadField = {
      has: (k) => field.has(k),
      point: (k, u, out) => field.point(k, u, out),
      closest: (k, q, uMin, uMax) => field.closest(k, q, uMin, uMax),
      node: (n, out) => field.node(n, out),
      around: () => [elbowed, ...leg.map((s) => s.key!)],
      up: (p, out) => field.up(p, out),
    };
    for (const z of gripsOnIt(chordOnly)) expect(z).toBeGreaterThan(1.8 * UNIT);
  });

  it('plans a forty-unit leg through pipes in well under two milliseconds', () => {
    const { field, leg, total } = pipeLadder(31);
    expect(total).toBeGreaterThan(40 * UNIT);
    const plan = () => planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held: none });
    // Warmed up, as it is a few legs into a crawl: about a millisecond then.
    // The fastest of a few runs is what planning costs; a busy test machine
    // slows the others, so it keeps timing until one run fits, up to two hundred.
    for (let i = 0; i < 60; i++) plan();
    let fastest = Infinity;
    for (let i = 0; i < 200 && fastest >= 2; i++) {
      const t0 = performance.now();
      plan();
      fastest = Math.min(fastest, performance.now() - t0);
    }
    expect(fastest).toBeLessThan(2);
  });

  it('plans the same grips for the same walk', () => {
    const { field, leg, total } = pipeLadder();
    const plan = () => planWalkGrips({ leg, total, field, unit: UNIT, lit: new Set(), held: none });
    expect(plan()).toEqual(plan());
  });
});

describe('planPerchGrips', () => {
  const perchOn = (field: ThreadField, held = none, params = {}) =>
    planPerchGrips({
      hereId: id('s6'),
      forward: [0, 0, 1],
      field,
      unit: UNIT,
      lit: new Set(),
      held,
      params,
    });

  it('takes hold around the note, every grip landing well within the shortest dwell', () => {
    const { field } = ladder();
    const grips = perchOn(field);
    expect(grips.length).toBeGreaterThanOrEqual(4);
    expect(new Set(grips.map((g) => sideOf(g.slot)))).toEqual(new Set([-1, 1]));
    grips.forEach((g, i) => {
      expect(g.t).toBeCloseTo(0.06 + 0.07 * i, 9);
      expect(g.t).toBeLessThan(0.9);
    });
  });

  it('does not let go of a good grip for a slightly better one', () => {
    const { field } = ladder();
    const held: (Hold | null)[] = [...none];
    for (const g of perchOn(field)) {
      // A hair off the best spot along the same thread.
      if (g.key) held[g.slot] = { key: g.key, u: g.u + 0.03, since: 0 };
    }
    expect(perchOn(field, held)).toEqual([]);
    expect(perchOn(field, held, { hysteresis: 0 }).length).toBeGreaterThan(0);
  });

  it('prefers threads it already lit', () => {
    // Two threads drawn on top of each other: everything about them is equal but the light.
    const model = build(
      [
        ['h', [0, 0, 0]],
        ['a1', [-0.9 * UNIT, -0.1 * UNIT, -3 * UNIT]],
        ['b1', [-0.9 * UNIT, -0.1 * UNIT, 1.8 * UNIT]],
        ['a2', [-0.9 * UNIT, -0.1 * UNIT, -3 * UNIT]],
        ['b2', [-0.9 * UNIT, -0.1 * UNIT, 1.8 * UNIT]],
      ],
      [
        ['h', 'a1'],
        ['a1', 'b1'],
        ['h', 'a2'],
        ['a2', 'b2'],
      ],
    );
    const field = graphThreadField(model);
    const twins = [key('a1', 'b1'), key('a2', 'b2')];
    for (const lit of twins) {
      const grips = planPerchGrips({
        hereId: id('h'),
        forward: [0, 0, 1],
        field,
        unit: UNIT,
        lit: new Set([lit]),
        held: none,
      });
      const onTwins = grips.filter((g) => g.key !== null && twins.includes(g.key));
      expect(onTwins.length).toBeGreaterThan(0);
      for (const g of onTwins) expect(g.key).toBe(lit);
    }
  });

  it('lets go of a thread the graph no longer draws', () => {
    const { model, field } = ladder();
    const held: (Hold | null)[] = [...none];
    held[0] = { key: key('l6', 'l7'), u: 0.3, since: 0 };
    const hidden = graphThreadField(model, (n) => (n.id === id('l7') ? 0 : 1));
    const grips = perchOn(hidden, held);
    const first = grips.find((g) => g.slot === 0);
    expect(first?.key ?? null).not.toBe(key('l6', 'l7'));
    expect(field.has(key('l6', 'l7'))).toBe(true);
  });

  it('lets a thread the graph no longer draws crowd no other grip', () => {
    const { model } = ladder();
    const hidden = graphThreadField(model, (n) => (n.id === id('l7') ? 0 : 1));
    const held: (Hold | null)[] = [...none];
    held[4] = { key: key('l6', 'l7'), u: 0.3, since: 0 };
    /** What each slot ends up holding, and where. */
    const settled = (grips: readonly PerchGrip[]) =>
      GRIP_SLOTS.map((_, g) => {
        const last = grips.filter((x) => x.slot === g).at(-1);
        return last ? { key: last.key, u: last.u } : null;
      });
    const stale = settled(perchOn(hidden, held));
    const fresh = settled(perchOn(hidden));
    expect(stale.filter((_, g) => g !== 4)).toEqual(fresh.filter((_, g) => g !== 4));
  });
});

describe('swingDuration', () => {
  it('swings faster the faster the body moves, within limits', () => {
    expect(swingDuration(10, 1)).toBe(DEFAULT_GRIP.swingMax);
    expect(swingDuration(10, 1000)).toBe(DEFAULT_GRIP.swingMin);
    expect(swingDuration(10, 60)).toBeCloseTo(8 / 60, 9);
  });
});
