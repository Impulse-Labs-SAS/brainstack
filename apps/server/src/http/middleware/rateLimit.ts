// In-memory token-bucket rate limiter. One bucket per key, refilled at
// `perMinute` tokens per minute. Good enough for V1 single-node deploys;
// replace with Redis if we ever scale out.
//
// Keyed by principal where there is one, and by client IP where there is not —
// the OAuth endpoints (register, token, authorize) are anonymous by design, and
// keying only by principal would leave them with no limit at all.

import type { MiddlewareHandler } from 'hono';

import type { AuthBindings } from './auth.js';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitOptions {
  perMinute: number;
  /** Override clock for tests. */
  now?: () => number;
}

/** Best-effort client IP. Netlify sets the first; a proxy sets the second. */
function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  return (
    c.req.header('x-nf-client-connection-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  ).slice(0, 64);
}

export function buildRateLimitMiddleware(
  options: RateLimitOptions,
): MiddlewareHandler<AuthBindings> {
  const buckets = new Map<string, Bucket>();
  const capacity = options.perMinute;
  const refillRatePerMs = options.perMinute / 60_000;
  const now = (): number => (options.now ? options.now() : Date.now());

  return async (c, next) => {
    const principal = c.var.principal;
    const key = !principal
      ? `ip:${clientIp(c)}`
      : principal.kind === 'apiKey'
        ? `key:${principal.apiKey.id}`
        : `user:${principal.user.id}`;

    const t = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: t };
      buckets.set(key, bucket);
    } else {
      const elapsed = t - bucket.lastRefill;
      if (elapsed > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
        bucket.lastRefill = t;
      }
    }

    if (bucket.tokens < 1) {
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
    bucket.tokens -= 1;
    return next();
  };
}
