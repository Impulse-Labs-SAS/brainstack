// Smoke test del endpoint /api/config — gating de features por deployment.

import { describe, expect, it } from 'vitest';

import { createConfigRouter } from './config.js';

describe('GET /api/config', () => {
  it('reporta self-host con sharing apagado', async () => {
    const router = createConfigRouter({
      deployment: 'self-host',
      features: { sharing: false },
    });
    const res = await router.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deployment: 'self-host',
      features: { sharing: false },
    });
  });

  it('reporta hosted con sharing prendido', async () => {
    const router = createConfigRouter({
      deployment: 'hosted',
      features: { sharing: true },
    });
    const res = await router.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deployment: 'hosted',
      features: { sharing: true },
    });
  });

  it('no requiere auth', async () => {
    const router = createConfigRouter({
      deployment: 'self-host',
      features: { sharing: false },
    });
    const res = await router.request('/', { headers: {} });
    expect(res.status).toBe(200);
  });
});
