import { describe, expect, it } from 'vitest';

import { OTHER_VAULT_COLOR, SHARED_VAULT_COLORS } from './graph-palette';
import { groupSharedOwners } from './shared-owners';

const root = (
  ownerId: string,
  folderPath: string,
  name: string | null,
  email = `${ownerId}@x.io`,
) => ({
  ownerId,
  folderPath,
  ownerDisplayName: name,
  ownerEmail: email,
  permission: 'read' as const,
});

describe('groupSharedOwners', () => {
  it('groups roots by owner, sorted by name, colouring in that order', () => {
    const groups = groupSharedOwners([
      root('b', 'Legal', 'Bruno'),
      root('a', 'Clientes', 'Ana'),
      root('b', 'Finanzas', 'Bruno'),
    ]);
    expect(groups.map((g) => [g.name, g.roots.map((r) => r.folderPath), g.color])).toEqual([
      ['Ana', ['Clientes'], SHARED_VAULT_COLORS[0]!.hue],
      ['Bruno', ['Legal', 'Finanzas'], SHARED_VAULT_COLORS[1]!.hue],
    ]);
  });

  it('names an owner without a display name by their email', () => {
    expect(groupSharedOwners([root('c', 'X', null, 'carla@example.com')])[0]!.name).toBe('carla');
  });

  it('gives owners past the palette the neutral colour', () => {
    const many = Array.from({ length: SHARED_VAULT_COLORS.length + 1 }, (_, i) =>
      root(`o${i}`, 'F', `Owner ${i}`),
    );
    expect(groupSharedOwners(many).at(-1)!.color).toBe(OTHER_VAULT_COLOR.hue);
  });
});
