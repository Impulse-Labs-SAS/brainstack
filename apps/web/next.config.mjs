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
 * Notes render raw HTML through rehype-sanitize, and that allowlist was the
 * only thing between a shared-folder writer and script running in a reader's
 * session. The policy is the second layer: no script from another origin, no
 * plugins, no <base> rewriting where relative URLs go, and never inside a
 * frame — so a page cannot be overlaid for clicks. Inline script stays
 * allowed because Next's App Router bootstraps with it; taking that away
 * needs a nonce per response, a larger change. Images and connections are
 * left open: notes embed images from anywhere, and the API may live on
 * another origin in development.
 *
 * HSTS is ignored by browsers over plain http, so a local `:80` install is
 * unaffected; over https it stops the next visit being downgraded.
 */
function securityHeaders(phase) {
  const scriptSrc = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"];
  // React's development build evaluates code for its error overlay.
  if (phase === PHASE_DEVELOPMENT_SERVER) scriptSrc.push("'unsafe-eval'");
  return [
    {
      key: 'Content-Security-Policy',
      value: [
        `script-src ${scriptSrc.join(' ')}`,
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}

/*
 * Pages named `page.dev.tsx` exist only under `next dev` — the Sentinel lab at
 * /dev/sentinel, say. In a build they are plain modules: typechecked and
 * linted, never routed, never shipped. Next calls a config function with the
 * phase it runs in; keying on that rather than on NODE_ENV matters, because a
 * shell can set NODE_ENV to anything and would put a dev tool on the internet.
 */
export default (phase) => ({
  ...nextConfig,
  headers: async () => [{ source: '/:path*', headers: securityHeaders(phase) }],
  pageExtensions: [
    'tsx',
    'ts',
    'jsx',
    'js',
    ...(phase === PHASE_DEVELOPMENT_SERVER ? ['dev.tsx'] : []),
  ],
});
