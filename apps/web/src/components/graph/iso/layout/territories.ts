// Territories in line art: the vaults as stacked plates. A vault is a plate, its
// projects stand on it, their folders on those, and every note is a block of the
// same size in a grid on the plate it is filed on. Where a note stands is decided
// by where it is filed — vault, project, folder — and by nothing else.
//
// The decision worth keeping: a plate's grid grows in steps (`gridOf`) and the
// plates are packed by size alone, so writing one more note rarely moves anything.
// A map that reshuffles whenever a note is added is a map nobody learns.
//
// Pure — numbers in, numbers out — so it runs in a worker and is tested in Node.

/** A note as the layout reads it: plain data, so a worker receives it as a structured clone. */
export interface LayoutNote {
  id: string;
  path: string;
  /** The project's id. */
  project: string;
  projectLabel: string;
  vault: string;
  isIndex: boolean;
  createdAt: number;
}
export interface LayoutVault {
  id: string;
  label: string;
  shared: boolean;
}

export type PlateKind = 'vault' | 'project' | 'folder';
export interface IsoPlate {
  /** 'v:<vault>', 'p:<project id>', 'f:<project id>/<folder>[/<sub-folder>]'. */
  id: string;
  kind: PlateKind;
  /** The vault's label, the project's, or the folder's own name. */
  label: string;
  /** Index in `plates`; -1 for a vault. */
  parent: number;
  /** 1 a vault, 2 a project, 3 a folder, 4 a sub-folder. */
  depth: number;
  vault: string;
  shared: boolean;
  /** Footprint on the ground, world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  z0: number;
  z1: number;
  /** Notes on it and under it. */
  count: number;
  /** Where its own notes stand, one unit cell each; null when it has none. */
  grid: { x: number; y: number; cols: number; rows: number } | null;
}
export interface IsoLayout {
  /** Every parent before its children. */
  plates: IsoPlate[];
  /** Note ids, in layout order. */
  ids: string[];
  /** Three per note: the centre of its cell, x and y, and the z of the top of its plate. */
  cells: Float32Array;
  /** Per note: the index of the plate it stands on. */
  plateOf: Int32Array;
  /** Of the vault plates. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

/** How thick a plate is: each stands on its parent's top. */
const PLATE_H = 0.3;
/** Room inside a plate's edge, by its kind. */
const PADS: Record<PlateKind, number> = { vault: 1.6, project: 0.9, folder: 0.55 };
/** Room between what stands on a plate, by the plate's kind; between vaults, `world`. */
export const GAPS = { world: 5, vault: 2.4, project: 1.2, folder: 0.8 } as const;

/** Something packed: a plate's own grid, or a plate. `rx`, `ry` are its offset in the box it was packed in. */
interface Item {
  w: number;
  h: number;
  rx: number;
  ry: number;
}

interface Group extends Item {
  id: string;
  kind: PlateKind;
  label: string;
  depth: number;
  vault: string;
  shared: boolean;
  /** The notes filed on this plate itself. */
  notes: LayoutNote[];
  /** Child plates by project id or folder name, while grouping. */
  byKey: Map<string, Group>;
  /** Child plates in packing order, once measured. */
  children: Group[];
  grid: (Item & { cols: number; rows: number }) | null;
  count: number;
}

// Code units, not localeCompare: the same notes must give the same bytes in any
// environment, the worker's and the tests' alike.
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bySize = (a: Group, b: Group) =>
  b.h - a.h || b.w - a.w || order(a.label, b.label) || order(a.id, b.id);
const byAge = (a: LayoutNote, b: LayoutNote) => a.createdAt - b.createdAt || order(a.id, b.id);

/** Columns and rows: the first of k×k or (k+1)×k that holds n. One more note rarely changes it. */
function gridOf(n: number): [number, number] {
  for (let k = 1; ; k++) {
    if (k * k >= n) return [k, k];
    if (k * (k + 1) >= n) return [k + 1, k];
  }
}

function folderParts(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  return parts.filter(Boolean);
}

function makeGroup(
  id: string,
  kind: PlateKind,
  label: string,
  depth: number,
  vault: LayoutVault,
): Group {
  return {
    id,
    kind,
    label,
    depth,
    vault: vault.id,
    shared: vault.shared,
    notes: [],
    byKey: new Map(),
    children: [],
    grid: null,
    count: 0,
    w: 0,
    h: 0,
    rx: 0,
    ry: 0,
  };
}

function childOf(parent: Group, key: string, id: string, label: string, vault: LayoutVault) {
  let g = parent.byKey.get(key);
  if (!g) {
    g = makeGroup(id, 'folder', label, parent.depth + 1, vault);
    parent.byKey.set(key, g);
  }
  return g;
}

/**
 * Shelf-packs `items` in rows about as wide as the square they would fill, then
 * mirrors the rows in x: what comes first stands at the front corner (max x,
 * min y), the one nearest the viewer at the default azimuth. Sets every item's
 * offset in the box it returns, `pad` included.
 */
function arrange(items: readonly Item[], gap: number, pad: number): { w: number; h: number } {
  let area = 0;
  let widest = 0;
  for (const it of items) {
    area += (it.w + gap) * (it.h + gap);
    widest = Math.max(widest, it.w);
  }
  const width = Math.max(widest, Math.sqrt(area) * 1.1);
  const px: number[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  let used = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > width) {
      y += shelf + gap;
      x = 0;
      shelf = 0;
    }
    px.push(x);
    it.ry = y + pad;
    x += it.w + gap;
    shelf = Math.max(shelf, it.h);
    used = Math.max(used, px[px.length - 1]! + it.w);
  }
  // `used` is one of these sums exactly, so the item that set it lands on the edge, not a hair off it.
  items.forEach((it, i) => (it.rx = used - (px[i]! + it.w) + pad));
  return { w: used + 2 * pad, h: y + shelf + 2 * pad };
}

