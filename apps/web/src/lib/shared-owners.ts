// The people who shared folders with you, one entry each, in the order the
// sidebar lists them. The colour is picked by that order, so every place that
// shows an owner — the sidebar group, a shared note's header — agrees on it.

import { OTHER_VAULT_COLOR, SHARED_VAULT_COLORS } from './graph-palette';

export interface SharedRoot {
  ownerId: string;
  folderPath: string;
  ownerDisplayName: string | null;
  ownerEmail: string;
  permission: 'read' | 'write';
}

export interface SharedOwner<R extends SharedRoot> {
  ownerId: string;
  name: string;
  color: string;
  roots: R[];
}

export function ownerName(root: SharedRoot): string {
  return root.ownerDisplayName ?? root.ownerEmail.split('@')[0] ?? root.ownerEmail;
}

export function groupSharedOwners<R extends SharedRoot>(roots: readonly R[]): SharedOwner<R>[] {
  const byOwner = new Map<string, { name: string; roots: R[] }>();
  for (const r of roots) {
    const g = byOwner.get(r.ownerId) ?? { name: ownerName(r), roots: [] };
    g.roots.push(r);
    byOwner.set(r.ownerId, g);
  }
  return [...byOwner.entries()]
    .map(([ownerId, g]) => ({ ownerId, ...g }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g, i) => ({ ...g, color: (SHARED_VAULT_COLORS[i] ?? OTHER_VAULT_COLOR).hue }));
}
