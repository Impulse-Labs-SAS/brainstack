import { describe, expect, it } from 'vitest';

import { ownerIdFromPhysicalPath, toLogical, toPhysical } from './vault.js';

describe('ownerIdFromPhysicalPath', () => {
  it('takes the first segment', () => {
    expect(ownerIdFromPhysicalPath('alice/proyectos/foo.md')).toBe('alice');
  });

  it('has nobody to name on an empty path', () => {
    expect(ownerIdFromPhysicalPath('')).toBeNull();
  });
});

describe('toPhysical / toLogical', () => {
  it('adds and strips the <userId>/ prefix', () => {
    expect(toPhysical('alice', 'proyectos/foo.md')).toBe('alice/proyectos/foo.md');
    expect(toLogical('alice', 'alice/proyectos/foo.md')).toBe('proyectos/foo.md');
  });

  it('toPhysical is idempotent on an already-prefixed path', () => {
    expect(toPhysical('alice', 'alice/proyectos/foo.md')).toBe('alice/proyectos/foo.md');
  });

  it('toLogical throws on a path belonging to somebody else', () => {
    // The last line of defence for a query that forgot to filter by owner: a
    // leak surfaces as an error rather than as another user's note on screen.
    expect(() => toLogical('alice', 'bob/x.md')).toThrow();
  });

  it('toLogical maps the user root to the empty path', () => {
    expect(toLogical('alice', 'alice')).toBe('');
  });

  it('requires a user', () => {
    expect(() => toPhysical('', 'x.md')).toThrow();
    expect(() => toLogical('', 'x.md')).toThrow();
  });
});
