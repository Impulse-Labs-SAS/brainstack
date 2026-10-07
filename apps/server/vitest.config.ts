import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Each suite boots its own PGlite instance — a real Postgres compiled to WASM —
// which costs a couple of seconds and a chunk of memory. Running every file at
// once was enough to make suites fail intermittently on a loaded machine, and a
// test that fails one run in three is worse than a slow one.
//
// Four at a time keeps the wall clock reasonable and the results the same every
// run. Raise it if the suites ever stop carrying a database each.
const CORE = resolve(import.meta.dirname, '../../packages/core/src');

export default defineConfig({
  /*
   * The package points at dist/ so Netlify's bundler can read it. Tests read
   * the source: nobody should have to compile core to run a test against a
   * change they just made in it.
   */
  resolve: {
    alias: {
      '@brainstack/core/pg': resolve(CORE, 'pg/index.ts'),
      '@brainstack/core/sentinel': resolve(CORE, 'sentinel/index.ts'),
      '@brainstack/core': resolve(CORE, 'index.ts'),
    },
  },
  test: {
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
