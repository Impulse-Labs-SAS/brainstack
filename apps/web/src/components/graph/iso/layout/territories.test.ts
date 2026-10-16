import { describe, expect, it } from 'vitest';

import { isIndexNote } from '@/lib/graph-structure';

import {
  layoutIso,
  layoutKey,
  type IsoLayout,
  type IsoPlate,
  type LayoutNote,
  type LayoutVault,
} from './territories';

const PADS = { vault: 1.6, project: 0.9, folder: 0.55 } as const;
const EPS = 1e-9;

const VAULTS: LayoutVault[] = [
  { id: 'own', label: 'Your vault', shared: false },
  { id: 'eowyn', label: 'Rohan', shared: true },
];

function note(vault: string, path: string, createdAt = 1_000): LayoutNote {
  const project = path.split('/')[0]!;
  return {
    id: `${vault}/${path}`,
    path,
    project: `${vault}|${project}`,
    projectLabel: project,
    vault,
    isIndex: isIndexNote(path),
    createdAt,
  };
}

const many = (vault: string, folder: string, n: number, from = 2_000) =>
  Array.from({ length: n }, (_, i) => note(vault, `${folder}/note ${i}.md`, from + i));

// Your vault with three projects of different shapes, a shared one with one, and a
// note from a vault that is not on show.
const NOTES: LayoutNote[] = [
  note('own', 'Orbit/_Orbit.md', 500),
  note('own', 'Orbit/plan.md', 900),
  note('own', 'Orbit/brief.md', 800),
  ...many('own', 'Orbit/Ledger', 5),
  ...many('own', 'Orbit/Ledger/Q1', 3),
  note('own', 'Orbit/Ledger/Q1/deep/er/buried.md'),
  ...many('own', 'Orbit/Atlas', 4),
  ...many('own', 'Gondor/Minas', 6),
  ...many('own', 'Erebor', 12),
  note('eowyn', 'Rohan/_Rohan.md', 10),
  ...many('eowyn', 'Rohan/Edoras', 7),
  note('stranger', 'Shire/hidden.md'),
];

/** A seeded shuffle: the same order on every run. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const gridRect = (p: IsoPlate): Rect => ({
  x: p.grid!.x,
  y: p.grid!.y,
  w: p.grid!.cols,
  h: p.grid!.rows,
});
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
const within = (a: Rect, b: Rect, pad: number) =>
  a.x >= b.x + pad - EPS &&
  a.y >= b.y + pad - EPS &&
  a.x + a.w <= b.x + b.w - pad + EPS &&
  a.y + a.h <= b.y + b.h - pad + EPS;

/** Everything wrong with a layout's geometry, as a list: empty when it is sound. */
function problems(layout: IsoLayout): string[] {
  const out: string[] = [];
  const { plates } = layout;
  const siblings = new Map<number, { what: string; rect: Rect }[]>();
  const add = (parent: number, what: string, rect: Rect) => {
    const list = siblings.get(parent) ?? [];
    list.push({ what, rect });
    siblings.set(parent, list);
  };
  const own = plates.map(() => 0);
  layout.plateOf.forEach((p) => own[p]!++);

  plates.forEach((p, i) => {
    if (Math.abs(p.z0 - (p.depth - 1) * 0.3) > EPS || Math.abs(p.z1 - p.depth * 0.3) > EPS)
      out.push(`${p.id}: z ${p.z0}–${p.z1} at depth ${p.depth}`);
    const kids = plates.filter((q) => q.parent === i);
    if (p.count !== own[i]! + kids.reduce((s, q) => s + q.count, 0))
      out.push(`${p.id}: count ${p.count}`);
    if (p.parent < 0) {
      if (p.kind !== 'vault' || p.depth !== 1) out.push(`${p.id}: a root that is not a vault`);
    } else {
      const q = plates[p.parent]!;
      if (p.parent >= i) out.push(`${p.id}: before its parent`);
      if (p.depth !== q.depth + 1 || p.vault !== q.vault) out.push(`${p.id}: not under ${q.id}`);
      if (!within(p, q, PADS[q.kind])) out.push(`${p.id}: outside ${q.id} less its padding`);
    }
    add(p.parent, p.id, p);
    if (p.grid) {
      add(i, `${p.id} grid`, gridRect(p));
      if (!within(gridRect(p), p, PADS[p.kind])) out.push(`${p.id}: grid outside the plate`);
    }
  });
  for (const list of siblings.values()) {
    for (const [i, a] of list.entries()) {
      for (const b of list.slice(i + 1))
        if (overlaps(a.rect, b.rect)) out.push(`${a.what} overlaps ${b.what}`);
    }
  }

  const taken = new Set<string>();
  layout.ids.forEach((id, i) => {
    const plate = layout.plateOf[i]!;
    const p = plates[plate]!;
    if (!p.grid) {
      out.push(`${id}: on ${p.id}, which has no grid`);
      return;
    }
    const col = layout.cells[i * 3]! - p.grid.x - 0.5;
    const row = layout.cells[i * 3 + 1]! - p.grid.y - 0.5;
    const [c, r] = [Math.round(col), Math.round(row)];
    if (Math.abs(col - c) > 1e-3 || Math.abs(row - r) > 1e-3)
      out.push(`${id}: off the centre of a cell`);
    if (c < 0 || c >= p.grid.cols || r < 0 || r >= p.grid.rows) out.push(`${id}: outside its grid`);
    if (Math.abs(layout.cells[i * 3 + 2]! - p.z1) > 1e-6) out.push(`${id}: not on its plate's top`);
    const key = `${plate}:${c}:${r}`;
    if (taken.has(key)) out.push(`${id}: shares a cell`);
    taken.add(key);
  });
  if (new Set(layout.ids).size !== layout.ids.length) out.push('a note appears twice');
  return out;
}

