// Smoke test for /api/config.

import { describe, expect, it } from 'vitest';

import { createConfigRouter } from './config.js';

describe('GET /api/config', () => {
  it('reports sharing on, and no deployment mode', async () => {
    const res = await createConfigRouter().request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ features: { sharing: true } });
  });
});
