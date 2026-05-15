import { describe, expect, it } from 'vitest';

import { createLoginRateLimiter } from './rateLimitLogin.js';

describe('createLoginRateLimiter', () => {
  it('allows up to 5 failures then blocks until the window resets', () => {
    let t = 0;
    const limiter = createLoginRateLimiter(() => t);
    const k = { ip: '10.0.0.1', email: 'user@brain.test' };

    for (let i = 0; i < 5; i++) {
      expect(() => limiter.check(k)).not.toThrow();
      limiter.recordFailure(k);
    }

    expect(() => limiter.check(k)).toThrow(/too many/);

    // After the 15-minute window the bucket resets.
    t += 16 * 60 * 1000;
    expect(() => limiter.check(k)).not.toThrow();
  });

  it('reset() clears the bucket immediately', () => {
    const limiter = createLoginRateLimiter(() => 0);
    const k = { ip: '10.0.0.1', email: 'user@brain.test' };
    for (let i = 0; i < 5; i++) limiter.recordFailure(k);
    expect(() => limiter.check(k)).toThrow();
    limiter.reset(k);
    expect(() => limiter.check(k)).not.toThrow();
  });

  it('buckets by (ip, email): different ips are tracked separately', () => {
    const limiter = createLoginRateLimiter(() => 0);
    for (let i = 0; i < 5; i++) limiter.recordFailure({ ip: '1.1.1.1', email: 'a@b.c' });
    expect(() => limiter.check({ ip: '1.1.1.1', email: 'a@b.c' })).toThrow();
    expect(() => limiter.check({ ip: '2.2.2.2', email: 'a@b.c' })).not.toThrow();
  });
});
