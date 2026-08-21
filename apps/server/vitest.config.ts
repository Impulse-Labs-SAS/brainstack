import { defineConfig } from 'vitest/config';

// Each suite boots its own PGlite instance — a real Postgres compiled to WASM —
// which costs a couple of seconds and a chunk of memory. Running every file at
// once was enough to make suites fail intermittently on a loaded machine, and a
// test that fails one run in three is worse than a slow one.
//
// Four at a time keeps the wall clock reasonable and the results the same every
// run. Raise it if the suites ever stop carrying a database each.
export default defineConfig({
  test: {
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
