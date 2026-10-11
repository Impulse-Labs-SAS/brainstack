// In-memory limiter for failed sign-ins, per process.
//
// Two buckets per attempt, both of which must have room:
//   (ip, email)  five failures per quarter hour against one account from one
//                place — a person who mistyped their password a few times;
//   ip           thirty failures per quarter hour from one place, whatever
//                the email — without it, one address could try five
//                passwords against every account on a list, and each try
//                costs the server a 32 MB scrypt.
// The IP is whatever `clientIp` was configured to trust. A brute force spread
// over many addresses is slowed per address only; the rate limiter in front
// of /auth bounds the request rate on top.

import { AppError } from './errors.js';

const MAX_ATTEMPTS_PER_ACCOUNT = 5;
const MAX_ATTEMPTS_PER_IP = 30;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000, 16_000];
const SWEEP_EVERY = 1_000;

interface Bucket {
  attempts: number;
  resetAt: number;
}

export interface LoginRateLimiter {
  /** Throws AppError('RATE_LIMITED') if either bucket is out of attempts. */
  check(key: { ip: string; email: string }): void;
  /** Record a failed attempt. Returns the recommended backoff in ms. */
  recordFailure(key: { ip: string; email: string }): number;
  /** Clear the account's bucket on a successful sign-in. */
  reset(key: { ip: string; email: string }): void;
}

export function createLoginRateLimiter(now: () => number = Date.now): LoginRateLimiter {
  const buckets = new Map<string, Bucket>();
  let writes = 0;

  const accountKey = (k: { ip: string; email: string }): string =>
    `${k.ip}|${k.email.toLowerCase()}`;
  const ipKey = (k: { ip: string }): string => `${k.ip}|*`;

  function live(key: string): Bucket | undefined {
    const b = buckets.get(key);
    if (!b) return undefined;
    if (b.resetAt < now()) {
      buckets.delete(key);
      return undefined;
    }
    return b;
  }

  function bump(key: string): number {
    const t = now();
    if (++writes % SWEEP_EVERY === 0) {
      for (const [k, b] of buckets) if (b.resetAt < t) buckets.delete(k);
    }
    const b = live(key) ?? { attempts: 0, resetAt: t + WINDOW_MS };
    b.attempts += 1;
    buckets.set(key, b);
    return b.attempts;
  }

  function refuse(b: Bucket): never {
    const minutes = Math.max(1, Math.ceil((b.resetAt - now()) / 60_000));
    throw new AppError(
      `too many attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}`,
      'RATE_LIMITED',
      429,
    );
  }

  return {
    check(k) {
      const account = live(accountKey(k));
      if (account && account.attempts >= MAX_ATTEMPTS_PER_ACCOUNT) refuse(account);
      const ip = live(ipKey(k));
      if (ip && ip.attempts >= MAX_ATTEMPTS_PER_IP) refuse(ip);
    },
    recordFailure(k) {
      bump(ipKey(k));
      const attempts = bump(accountKey(k));
      return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 0;
    },
    reset(k) {
      buckets.delete(accountKey(k));
    },
  };
}
