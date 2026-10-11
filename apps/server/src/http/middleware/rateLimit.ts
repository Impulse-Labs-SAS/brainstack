// In-memory token-bucket rate limiter. One bucket per key, refilled at
// `perMinute` tokens per minute. Per process: on a serverless platform each
// instance keeps its own buckets, which bounds a single client without
// pretending to be a global quota.
//
// Keyed by the user behind the request where there is one — an API key, an
// OAuth token and a session all count against the same person, and two users
// of one MCP host do not share a budget — and by client IP where there is not.
// The IP comes from `clientIp`, which believes only the header the deployment
// says its own proxy writes.
//
// Buckets idle for a full refill period are forgotten: they would be full
// again anyway, and keeping them let a client that varied its key grow the
// map for the life of the process.

import type { MiddlewareHandler } from 'hono';

import { clientIp, type TrustedProxy } from '../../lib/clientIp.js';

import type { AuthBindings } from './auth.js';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitOptions {
  perMinute: number;
  trustedProxy: TrustedProxy;
  /** Ignore the principal and key by IP alone, for routes before authentication. */
  byIpOnly?: boolean;
  /** Override clock for tests. */
  now?: () => number;
}

const REFILL_WINDOW_MS = 60_000;
const SWEEP_EVERY = 1_000;

export function buildRateLimitMiddleware(
  options: RateLimitOptions,
): MiddlewareHandler<AuthBindings> {
  const buckets = new Map<string, Bucket>();
  const capacity = options.perMinute;
  const refillRatePerMs = options.perMinute / REFILL_WINDOW_MS;
  const now = (): number => (options.now ? options.now() : Date.now());
  let calls = 0;

  const sweep = (t: number): void => {
    for (const [key, bucket] of buckets) {
      if (t - bucket.lastRefill >= REFILL_WINDOW_MS) buckets.delete(key);
    }
  };

  return async (c, next) => {
    const principal = options.byIpOnly ? undefined : c.var.principal;
    const key = principal
      ? `user:${principal.user.id}`
      : `ip:${clientIp(c, options.trustedProxy)}`;

    const t = now();
    if (++calls % SWEEP_EVERY === 0) sweep(t);

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
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillRatePerMs / 1000);
      return c.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(retryAfter) });
    }
    bucket.tokens -= 1;
    return next();
  };
}
