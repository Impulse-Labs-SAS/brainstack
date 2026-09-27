// Territories: the vaults as a map. Where a note sits is decided by where it
// is filed — vault, project, folder — and by nothing else. Links never move a
// note on the map; they show as routes when you point at something.
//
//  - A project is a country, its area proportional to its notes. A vault's
//    countries are packed into a continent; yours sits in the middle and the
//    shared vaults lie across the sea.
//  - Inside a country the notes sit on a sunflower spiral, evenly spaced, so
//    the land they stand on is evenly shaped. The index (MOC) is the capital,
//    in the middle, and each subfolder takes a wedge.
//  - The land is each note's Voronoi cell cut by a disc: the coast follows the
//    notes, and two countries share a border exactly where they meet.
//
// Pure — positions and polygons, no canvas — so it is tested in Node.

import { packEnclose, packSiblings } from 'd3-hierarchy';

import { hash01, type GraphNode, type VaultSummary } from './graph-model';

/** World units between neighbouring notes on the map. */
export const MAP_SPACING = 16;
/** How far land reaches beyond a note: where the coast runs. */
export const COAST_REACH = 1.38 * MAP_SPACING;
/** Water between two continents. */
const SEA = 5.5 * MAP_SPACING;
const DISC_SIDES = 24;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface Country {
  /** The project's id. */
  id: string;
  label: string;
  vault: string;
  x: number;
  y: number;
  /** Radius of the disc the country was packed as. */
  r: number;
  count: number;
}
export interface Continent {
  vault: string;
  x: number;
  y: number;
  r: number;
  /** Where its coast is highest: its name goes just above. */
  top: number;
}
export interface TerritoryLayout {
  /** Where each note belongs on the map. Topics have no place here. */
  positions: Map<GraphNode, { x: number; y: number }>;
  /** The subfolder of its project a note is filed in; '' at the project's top. */
  province: Map<GraphNode, string>;
  countries: Country[];
  continents: Continent[];
}

function folderParts(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  return parts;
}

/**
 * The subfolder each note is filed in, relative to its project. A project's
 * top folder is what all its notes share, so this needs no knowledge of how
 * the server chose the project.
 */
export function provincesOf(notes: readonly GraphNode[]): Map<GraphNode, string> {
  const byProject = new Map<string, GraphNode[]>();
  for (const n of notes) {
    if (!n.project) continue;
    const list = byProject.get(n.project.id) ?? [];
    list.push(n);
    byProject.set(n.project.id, list);
  }
  const out = new Map<GraphNode, string>();
  for (const list of byProject.values()) {
    let root = folderParts(list[0]!.path);
    for (const n of list) {
      const parts = folderParts(n.path);
      let k = 0;
      while (k < root.length && k < parts.length && root[k] === parts[k]) k++;
      root = root.slice(0, k);
    }
    for (const n of list) out.set(n, folderParts(n.path)[root.length] ?? '');
  }
  return out;
}

