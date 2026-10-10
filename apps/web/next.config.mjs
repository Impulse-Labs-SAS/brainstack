import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/*
 * Set by the Dockerfile, and nowhere else.
 *
 * A standalone build bundles the server and exactly the node_modules it traces,
 * which is what lets the web image ship without the monorepo. Netlify's Next
 * runtime does its own packaging and is left to it: turning this on for every
 * build would change what gets deployed there for no gain.
 */
const standalone = process.env.BRAINSTACK_STANDALONE === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
   * No `env` block, and no localhost default. Next inlines NEXT_PUBLIC_* into
   * the client bundle at build time, so a default here is forever: one build
   * shipped with `http://localhost:3000` baked in, and every deployed browser
   * dutifully sent its login requests to the developer's machine. When the
   * variable is unset, server-url.ts falls back to the page's own origin,
   * which is correct deployed and correct in dev.
   */
  ...(standalone && {
    output: 'standalone',
    // Dependencies are hoisted to the monorepo root; tracing from this
    // directory alone would leave them out of the bundle.
    outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../..'),
  }),
  experimental: {
    // No experimental flags yet; placeholder for future tweaks.
  },
};

/*
 * Pages named `page.dev.tsx` exist only under `next dev` — the Sentinel lab at
 * /dev/sentinel, say. In a build they are plain modules: typechecked and
 * linted, never routed, never shipped. Next calls a config function with the
 * phase it runs in; keying on that rather than on NODE_ENV matters, because a
 * shell can set NODE_ENV to anything and would put a dev tool on the internet.
 */
export default (phase) => ({
  ...nextConfig,
  pageExtensions: [
    'tsx',
    'ts',
    'jsx',
    'js',
    ...(phase === PHASE_DEVELOPMENT_SERVER ? ['dev.tsx'] : []),
  ],
});
