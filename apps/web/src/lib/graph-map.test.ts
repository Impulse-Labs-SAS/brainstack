import { describe, expect, it } from 'vitest';

import { buildLand, layoutTerritories, provincesOf, siteAt, type LandSite } from './graph-map';
import { DEFAULT_LAYERS, OWN_VAULT, buildGraphModel, type InputEdge, type InputNode } from './graph-model';

const VIEWER = 'me';

function note(owner: string, path: string, createdAt = 1_000): InputNode {
  const project = path.split('/')[0]!;
  return {
    id: `${owner}/${path}`,
    path,
    title: path.slice(path.lastIndexOf('/') + 1, -3),
    ownerId: owner,
    project: { id: `folder:${owner}|${project}`, label: project },
    createdAt,
    updatedAt: createdAt,
  };
}

// Two vaults: yours with three projects of different sizes, one shared with one.
const NODES: InputNode[] = [
  note(VIEWER, 'Kora/_Kora.md'),
  ...Array.from({ length: 14 }, (_, i) => note(VIEWER, `Kora/${i % 3 === 0 ? 'Decisiones/' : ''}nota ${i}.md`, 2_000 + i)),
  ...Array.from({ length: 6 }, (_, i) => note(VIEWER, `Lumen/idea ${i}.md`, 3_000 + i)),
  note(VIEWER, 'Inbox/suelta.md'),
  ...Array.from({ length: 5 }, (_, i) => note('ana', `Research/entrevista ${i}.md`, 4_000 + i)),
];

function model(edges: InputEdge[] = []) {
  return buildGraphModel({
    nodes: NODES,
    edges,
    affinity: null,
    layers: DEFAULT_LAYERS,
    viewerId: VIEWER,
    vaultNames: new Map([['ana', { label: 'Research', owner: 'Ana' }]]),
    cache: new Map(),
  });
}

describe('provincesOf', () => {
  it('files a note under the subfolder of its project, not the project itself', () => {
    const m = model();
    const provinces = provincesOf(m.nodes);
    const byPath = (p: string) => provinces.get(m.nodes.find((n) => n.path === p)!);
    expect(byPath('Kora/_Kora.md')).toBe('');
    expect(byPath('Kora/nota 1.md')).toBe('');
    expect(byPath('Kora/Decisiones/nota 0.md')).toBe('Decisiones');
    expect(byPath('Lumen/idea 2.md')).toBe('');
  });
});

describe('layoutTerritories', () => {
  it('puts every note inside its country, and the index at its centre', () => {
    const m = model();
    const t = layoutTerritories(m.nodes, m.vaults);
    for (const c of t.countries) {
      for (const n of m.nodes.filter((x) => x.project?.id === c.id)) {
        const p = t.positions.get(n)!;
        expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(c.r);
      }
    }
    const kora = t.countries.find((c) => c.label === 'Kora')!;
    const capital = t.positions.get(m.nodes.find((n) => n.path === 'Kora/_Kora.md')!)!;
    expect([capital.x, capital.y]).toEqual([kora.x, kora.y]);
  });

  it('never lets two countries or two continents overlap, and keeps yours in the middle', () => {
    const m = model();
    const t = layoutTerritories(m.nodes, m.vaults);
    for (const [i, a] of t.countries.entries()) {
      for (const b of t.countries.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 1e-6);
      }
    }
    const [own, shared] = [t.continents.find((c) => c.vault === OWN_VAULT)!, t.continents.find((c) => c.vault !== OWN_VAULT)!];
    expect([own.x, own.y]).toEqual([0, 0]);
    expect(Math.hypot(shared.x - own.x, shared.y - own.y)).toBeGreaterThan(own.r + shared.r);
  });

  it('places notes by where they are filed, whatever links them', () => {
    const unlinked = model();
    const a = layoutTerritories(unlinked.nodes, unlinked.vaults);
    const linked = model([{ source: 'me/Kora/nota 1.md', target: 'ana/Research/entrevista 0.md', weight: 1 }]);
    const b = layoutTerritories(linked.nodes, linked.vaults);
    for (const n of unlinked.nodes) {
      const twin = linked.nodes.find((x) => x.id === n.id)!;
      expect(b.positions.get(twin)).toEqual(a.positions.get(n));
    }
  });
});

describe('buildLand', () => {
  function sites(): LandSite[] {
    const m = model();
    const t = layoutTerritories(m.nodes, m.vaults);
    return m.nodes.map((n) => ({ ...t.positions.get(n)!, vault: n.vault, project: n.project!.id, province: t.province.get(n)! }));
  }

  it('gives every note the land around it', () => {
    const s = sites();
    const land = buildLand(s);
    s.forEach((site, i) => {
      const cell = land.cells[i]!;
      expect(cell.length).toBeGreaterThanOrEqual(6);
      // Inside a convex polygon: on the same side of every edge.
      const count = cell.length / 2;
      const signs = new Set<number>();
      for (let k = 0; k < count; k++) {
        const [ax, ay, bx, by] = [cell[k * 2]!, cell[k * 2 + 1]!, cell[((k + 1) % count) * 2]!, cell[((k + 1) % count) * 2 + 1]!];
        const cross = (bx - ax) * (site.y - ay) - (by - ay) * (site.x - ax);
        if (Math.abs(cross) > 1e-9) signs.add(Math.sign(cross));
      }
      expect(signs.size).toBe(1);
    });
  });

  it('draws borders only inside a vault, and gives neighbouring countries different shades', () => {
    const land = buildLand(sites());
    expect(land.borders.get(OWN_VAULT)?.length).toBeGreaterThan(0);
    expect(land.borders.get('ana')).toBeUndefined();
    expect(land.coast.get('ana')?.length).toBeGreaterThan(0);
    expect(land.provinces.get(OWN_VAULT)?.length).toBeGreaterThan(0);
    const kora = [...land.shade.keys()].find((id) => id.endsWith('|Kora'))!;
    const lumen = [...land.shade.keys()].find((id) => id.endsWith('|Lumen'))!;
    expect(land.shade.get(kora)).not.toBe(land.shade.get(lumen));
  });

  it('finds the country under a point, and nothing out at sea', () => {
    const s = sites();
    const land = buildLand(s);
    const i = s.findIndex((x) => x.project.endsWith('|Lumen'));
    expect(land.sites[siteAt(land, s[i]!.x + 1, s[i]!.y)]!.project).toBe(s[i]!.project);
    expect(siteAt(land, 1e5, 1e5)).toBe(-1);
  });
});