/** Sizes every plate from the bottom up: its own grid first, then its child plates, biggest first. */
function measure(g: Group): void {
  const items: Item[] = [];
  if (g.notes.length) {
    const [cols, rows] = gridOf(g.notes.length);
    g.grid = { cols, rows, w: cols, h: rows, rx: 0, ry: 0 };
    items.push(g.grid);
  }
  g.children = [...g.byKey.values()];
  g.count = g.notes.length;
  for (const k of g.children) {
    measure(k);
    g.count += k.count;
  }
  g.children.sort(bySize);
  items.push(...g.children);
  const box = arrange(items, GAPS[g.kind], PADS[g.kind]);
  g.w = box.w;
  g.h = box.h;
}

interface Out {
  plates: IsoPlate[];
  ids: string[];
  cells: Float32Array;
  plateOf: Int32Array;
}

/**
 * A plate's own notes in its grid. The index takes the front cell; the rest fill
 * it oldest first, from the back row forward. The front cell is the last one that
 * order reaches, and a grid holds every note, so it never has to be skipped.
 */
function standNotes(g: Group, plate: number, out: Out): void {
  const grid = out.plates[plate]!.grid!;
  const z = out.plates[plate]!.z1;
  const byDate = [...g.notes].sort(byAge);
  const index = byDate.find((n) => n.isIndex);
  const put = (n: LayoutNote, col: number, row: number) => {
    const i = out.ids.length;
    out.ids.push(n.id);
    out.cells[i * 3] = grid.x + col + 0.5;
    out.cells[i * 3 + 1] = grid.y + row + 0.5;
    out.cells[i * 3 + 2] = z;
    out.plateOf[i] = plate;
  };
  if (index) put(index, grid.cols - 1, 0);
  let k = 0;
  for (const n of byDate) {
    if (n === index) continue;
    put(n, k % grid.cols, grid.rows - 1 - Math.floor(k / grid.cols));
    k++;
  }
}

function place(g: Group, x: number, y: number, parent: number, out: Out): void {
  const plate = out.plates.length;
  const z0 = (g.depth - 1) * PLATE_H;
  out.plates.push({
    id: g.id,
    kind: g.kind,
    label: g.label,
    parent,
    depth: g.depth,
    vault: g.vault,
    shared: g.shared,
    x,
    y,
    w: g.w,
    h: g.h,
    z0,
    z1: z0 + PLATE_H,
    count: g.count,
    grid: g.grid && { x: x + g.grid.rx, y: y + g.grid.ry, cols: g.grid.cols, rows: g.grid.rows },
  });
  if (g.grid) standNotes(g, plate, out);
  for (const k of g.children) place(k, x + k.rx, y + k.ry, plate, out);
}

