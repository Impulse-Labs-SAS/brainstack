import { describe, expect, it } from 'vitest';

import { resolveNames, type NameEntry } from './names.js';

const own = (path: string, title: string, aliases: string[] = []): NameEntry => ({
  path,
  title,
  aliases,
});
const shared = (path: string, title: string, aliases: string[] = []): NameEntry => ({
  path,
  title,
  aliases,
  secondary: true,
});

describe('resolveNames with notes from a shared source', () => {
  it('keeps the reader’s own title when a shared note takes it as an alias', () => {
    const index = [
      own('Private/roadmap-q4.md', 'Roadmap Q4'),
      shared('ledger/Orbit/plan.md', 'Plan', ['Roadmap Q4']),
    ];
    const { named, unresolved, undecided } = resolveNames('What is in the Roadmap Q4?', index);
    expect([...named.keys()]).toEqual(['Private/roadmap-q4.md']);
    expect(unresolved).toEqual([]);
    expect(undecided.size).toBe(0);
  });

  it('keeps the reader’s own title when a shared note has the same title', () => {
    const index = [own('Atlas.md', 'Atlas'), shared('ledger/Atlas.md', 'Atlas')];
    const { named, unresolved } = resolveNames('tell me about Atlas', index);
    expect([...named.keys()]).toEqual(['Atlas.md']);
    expect(unresolved).toEqual([]);
  });

  it('still lets a shared note be named by what nothing of the reader’s uses', () => {
    const index = [
      own('Private/roadmap-q4.md', 'Roadmap Q4'),
      shared('ledger/Orbit/plan.md', 'Plan', ['quarterly plan']),
    ];
    const { named } = resolveNames('where is the quarterly plan', index);
    expect([...named.keys()]).toEqual(['ledger/Orbit/plan.md']);
  });

  it('resolves a link among the reader’s own notes first', () => {
    const index = [
      own('Private/roadmap-q4.md', 'Roadmap Q4'),
      shared('ledger/Orbit/roadmap-q4.md', 'Their roadmap'),
    ];
    const { named, unresolved } = resolveNames('see [[roadmap-q4]]', index);
    expect([...named.keys()]).toEqual(['Private/roadmap-q4.md']);
    expect(unresolved).toEqual([]);
  });

  it('focuses on the reader’s own named notes, not a shared one named beside them', () => {
    const index = [
      own('Erebor/plan.md', 'Erebor plan'),
      shared('ledger/Orbit/notes.md', 'Orbit notes'),
    ];
    const both = resolveNames('compare Erebor plan with Orbit notes', index);
    expect([...both.named.keys()].sort()).toEqual(['Erebor/plan.md', 'ledger/Orbit/notes.md']);
    expect(both.focus).toEqual(['Erebor/plan.md']);

    const sharedOnly = resolveNames('what do the Orbit notes say', index);
    expect(sharedOnly.focus).toEqual(['ledger/Orbit/notes.md']);
  });
});
