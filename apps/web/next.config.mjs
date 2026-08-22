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
  experimental: {
    // No experimental flags yet; placeholder for future tweaks.
  },
};

export default nextConfig;
