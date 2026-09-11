// Pure helpers for the Ecosystem section — grouping/formatting only, no
// fetching or rendering, so they're testable in Node like import-md.ts.

export interface FacetRow {
  key: string;
  value: string;
}

export interface FacetGroup {
  key: string;
  values: string[];
}

/** Groups flat facet rows by key, preserving first-seen order on both axes. */
export function groupFacetsByKey(rows: readonly FacetRow[]): FacetGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, string[]>();

  for (const row of rows) {
    if (!byKey.has(row.key)) {
      byKey.set(row.key, []);
      order.push(row.key);
    }
    byKey.get(row.key)!.push(row.value);
  }

  return order.map((key) => ({ key, values: byKey.get(key)! }));
}

export interface EcosystemLinkRow {
  sourcePath?: string;
  targetPath: string;
  alias: string | null;
}

/** Display label for a link row: the alias when present, else the path. */
export function linkLabel(row: EcosystemLinkRow, direction: 'in' | 'out'): string {
  if (row.alias) return row.alias;
  return direction === 'in' ? (row.sourcePath ?? row.targetPath) : row.targetPath;
}
