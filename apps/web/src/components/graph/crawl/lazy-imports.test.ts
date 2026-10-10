// A guard on what the graph page downloads up front. The Sentinel view — its
// panel, the plugin, and behind them the stage with the creature and the
// dormant network — must reach the page only through `next/dynamic` and a
// dynamic `import()`, so Brain, Network and Territories never pay for it. A
// static import anywhere on the way would pull it into the page's first
// chunk, and nothing else would say so: the page would still work, only
// heavier. So the static imports are followed from each entry, as the bundler
// would, and none may reach what is meant to be loaded later. Type-only
// imports are erased, and not followed.
//
// three itself is no measure here — the graph draws with it — but within
// crawl/ only the stage's own modules use it: the replay and the plugin walk
// with pure ones (the creature's anatomy and grip planner among them).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../..');

/** What the import statements of `source` load, comments and type-only imports left out. */
function staticImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  const found: string[] = [];
  const from = /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(from)) {
    if (m[1]) continue;
    const names = /^\{([\s\S]*)\}$/.exec(m[2]!.trim());
    // `import { type A, type B }`: every name a type, so the whole import is erased.
    const typesOnly =
      names &&
      names[1]!
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .every((n) => n.startsWith('type '));
    if (!typesOnly) found.push(m[3]!);
  }
  for (const m of code.matchAll(/(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g)) found.push(m[1]!);
  return found;
}

function resolveFile(from: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? join(SRC, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const file = base + ext;
    if (existsSync(file) && /\.tsx?$/.test(file)) return file;
  }
  return null;
}

interface Reached {
  /** Every file loaded, as a path under `src/`. */
  files: Set<string>;
  /** Those that import three themselves. */
  three: Set<string>;
}

/** Every file `entry` loads statically. */
function reach(entry: string): Reached {
  const files = new Set<string>();
  const three = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    const name = relative(SRC, file).split('\\').join('/');
    if (files.has(name)) continue;
    files.add(name);
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      const next = resolveFile(file, spec);
      if (next) todo.push(next);
      else if (spec === 'three' || spec.startsWith('three/')) three.add(name);
    }
  }
  return { files, three };
}

/** Loaded only when the view opens: the stage, and the dormant network it builds. */
const LATER = [
  'components/graph/crawl/stage/sentinel-stage.ts',
  'components/graph/crawl/space/dormant/',
];

/** What `reached` loads that should wait for the view: the stage's modules, and anything in crawl/ that draws with three. */
function laterIn(reached: Reached): string[] {
  return [
    ...[...reached.files].filter((f) => LATER.some((l) => f.startsWith(l))),
    ...[...reached.three].filter((f) => f.startsWith('components/graph/crawl/')),
  ].sort();
}

describe('what the graph page loads up front', () => {
  it('reads static imports, and leaves type-only and dynamic ones out', () => {
    const src = [
      "import { a } from './a';",
      "import type { B } from './b';",
      "import { type C, type D } from './c';",
      "import { type E, f } from './e';",
      "export { g } from './g';",
      "import './side-effect';",
      "const h = () => import('./h');",
      "// import { i } from './i';",
      "import {\n  j,\n  k,\n} from '@/j';",
    ].join('\n');
    expect(staticImports(src).sort()).toEqual(['./a', './e', './g', './side-effect', '@/j']);
  });

  it('takes nothing of the Sentinel into the graph view but the choice of view and the legend’s colours', () => {
    const reached = reach(join(SRC, 'components/graph/graph-view.tsx'));
    expect(reached.files.size).toBeGreaterThan(10);
    expect(laterIn(reached)).toEqual([]);
    // The panel, and the plugin behind it, come only through next/dynamic.
    expect([...reached.files].filter((f) => f.includes('/crawl/')).sort()).toEqual([
      'components/graph/crawl/crawl-colors.ts',
      'components/graph/crawl/view-choice.ts',
    ]);
  });

  it('keeps the stage out of the panel’s chunk too: the plugin imports it once the view is open', () => {
    for (const entry of ['crawl-panel.tsx', 'crawl-plugin.ts']) {
      const reached = reach(join(HERE, entry));
      expect(reached.files.has('components/graph/crawl/crawl-replay.ts'), entry).toBe(true);
      expect(laterIn(reached), entry).toEqual([]);
    }
    // And the stage does draw with three: were it not found, the check above would prove nothing.
    expect(laterIn(reach(join(HERE, 'stage/sentinel-stage.ts'))).length).toBeGreaterThan(3);
  });
});
