import { describe, expect, it } from 'vitest';

import { findWalk, planCrawl } from './crawl-plan';
import { sampleVault } from './sample-vault';
import { typicalLink } from './threads';

const byPath = (m: ReturnType<typeof sampleVault>['model'], path: string) =>
  m.nodes.find((n) => n.path === path)!;

describe('sampleVault', () => {
  it('lays out the same notes for the same seed', () => {
    const a = sampleVault(3).model.nodes.map((n) => [n.id, n.x, n.y, n.z]);
    const b = sampleVault(3).model.nodes.map((n) => [n.id, n.x, n.y, n.z]);
    expect(a).toEqual(b);
  });

  it('keeps the island out of reach of every thread from the lattice', () => {
    const { model } = sampleVault();
    const lattice = byPath(model, 'Main/Ingest pipeline.md');
    const island = byPath(model, 'Island/Field notes.md');
    expect(findWalk(model, lattice, island)).toBeNull();
    expect(findWalk(model, island, byPath(model, 'Island/Sketchbook.md'))).not.toBeNull();
  });

  it('joins the two ends of the walk crawl along threads', () => {
    const { model } = sampleVault();
    const path = findWalk(
      model,
      byPath(model, 'Main/Ingest pipeline.md'),
      byPath(model, 'Main/Changelog.md'),
    );
    expect(path?.length).toBeGreaterThan(3);
  });

  it('gives a typical link close to the spacing it was built with', () => {
    const unit = typicalLink(sampleVault().model);
    expect(unit).toBeGreaterThan(44 * 0.6 * 0.7);
    expect(unit).toBeLessThan(44 * 0.6 * 1.5);
  });

  it('plans every crawl it offers onto notes the graph shows', () => {
    const { model, crawls } = sampleVault();
    for (const result of Object.values(crawls)) {
      const plan = planCrawl(result, model);
      expect(plan.offGraph).toBe(0);
      expect(plan.steps.at(-1)?.kind).toBe('finish');
    }
  });
});
