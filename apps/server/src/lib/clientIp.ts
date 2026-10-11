// Where a request came from, for rate limiting.
//
// Only a header the platform in front of us writes can be believed. The old
// limiters trusted `x-nf-client-connection-ip` everywhere — Netlify sets it,
// but on a self-hosted instance Caddy passes it through untouched, so a
// client could name a fresh "IP" per request — and the login limiter took
// the *first* `X-Forwarded-For` entry, which is the one the client wrote.
//
// So the source is configuration, never a guess:
//   netlify  the header Netlify's edge sets (the Netlify function says so)
//   proxy    the last X-Forwarded-For entry: the one our own proxy appended.
//            Caddy, as shipped in docker-compose.yml, replaces the header
//            with the peer address, so the last entry is the client.
//   direct   the socket peer; for a server nothing sits in front of.

import type { Context } from 'hono';

export type TrustedProxy = 'netlify' | 'proxy' | 'direct';

const MAX_LENGTH = 64;

export function clientIp(c: Context, trust: TrustedProxy): string {
  const ip =
    trust === 'netlify'
      ? c.req.header('x-nf-client-connection-ip')
      : trust === 'proxy'
        ? lastForwarded(c.req.header('x-forwarded-for'))
        : undefined;
  return (ip || socketAddress(c) || 'unknown').slice(0, MAX_LENGTH);
}

function lastForwarded(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1];
}

/** The peer address under @hono/node-server; absent on a Fetch runtime. */
function socketAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}
