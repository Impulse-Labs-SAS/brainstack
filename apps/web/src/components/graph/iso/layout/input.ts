// What the plate layout reads from the graph model, and nothing more: plain data,
// so it crosses into the layout worker as a structured clone without dragging the
// model's node objects, edges and adjacency along.

import type { GraphModel } from '@/lib/graph-model';

import type { LayoutNote, LayoutVault } from './territories';

/** The notes filed in a project, and the vaults on show in the model's order, yours first. */
export function layoutInput(model: Pick<GraphModel, 'nodes' | 'vaults'>): {
  notes: LayoutNote[];
  vaults: LayoutVault[];
} {
  const notes: LayoutNote[] = [];
  for (const n of model.nodes) {
    if (n.kind !== 'note' || !n.project) continue;
    notes.push({
      id: n.id,
      path: n.path,
      project: n.project.id,
      projectLabel: n.project.label,
      vault: n.vault,
      isIndex: n.isIndex,
      createdAt: n.createdAt,
    });
  }
  const vaults = model.vaults
    .filter((v) => !v.hidden)
    .map((v) => ({ id: v.id, label: v.label, shared: !v.own }));
  return { notes, vaults };
}
