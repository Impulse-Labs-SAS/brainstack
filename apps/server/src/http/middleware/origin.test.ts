import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE, type AuthBindings } from './auth.js';
import { buildOriginCheckMiddleware } from './origin.js';

function app() {
  const a = new Hono<AuthBindings>();
  a.use('*', buildOriginCheckMiddleware({ allowedOrigins: ['https://app.example.com/'] }));
  a.all('/x', (c) => c.json({ ok: true }));
  return a;
}

const cookie = `${SESSION_COOKIE}=t`;

async function status(method: string, headers: Record<string, string>): Promise<number> {
  return (await app().request('https://api.example.com/x', { method, headers })).status;
}

describe('origin check', () => {
  it('lets the app’s own pages through', async () => {
    expect(await status('POST', { cookie, origin: 'https://app.example.com' })).toBe(200);
    // The API's own pages (the consent form) post to the same host.
    expect(
      await status('POST', { cookie, origin: 'https://api.example.com', host: 'api.example.com' }),
    ).toBe(200);
  });

  it('refuses a cookie-carrying change from another origin', async () => {
    expect(await status('POST', { cookie, origin: 'https://other.example.com' })).toBe(403);
    expect(await status('DELETE', { cookie, origin: 'null' })).toBe(403);
    expect(await status('POST', { cookie, 'sec-fetch-site': 'cross-site' })).toBe(403);
  });

  it('leaves reads, cookie-less requests and non-browser clients alone', async () => {
    expect(await status('GET', { cookie, origin: 'https://other.example.com' })).toBe(200);
    expect(await status('POST', { origin: 'https://other.example.com' })).toBe(200);
    expect(
      await status('POST', { authorization: 'Bearer k', origin: 'https://other.example.com' }),
    ).toBe(200);
    expect(await status('POST', { cookie })).toBe(200);
    expect(await status('POST', { cookie, 'sec-fetch-site': 'same-origin' })).toBe(200);
  });
});
