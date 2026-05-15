/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The tRPC client points at the standalone apps/server. In production, run a
  // reverse proxy in front so cookies stay first-party.
  env: {
    NEXT_PUBLIC_SERVER_URL:
      process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3000',
  },
  experimental: {
    // No experimental flags yet; placeholder for future tweaks.
  },
};

export default nextConfig;
