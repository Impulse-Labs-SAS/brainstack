import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetConfigForTests, loadConfig } from './env.js';

// A developer's own apps/server/.env must not leak into what is tested here.
vi.mock('dotenv', () => ({ config: () => ({}) }));

const saved = { ...process.env };

function configWith(vars: Record<string, string>) {
  process.env = { ...saved, DATABASE_URL: 'postgres://u:p@localhost/db' };
  delete process.env.EXPOSE_AUTH_LINKS;
  Object.assign(process.env, vars);
  _resetConfigForTests();
  return loadConfig();
}

afterEach(() => {
  process.env = { ...saved };
  _resetConfigForTests();
});

describe('EXPOSE_AUTH_LINKS', () => {
  // The template's origin is http://; it used to switch this on by itself.
  it('is off for an http origin unless asked for', () => {
    expect(configWith({ PUBLIC_ORIGIN: 'http://localhost' }).EXPOSE_AUTH_LINKS).toBe(false);
  });

  it('is off when left empty, as the compose template leaves it', () => {
    expect(configWith({ EXPOSE_AUTH_LINKS: '' }).EXPOSE_AUTH_LINKS).toBe(false);
  });

  it('is on only when set', () => {
    expect(configWith({ EXPOSE_AUTH_LINKS: 'true' }).EXPOSE_AUTH_LINKS).toBe(true);
  });
});