const plateBy = (layout: IsoLayout, id: string) => {
  const p = layout.plates.find((q) => q.id === id);
  expect(p, id).toBeDefined();
  return p!;
};
const cellOf = (layout: IsoLayout, id: string) => {
  const i = layout.ids.indexOf(id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  return {
    x: layout.cells[i * 3]!,
    y: layout.cells[i * 3 + 1]!,
    plate: layout.plates[layout.plateOf[i]!]!.id,
  };
};

describe('layoutIso', () => {
  it('nests plates without overlap, each inside its parent, every note in a cell of its grid', () => {
    const layout = layoutIso(NOTES, VAULTS);
    expect(problems(layout)).toEqual([]);
    expect(layout.plates.map((p) => p.kind).filter((k) => k === 'vault')).toHaveLength(2);
    // The note from a vault that is not on show is left out, and nothing else.
    expect(layout.ids).toHaveLength(NOTES.length - 1);
    expect(layout.ids).not.toContain('stranger/Shire/hidden.md');
    expect(plateBy(layout, 'v:eowyn')).toMatchObject({ shared: true, label: 'Rohan', count: 8 });
    expect(plateBy(layout, 'p:eowyn|Rohan')).toMatchObject({ shared: true, vault: 'eowyn' });
  });

  it('stacks plates by depth and stands each note on its plate', () => {
    const layout = layoutIso(NOTES, VAULTS);
    const z = (id: string) => [plateBy(layout, id).z0, plateBy(layout, id).z1];
    expect(z('v:own')).toEqual([0, 0.3]);
    expect(z('p:own|Orbit')[0]).toBeCloseTo(0.3, 12);
    expect(z('f:own|Orbit/Ledger')[0]).toBeCloseTo(0.6, 12);
    expect(z('f:own|Orbit/Ledger/Q1')[1]).toBeCloseTo(1.2, 12);
    const i = layout.ids.indexOf('own/Orbit/Ledger/Q1/note 0.md');
    expect(layout.cells[i * 3 + 2]).toBeCloseTo(1.2, 6);
  });

  it('packs the vaults from the world origin, and bounds them', () => {
    const layout = layoutIso(NOTES, VAULTS);
    const vaults = layout.plates.filter((p) => p.kind === 'vault');
    expect(layout.bounds).toEqual({
      x0: 0,
      y0: 0,
      x1: Math.max(...vaults.map((p) => p.x + p.w)),
      y1: Math.max(...vaults.map((p) => p.y + p.h)),
    });
    expect(Math.min(...vaults.map((p) => p.x))).toBe(0);
    expect(Math.min(...vaults.map((p) => p.y))).toBe(0);
  });

  it('packs as the rules say, worked by hand', () => {
    // Orbit packs its own 2×2 grid, then Tall (3.2 × 5: a note over a sub-folder),
    // Ledger (4.1 × 3.1), Alpha and Beta (2.1 square) — tallest first, so Tall comes
    // before the wider Ledger — in rows 1.1·√82.09 ≈ 9.97 wide, 1.2 apart: the grid
    // and Tall, then Ledger and Alpha, then Beta. Mirrored, the grid takes the front
    // corner. The vaults pack the same way, 5 apart, the bigger one in front.
    const notes = [
      note('own', 'Orbit/_Orbit.md', 1),
      note('own', 'Orbit/brief.md', 2),
      note('own', 'Orbit/plan.md', 3),
      note('own', 'Orbit/Tall/top.md', 4),
      note('own', 'Orbit/Tall/Deep/bottom.md', 5),
      ...many('own', 'Orbit/Ledger', 6),
      note('own', 'Orbit/Alpha/one.md', 6),
      note('own', 'Orbit/Beta/one.md', 7),
      note('eowyn', 'Rohan/_Rohan.md', 8),
    ];
    const expected: Record<string, [number, number, number, number]> = {
      'v:own': [11, 0, 12.4, 17.6],
      'p:own|Orbit': [12.6, 1.6, 9.2, 14.4],
      'f:own|Orbit/Tall': [14.5, 2.5, 3.2, 5],
      'f:own|Orbit/Tall/Deep': [15.05, 4.85, 2.1, 2.1],
      'f:own|Orbit/Ledger': [16.8, 8.7, 4.1, 3.1],
      'f:own|Orbit/Alpha': [13.5, 8.7, 2.1, 2.1],
      'f:own|Orbit/Beta': [18.8, 13, 2.1, 2.1],
      'v:eowyn': [0, 0, 6, 6],
      'p:eowyn|Rohan': [1.6, 1.6, 2.8, 2.8],
    };
    const layout = layoutIso(notes, VAULTS);
    expect(problems(layout)).toEqual([]);
    // Depth first, in packing order.
    expect(layout.plates.map((p) => p.id)).toEqual(Object.keys(expected));
    for (const p of layout.plates) {
      expect([p.x, p.y, p.w, p.h]).toEqual(expected[p.id]!.map((v) => expect.closeTo(v, 9)));
    }
    const grid = (id: string) => {
      const g = plateBy(layout, id).grid!;
      return [g.x, g.y, g.cols, g.rows];
    };
    expect(grid('p:own|Orbit')).toEqual([expect.closeTo(18.9, 9), expect.closeTo(2.5, 9), 2, 2]);
    expect(grid('f:own|Orbit/Tall')).toEqual([
      expect.closeTo(16.15, 9),
      expect.closeTo(3.05, 9),
      1,
      1,
    ]);
    expect(grid('f:own|Orbit/Ledger')).toEqual([
      expect.closeTo(17.35, 9),
      expect.closeTo(9.25, 9),
      3,
      2,
    ]);
    expect(layout.bounds).toEqual({
      x0: 0,
      y0: 0,
      x1: expect.closeTo(23.4, 9),
      y1: expect.closeTo(17.6, 9),
    });
  });

  it('lays out a note listed twice once', () => {
    const notes = [...NOTES, { ...NOTES[1]! }];
    const layout = layoutIso(notes, VAULTS);
    expect(problems(layout)).toEqual([]);
    expect(layout.ids).toEqual(layoutIso(NOTES, VAULTS).ids);
  });

  it('gives byte-identical output for the same notes in any order', () => {
    const a = layoutIso(NOTES, VAULTS);
    for (const seed of [1, 2, 3]) {
      const b = layoutIso(shuffled(NOTES, seed), VAULTS);
      expect(JSON.stringify(b.plates)).toBe(JSON.stringify(a.plates));
      expect(b.ids).toEqual(a.ids);
      expect(new Uint8Array(b.cells.buffer)).toEqual(new Uint8Array(a.cells.buffer));
      expect(new Uint8Array(b.plateOf.buffer)).toEqual(new Uint8Array(a.plateOf.buffer));
      expect(b.bounds).toEqual(a.bounds);
    }
  });

  it("stands a project's index on the front cell of its own grid, at the project's front corner", () => {
    const layout = layoutIso(NOTES, VAULTS);
    for (const [project, index] of [
      ['p:own|Orbit', 'own/Orbit/_Orbit.md'],
      ['p:eowyn|Rohan', 'eowyn/Rohan/_Rohan.md'],
    ] as const) {
      const p = plateBy(layout, project);
      const g = p.grid!;
      // The front corner is max x, min y: nearest the viewer at the default azimuth.
      expect(g.x + g.cols).toBeCloseTo(p.x + p.w - PADS.project, 9);
      expect(g.y).toBeCloseTo(p.y + PADS.project, 9);
      const at = cellOf(layout, index);
      expect(at.plate).toBe(project);
      expect(at.x).toBeCloseTo(g.x + g.cols - 0.5, 4);
      expect(at.y).toBeCloseTo(g.y + 0.5, 4);
    }
    // The rest fill from the back row forward, oldest first.
    const g = plateBy(layout, 'p:own|Orbit').grid!;
    expect(g).toMatchObject({ cols: 2, rows: 2 });
    const brief = cellOf(layout, 'own/Orbit/brief.md');
    expect([brief.x, brief.y]).toEqual([
      expect.closeTo(g.x + 0.5, 4),
      expect.closeTo(g.y + g.rows - 0.5, 4),
    ]);
    const plan = cellOf(layout, 'own/Orbit/plan.md');
    expect([plan.x, plan.y]).toEqual([
      expect.closeTo(g.x + 1.5, 4),
      expect.closeTo(g.y + g.rows - 0.5, 4),
    ]);
  });

  it('gives the front cell to the oldest index when a plate has several', () => {
    const notes = [
      note('own', 'Atlas/_Alpha.md', 200),
      note('own', 'Atlas/_Zeta.md', 100),
      ...many('own', 'Atlas', 4),
    ];
    const layout = layoutIso(notes, VAULTS);
    expect(problems(layout)).toEqual([]);
    const g = plateBy(layout, 'p:own|Atlas').grid!;
    const front = cellOf(layout, 'own/Atlas/_Zeta.md');
    expect([front.x, front.y]).toEqual([
      expect.closeTo(g.x + g.cols - 0.5, 4),
      expect.closeTo(g.y + 0.5, 4),
    ]);
    expect(cellOf(layout, 'own/Atlas/_Alpha.md').y).not.toBeCloseTo(g.y + 0.5, 4);
  });

  it('files notes by folder below the root the project shares, two levels deep', () => {
    const layout = layoutIso(NOTES, VAULTS);
    const ids = layout.plates.map((p) => p.id);
    expect(ids.filter((id) => id.startsWith('f:own|Orbit/')).sort()).toEqual([
      'f:own|Orbit/Atlas',
      'f:own|Orbit/Ledger',
      'f:own|Orbit/Ledger/Q1',
    ]);
    expect(plateBy(layout, 'f:own|Orbit/Ledger')).toMatchObject({
      kind: 'folder',
      label: 'Ledger',
      depth: 3,
      count: 9,
    });
    expect(plateBy(layout, 'f:own|Orbit/Ledger/Q1')).toMatchObject({
      kind: 'folder',
      label: 'Q1',
      depth: 4,
      count: 4,
    });
    expect(layout.plates[plateBy(layout, 'f:own|Orbit/Ledger/Q1').parent]!.id).toBe(
      'f:own|Orbit/Ledger',
    );
    // Deeper than a sub-folder folds into it; the root's own notes stand on the project.
    expect(cellOf(layout, 'own/Orbit/Ledger/Q1/deep/er/buried.md').plate).toBe(
      'f:own|Orbit/Ledger/Q1',
    );
    expect(cellOf(layout, 'own/Orbit/plan.md').plate).toBe('p:own|Orbit');
    expect(cellOf(layout, 'own/Orbit/Atlas/note 0.md').plate).toBe('f:own|Orbit/Atlas');
    // Every note of Gondor is in Minas: that is the project's root, so there is no folder.
    expect(ids.filter((id) => id.startsWith('f:own|Gondor'))).toEqual([]);
    expect(plateBy(layout, 'p:own|Gondor')).toMatchObject({
      label: 'Gondor',
      count: 6,
      grid: { cols: 3, rows: 2 },
    });
    expect(plateBy(layout, 'p:own|Orbit').count).toBe(16);
  });

  it('grows a grid in steps', () => {
    const sizes = [1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13];
    const grids = sizes.map((n) => {
      const g = plateBy(layoutIso(many('own', 'Erebor', n), VAULTS), 'p:own|Erebor').grid!;
      return [g.cols, g.rows];
    });
    expect(grids).toEqual([
      [1, 1],
      [2, 1],
      [2, 2],
      [2, 2],
      [3, 2],
      [3, 2],
      [3, 3],
      [3, 3],
      [4, 3],
      [4, 3],
      [4, 4],
    ]);
  });

  it('moves no plate when a note joins a folder whose grid has room', () => {
    const footprint = (layout: IsoLayout) =>
      new Map(layout.plates.map((p) => [p.id, [p.x, p.y, p.w, p.h]]));
    const before = layoutIso(NOTES, VAULTS);
    // Ledger holds 5 notes in a 3×2 grid: a sixth fits.
    const after = layoutIso([...NOTES, note('own', 'Orbit/Ledger/late.md', 9_000)], VAULTS);
    expect(problems(after)).toEqual([]);
    expect(footprint(after)).toEqual(footprint(before));
    expect(plateBy(after, 'f:own|Orbit/Ledger').count).toBe(10);
    // A seventh does not, and the plate grows: the test above would have seen it.
    const full = layoutIso(
      [
        ...NOTES,
        note('own', 'Orbit/Ledger/late.md', 9_000),
        note('own', 'Orbit/Ledger/later.md', 9_001),
      ],
      VAULTS,
    );
    expect(plateBy(full, 'f:own|Orbit/Ledger').h).toBeGreaterThan(
      plateBy(before, 'f:own|Orbit/Ledger').h,
    );
  });

  it('lays out nothing from nothing', () => {
    const layout = layoutIso([], VAULTS);
    expect(layout.plates).toEqual([]);
    expect(layout.ids).toEqual([]);
    expect(layout.cells).toHaveLength(0);
    expect(layout.bounds).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });

  it('lays out 5,000 notes in 3 vaults and 30 projects quickly', () => {
    const notes = bigVault(5_000);
    const vaults: LayoutVault[] = [
      { id: 'own', label: 'Your vault', shared: false },
      { id: 'arwen', label: 'Rivendell', shared: true },
      { id: 'thorin', label: 'Erebor', shared: true },
    ];
    layoutIso(notes, vaults);
    const t0 = performance.now();
    const layout = layoutIso(notes, vaults);
    const ms = performance.now() - t0;
    console.log(
      `layoutIso: ${notes.length} notes, ${layout.plates.length} plates in ${ms.toFixed(1)} ms`,
    );
    expect(layout.ids).toHaveLength(5_000);
    expect(layout.plates.filter((p) => p.kind === 'project')).toHaveLength(30);
    // Three folders and two sub-folders in each project, the deepest folded into one.
    expect(layout.plates.filter((p) => p.depth === 3)).toHaveLength(90);
    expect(layout.plates.filter((p) => p.depth === 4)).toHaveLength(60);
    expect(problems(layout)).toEqual([]);
    // Expected well under 50 ms; the bound leaves room for a slow CI machine.
    expect(ms).toBeLessThan(500);
  });
});

/** `n` invented notes: 30 projects over 3 vaults, folders up to four levels deep. */
function bigVault(n: number): LayoutNote[] {
  const rng = shuffled(
    Array.from({ length: n }, (_, i) => i),
    7,
  );
  const vaultOf = (p: number) => (p < 16 ? 'own' : p < 25 ? 'arwen' : 'thorin');
  const folders = ['Docs', 'Docs/Specs', 'Docs/Specs/Old/Draft', 'Notes', 'Notes/Daily', 'Plans'];
  return rng.map((r, i) => {
    const p = (r * 7) % 30;
    const folder = i % 11 === 0 ? '' : `${folders[i % folders.length]}/`;
    const path =
      i % 97 === 0 ? `Project ${p}/_Index ${i}.md` : `Project ${p}/${folder}note ${i}.md`;
    return note(vaultOf(p), path, (r * 31) % 10_000);
  });
}

describe('layoutKey', () => {
  it('is the same for the same input and changes with anything the layout reads', () => {
    const key = layoutKey(NOTES, VAULTS);
    expect(layoutKey([...NOTES], [...VAULTS])).toBe(key);
    // A key that missed a field would hand back a stale layout when only that field changed.
    const notes: Partial<LayoutNote>[] = [
      { id: 'own/Orbit/other.md' },
      { path: 'Orbit/Atlas/plan.md' },
      { project: 'own|Atlas' },
      { projectLabel: 'Atlas' },
      { vault: 'eowyn' },
      { isIndex: !NOTES[1]!.isIndex },
      { createdAt: 1 },
    ];
    for (const change of notes) {
      const changed = NOTES.map((n, i) => (i === 1 ? { ...n, ...change } : n));
      expect(layoutKey(changed, VAULTS), JSON.stringify(change)).not.toBe(key);
    }
    const vaults: Partial<LayoutVault>[] = [
      { id: 'arwen' },
      { label: 'Rohan!' },
      { shared: false },
    ];
    for (const change of vaults) {
      const changed = VAULTS.map((v, i) => (i === 1 ? { ...v, ...change } : v));
      expect(layoutKey(NOTES, changed), JSON.stringify(change)).not.toBe(key);
    }
  });
});
