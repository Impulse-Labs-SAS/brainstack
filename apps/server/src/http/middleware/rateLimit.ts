// In-memory token-bucket rate limiter keyed by principal (user id or api key
// id). One bucket per key, refilled at `perMinute` tokens per minute. Good
// enough for V1 single-node deploys; replace with Redis if we ever scale out.

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

export function buildRateLimitMiddleware(
  options: RateLimitOptions,
): MiddlewareHandler<AuthBindings> {
  const buckets = new Map<string, Bucket>();
  const capacity = options.perMinute;
  const refillRatePerMs = options.perMinute / 60_000;
  const now = (): number => (options.now ? options.now() : Date.now());

  return async (c, next) => {
    const principal = c.var.principal;
    if (!principal) {
      return next();
    }
    const key =
      principal.kind === 'apiKey'
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