/** Groups the notes vault → project → two levels of folder, the plates holding them. */
function groupNotes(
  notes: readonly LayoutNote[],
  vaults: ReadonlyMap<string, LayoutVault>,
): Group[] {
  const roots = new Map<string, Group>();
  const members = new Map<Group, LayoutNote[]>();
  for (const n of notes) {
    const vault = vaults.get(n.vault)!;
    let v = roots.get(vault.id);
    if (!v) roots.set(vault.id, (v = makeGroup(`v:${vault.id}`, 'vault', vault.label, 1, vault)));
    let p = v.byKey.get(n.project);
    if (!p) {
      p = makeGroup(`p:${n.project}`, 'project', n.projectLabel, 2, vault);
      v.byKey.set(n.project, p);
      members.set(p, []);
    }
    members.get(p)!.push(n);
  }

  for (const [project, list] of members) {
    const vault = vaults.get(project.vault)!;
    // The project's root is the folder all its notes share, as `provincesOf` reads it:
    // that needs no knowledge of how the server chose the project.
    const parts = list.map((n) => folderParts(n.path));
    let root = parts[0]!.length;
    for (const p of parts) {
      let k = 0;
      while (k < root && k < p.length && p[k] === parts[0]![k]) k++;
      root = k;
    }
    list.forEach((n, i) => {
      const [first, second] = parts[i]!.slice(root);
      if (first === undefined) {
        project.notes.push(n);
        return;
      }
      const folderId = `f:${n.project}/${first}`;
      const folder = childOf(project, first, folderId, first, vault);
      // Anything deeper than a sub-folder stands on the sub-folder.
      if (second === undefined) folder.notes.push(n);
      else childOf(folder, second, `${folderId}/${second}`, second, vault).notes.push(n);
    });
  }
  return [...roots.values()];
}

/** Lays out the notes as plates. The same notes, in any order, give byte-identical output. */
export function layoutIso(notes: readonly LayoutNote[], vaults: readonly LayoutVault[]): IsoLayout {
  const known = new Map<string, LayoutVault>();
  for (const v of vaults) if (!known.has(v.id)) known.set(v.id, v);
  // Sorted once by id, so everything after it meets the notes in the same order.
  const sorted = notes.filter((n) => known.has(n.vault)).sort((a, b) => order(a.id, b.id));
  const unique = sorted.filter((n, i) => i === 0 || n.id !== sorted[i - 1]!.id);

  const world = groupNotes(unique, known);
  for (const v of world) measure(v);
  world.sort(bySize);
  arrange(world, GAPS.world, 0);

  const out: Out = {
    plates: [],
    ids: [],
    cells: new Float32Array(unique.length * 3),
    plateOf: new Int32Array(unique.length),
  };
  for (const v of world) place(v, v.rx, v.ry, -1, out);

  const bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const vaultPlates = out.plates.filter((p) => p.parent < 0);
  if (vaultPlates.length) {
    bounds.x0 = Math.min(...vaultPlates.map((p) => p.x));
    bounds.y0 = Math.min(...vaultPlates.map((p) => p.y));
    bounds.x1 = Math.max(...vaultPlates.map((p) => p.x + p.w));
    bounds.y1 = Math.max(...vaultPlates.map((p) => p.y + p.h));
  }
  return { ...out, bounds };
}

/**
 * A key for everything `layoutIso` reads, so the same notes are not laid out twice.
 * Exact rather than a hash: two inputs that share a key must share a layout. The
 * order counts, so the same notes in another order only cost one more layout.
 */
export function layoutKey(notes: readonly LayoutNote[], vaults: readonly LayoutVault[]): string {
  return JSON.stringify([
    vaults.map((v) => [v.id, v.label, v.shared]),
    notes.map((n) => [n.id, n.path, n.project, n.projectLabel, n.vault, n.isIndex, n.createdAt]),
  ]);
}
