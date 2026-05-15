// In-memory rate limiter for login attempts. Bucketed by (ip, email) so a
// brute-forcer on one account can't lock everyone, but an attacker rotating
// IPs against one account still slows down per-IP.
//
// V1 only — single Node process. When we move to multi-node, swap the
// backing store for Redis (the API stays the same).

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000, 16_000];

interface Bucket {
  attempts: number;
  resetAt: number;
}

export interface LoginRateLimiter {
  /** Throws AppError('RATE_LIMITED') if the bucket is over budget. */
  check(key: { ip: string; email: string }): void;
  /** Record a failed attempt. Returns the recommended backoff in ms. */
  recordFailure(key: { ip: string; email: string }): number;
  /** Wipe the bucket on successful login. */
  reset(key: { ip: string; email: string }): void;
  /** Test hook to skip wall-clock waiting. */
  _setNow?(fn: () => number): void;
}

export function createLoginRateLimiter(now: () => number = Date.now): LoginRateLimiter {
  const buckets = new Map<string, Bucket>();

  function bucketKey(k: { ip: string; email: string }): string {
    return `${k.ip}|${k.email.toLowerCase()}`;
  }

  function getBucket(k: { ip: string; email: string }): Bucket | undefined {
    const key = bucketKey(k);
    const b = buckets.get(key);
    if (!b) return undefined;
    if (b.resetAt < now()) {
      buckets.delete(key);
      return undefined;
    }
    return b;
  }

  return {
    check(k) {
      const b = getBucket(k);
      if (b && b.attempts >= MAX_ATTEMPTS) {
        const retryAfterMs = b.resetAt - now();
        const err = new Error('too many attempts, try again later');
        (err as Error & { code?: string; retryAfterMs?: number }).code = 'RATE_LIMITED';
        (err as Error & { retryAfterMs?: number }).retryAfterMs = Math.max(retryAfterMs, 0);
        throw err;
      }
    },
    recordFailure(k) {
      const key = bucketKey(k);
      const t = now();
      let b = buckets.get(key);
      if (!b || b.resetAt < t) {
        b = { attempts: 0, resetAt: t + WINDOW_MS };
        buckets.set(key, b);
      }
      b.attempts += 1;
      return BACKOFF_MS[Math.min(b.attempts, BACKOFF_MS.length - 1)] ?? 0;
    },
    reset(k) {
      buckets.delete(bucketKey(k));
    },
  };
}
