import { describe, expect, it } from 'vitest';

import { ownerIdFromPhysicalPath, toLogical, toPhysical } from './vault.js';

const selfCfg = { deployment: 'self-host' as const };
const hostedCfg = { deployment: 'hosted' as const };

describe('ownerIdFromPhysicalPath', () => {
  it('self-host has no owner in the path', () => {
    expect(ownerIdFromPhysicalPath('proyectos/foo.md', selfCfg)).toBeNull();
  });

  it('hosted takes the first segment', () => {
    expect(ownerIdFromPhysicalPath('alice/proyectos/foo.md', hostedCfg)).toBe('alice');
  });

  it('hosted on an empty path has nobody to name', () => {
    expect(ownerIdFromPhysicalPath('', hostedCfg)).toBeNull();
  });
});

describe('toPhysical / toLogical', () => {
  it('self-host: identity both ways', () => {
    expect(toPhysical('alice', 'proyectos/foo.md', selfCfg)).toBe('proyectos/foo.md');
    expect(toLogical('alice', 'proyectos/foo.md', selfCfg)).toBe('proyectos/foo.md');
  });

  it('hosted: adds and strips the <userId>/ prefix', () => {
    expect(toPhysical('alice', 'proyectos/foo.md', hostedCfg)).toBe('alice/proyectos/foo.md');
    expect(toLogical('alice', 'alice/proyectos/foo.md', hostedCfg)).toBe('proyectos/foo.md');
  });

  it('hosted toPhysical is idempotent on an already-prefixed path', () => {
    expect(toPhysical('alice', 'alice/proyectos/foo.md', hostedCfg)).toBe('alice/proyectos/foo.md');
  });

  it('hosted toLogical throws on a path belonging to somebody else', () => {
    // The last line of defence for a query that forgot to filter by owner: a
    // leak surfaces as an error rather than as another user's note on screen.
    expect(() => toLogical('alice', 'bob/x.md', hostedCfg)).toThrow();
  });

  it('hosted toLogical maps the user root to the empty path', () => {
    expect(toLogical('alice', 'alice', hostedCfg)).toBe('');
  });

  it('hosted requires a user', () => {
    expect(() => toPhysical('', 'x.md', hostedCfg)).toThrow();
    expect(() => toLogical('', 'x.md', hostedCfg)).toThrow();
  });
});
