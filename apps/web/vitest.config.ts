import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Same options as the root config, plus the `@/` alias the app's modules
// import each other with, so components' pure-enough classes can be tested.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: false,
    environment: 'node',
    passWithNoTests: true,
  },
});