export function layoutTerritories(nodes: readonly GraphNode[], vaults: readonly VaultSummary[]): TerritoryLayout {
  const notes = nodes.filter((n) => n.kind === 'note' && n.project);
  const province = provincesOf(notes);

  const projects = new Map<string, { id: string; label: string; vault: string; notes: GraphNode[] }>();
  for (const n of notes) {
    const p = projects.get(n.project!.id) ?? { id: n.project!.id, label: n.project!.label, vault: n.vault, notes: [] };
    p.notes.push(n);
    projects.set(p.id, p);
  }

  // Countries: a disc per project, packed into a continent per vault.
  const shapes = vaults
    .map((v) => {
      const discs = packSiblings(
        [...projects.values()]
          .filter((p) => p.vault === v.id)
          .map((p) => {
            const R = 0.62 * MAP_SPACING * Math.sqrt(p.notes.length);
            return { project: p, R, r: R + 0.5 * MAP_SPACING };
          })
          .sort((a, b) => b.r - a.r || a.project.id.localeCompare(b.project.id)),
      );
      if (!discs.length) return null;
      const e = packEnclose(discs);
      for (const d of discs) {
        d.x -= e.x;
        d.y -= e.y;
      }
      return { vault: v, discs, r: e.r, x: 0, y: 0 };
    })
    .filter((s): s is NonNullable<typeof s> => !!s);

  // Continents: yours first, so it lands in the middle, the rest by size.
  const order = [...shapes].sort(
    (a, b) => Number(b.vault.own) - Number(a.vault.own) || b.discs.length - a.discs.length || a.vault.label.localeCompare(b.vault.label),
  );
  const seas = packSiblings(order.map((s) => ({ s, r: s.r + SEA / 2 })));
  const ox = seas[0]?.x ?? 0;
  const oy = seas[0]?.y ?? 0;
  for (const c of seas) {
    c.s.x = c.x - ox;
    c.s.y = c.y - oy;
  }

  // Cities: a sunflower inside each country, a wedge per subfolder, the capital in the middle.
  const positions = new Map<GraphNode, { x: number; y: number }>();
  const countries: Country[] = [];
  for (const shape of order) {
    for (const d of shape.discs) {
      const cx = shape.x + d.x;
      const cy = shape.y + d.y;
      const list = d.project.notes;
      const capital = list
        .filter((n) => n.isIndex)
        .sort((a, b) => a.path.length - b.path.length || a.id.localeCompare(b.id))[0];
      const rest = list
        .filter((n) => n !== capital)
        .sort(
          (a, b) =>
            (province.get(a) || '￿').localeCompare(province.get(b) || '￿') || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        );
      const turn = hash01(d.project.id) * Math.PI * 2;
      const points = list.map((_, i) => {
        const rr = d.R * Math.sqrt((i + 0.5) / list.length);
        const a = i * GOLDEN_ANGLE + turn;
        return { x: Math.cos(a) * rr, y: Math.sin(a) * rr, angle: Math.atan2(Math.sin(a), Math.cos(a)) };
      });
      if (capital) {
        points.shift();
        positions.set(capital, { x: cx, y: cy });
      }
      points.sort((p, q) => p.angle - q.angle);
      rest.forEach((n, i) => {
        const p = points[i]!;
        const jitter = 0.15 * MAP_SPACING;
        const h = hash01(n.id);
        positions.set(n, { x: cx + p.x + (h - 0.5) * jitter, y: cy + p.y + (hash01(`${n.id}~`) - 0.5) * jitter });
      });
      countries.push({ id: d.project.id, label: d.project.label, vault: shape.vault.id, x: cx, y: cy, r: d.r, count: list.length });
    }
  }

  const tops = new Map<string, number>();
  for (const [n, p] of positions) tops.set(n.vault, Math.max(tops.get(n.vault) ?? -Infinity, p.y + COAST_REACH));
  const continents = order.map((s) => ({ vault: s.vault.id, x: s.x, y: s.y, r: s.r, top: tops.get(s.vault.id) ?? s.y + s.r }));
  return { positions, province, countries, continents };
}

// -- Land ---------------------------------------------------------------------------

export interface LandSite {
  x: number;
  y: number;
  vault: string;
  project: string;
  province: string;
}
export interface MapLand {
  sites: LandSite[];
  /** The land each site stands on: a convex polygon, flat [x0, y0, x1, y1, …]. Empty when degenerate. */
  cells: number[][];
  /** Line segments per vault, flat [x1, y1, x2, y2, …]. */
  coast: Map<string, number[]>;
  borders: Map<string, number[]>;
  provinces: Map<string, number[]>;
  /** Which of four shades a country takes, so no two neighbours look alike. */
  shade: Map<string, number>;
  reach: number;
  /** Sites by grid cell, `reach * 2` wide, so neighbours are found without scanning them all. */
  grid: Map<number, number[]>;
}

// A number rather than a "gx,gy" string: this is looked up for every side of every cell.
const cellKey = (gx: number, gy: number) => (gx + 32768) * 65536 + (gy + 32768);

/** The site nearest to (x, y) among those within reach of it, or -1. */
export function siteAt(land: MapLand, x: number, y: number): number {
  const cell = land.reach * 2;
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  let best = -1;
  let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const i of land.grid.get(cellKey(gx + dx, gy + dy)) ?? []) {
        const s = land.sites[i]!;
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best >= 0 && bestD <= land.reach * land.reach ? best : -1;
}

