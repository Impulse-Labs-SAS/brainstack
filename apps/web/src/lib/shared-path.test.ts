import { describe, expect, it } from 'vitest';

import { resolveSharedPath } from './shared-path';

const grant = (folderPath: string) => ({
  ownerId: 'ana',
  folderPath,
  ownerDisplayName: 'Ana',
  ownerEmail: 'ana@example.com',
  permission: 'read' as const,
});

describe('resolveSharedPath', () => {
  it('reads a share root as its folder, with no crumbs', () => {
    const r = resolveSharedPath('Clientes', [grant('Clientes')]);
    expect(r).toMatchObject({ isFolder: true, path: 'Clientes', crumbs: [] });
    expect(r.shareRoot?.folderPath).toBe('Clientes');
  });

  it('puts the dropped .md back on a note', () => {
    const r = resolveSharedPath('Clientes/Acme/Kickoff', [grant('Clientes')]);
    expect(r.isFolder).toBe(false);
    expect(r.path).toBe('Clientes/Acme/Kickoff.md');
  });

  it('keeps a .md the URL already carries', () => {
    expect(resolveSharedPath('Clientes/Kickoff.md', [grant('Clientes')]).path).toBe(
      'Clientes/Kickoff.md',
    );
  });

  it('starts the crumbs at the shared folder, not above it', () => {
    const r = resolveSharedPath('Work/Clientes/Acme/Kickoff', [grant('Work/Clientes')]);
    expect(r.crumbs).toEqual([
      { label: 'Clientes', path: 'Work/Clientes' },
      { label: 'Acme', path: 'Work/Clientes/Acme' },
    ]);
  });

  it('gives a note right under the shared folder that folder as its only crumb', () => {
    expect(resolveSharedPath('Clientes/Overview', [grant('Clientes')]).crumbs).toEqual([
      { label: 'Clientes', path: 'Clientes' },
    ]);
  });

  it('picks the deepest grant covering the path', () => {
    const r = resolveSharedPath('Clientes/Acme/Kickoff', [
      grant('Clientes'),
      grant('Clientes/Acme'),
    ]);
    expect(r.shareRoot?.folderPath).toBe('Clientes/Acme');
    expect(r.crumbs).toEqual([{ label: 'Acme', path: 'Clientes/Acme' }]);
  });

  it('treats a shared folder named like a note as the folder', () => {
    expect(resolveSharedPath('Notes.md', [grant('Notes.md')]).isFolder).toBe(true);
  });

  it('finds no grant for a path outside every share', () => {
    const r = resolveSharedPath('Legal/NDA', [grant('Clientes')]);
    expect(r.shareRoot).toBeNull();
    expect(r.crumbs).toEqual([]);
  });

  it('does not take a sibling with the same prefix for the share', () => {
    expect(resolveSharedPath('Clientes2/X', [grant('Clientes')]).shareRoot).toBeNull();
  });
});
