import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { clientIp, type TrustedProxy } from './clientIp.js';

/** The address `trust` reads from a request carrying `headers`. */
async function ipFor(trust: TrustedProxy, headers: Record<string, string>): Promise<string> {
  const app = new Hono().get('/', (c) => c.text(clientIp(c, trust)));
  return (await app.request('/', { headers })).text();
}

describe('clientIp', () => {
  it('takes the last X-Forwarded-For entry behind our own proxy, not the client-written first', async () => {
    expect(await ipFor('proxy', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })).toBe('203.0.113.9');
  });

  it('reads a named header when a CDN in front names the client', async () => {
    const headers = { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '104.16.0.1' };
    expect(await ipFor('header:CF-Connecting-IP', headers)).toBe('198.51.100.7');
    // Without it, every visitor would share the CDN's address.
    expect(await ipFor('proxy', headers)).toBe('104.16.0.1');
  });

  it('ignores forwarding headers when told nothing sits in front', async () => {
    expect(await ipFor('direct', { 'x-forwarded-for': '6.6.6.6' })).toBe('unknown');
  });
});