/** Keep the side of the line through (mx, my) facing away from (dx, dy). */
function clipHalfPlane(poly: number[], mx: number, my: number, dx: number, dy: number): number[] {
  const out: number[] = [];
  const count = poly.length / 2;
  for (let k = 0; k < count; k++) {
    const ax = poly[k * 2]!;
    const ay = poly[k * 2 + 1]!;
    const bx = poly[((k + 1) % count) * 2]!;
    const by = poly[((k + 1) % count) * 2 + 1]!;
    const da = (ax - mx) * dx + (ay - my) * dy;
    const db = (bx - mx) * dx + (by - my) * dy;
    if (da <= 0) out.push(ax, ay);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push(ax + t * (bx - ax), ay + t * (by - ay));
    }
  }
  return out;
}

export function buildLand(sites: LandSite[], reach = COAST_REACH): MapLand {
  const cell = reach * 2;
  const grid = new Map<number, number[]>();
  sites.forEach((s, i) => {
    const key = cellKey(Math.floor(s.x / cell), Math.floor(s.y / cell));
    const list = grid.get(key) ?? [];
    list.push(i);
    grid.set(key, list);
  });
  const land: MapLand = { sites, cells: [], coast: new Map(), borders: new Map(), provinces: new Map(), shade: new Map(), reach, grid };
  const segments = (map: Map<string, number[]>, vault: string) => {
    let list = map.get(vault);
    if (!list) map.set(vault, (list = []));
    return list;
  };
  const touching = new Map<string, Set<string>>();

  sites.forEach((s, i) => {
    // Only sites within twice the reach can cut into this site's disc.
    let poly: number[] = [];
    for (let k = 0; k < DISC_SIDES; k++) {
      const a = (k / DISC_SIDES) * Math.PI * 2;
      poly.push(s.x + Math.cos(a) * reach, s.y + Math.sin(a) * reach);
    }
    const gx = Math.floor(s.x / cell);
    const gy = Math.floor(s.y / cell);
    for (let dx = -1; dx <= 1 && poly.length; dx++) {
      for (let dy = -1; dy <= 1 && poly.length; dy++) {
        for (const j of grid.get(cellKey(gx + dx, gy + dy)) ?? []) {
          if (j === i) continue;
          const o = sites[j]!;
          const vx = o.x - s.x;
          const vy = o.y - s.y;
          if (vx === 0 && vy === 0) continue;
          if (vx * vx + vy * vy >= cell * cell) continue;
          poly = clipHalfPlane(poly, (s.x + o.x) / 2, (s.y + o.y) / 2, vx, vy);
          if (!poly.length) break;
        }
      }
    }
    land.cells[i] = poly.length >= 6 ? poly : [];
    if (poly.length < 6) return;

    // Each side of the cell is coast, a border, a folder line or nothing,
    // depending on what lies just across it.
    const count = poly.length / 2;
    for (let k = 0; k < count; k++) {
      const ax = poly[k * 2]!;
      const ay = poly[k * 2 + 1]!;
      const bx = poly[((k + 1) % count) * 2]!;
      const by = poly[((k + 1) % count) * 2 + 1]!;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      let nx = -(by - ay);
      let ny = bx - ax;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      if (nx * (mx - s.x) + ny * (my - s.y) < 0) {
        nx = -nx;
        ny = -ny;
      }
      const j = siteAt(land, mx + nx * 0.5, my + ny * 0.5);
      const o = j >= 0 ? sites[j]! : null;
      let target: number[];
      if (!o || j === i || o.vault !== s.vault) target = segments(land.coast, s.vault);
      else if (j < i) continue;
      else if (o.project !== s.project) {
        target = segments(land.borders, s.vault);
        if (!touching.has(s.project)) touching.set(s.project, new Set());
        if (!touching.has(o.project)) touching.set(o.project, new Set());
        touching.get(s.project)!.add(o.project);
        touching.get(o.project)!.add(s.project);
      } else if (o.province !== s.province) target = segments(land.provinces, s.vault);
      else continue;
      target.push(ax, ay, bx, by);
    }
  });

  // Biggest countries pick their shade first; a neighbour never repeats it.
  const sizes = new Map<string, number>();
  for (const s of sites) sizes.set(s.project, (sizes.get(s.project) ?? 0) + 1);
  for (const project of [...sizes.keys()].sort((a, b) => sizes.get(b)! - sizes.get(a)! || a.localeCompare(b))) {
    const used = new Set([...(touching.get(project) ?? [])].map((p) => land.shade.get(p)));
    let shade = 0;
    while (used.has(shade)) shade++;
    land.shade.set(project, shade % 4);
  }
  return land;
}
