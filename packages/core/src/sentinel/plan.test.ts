// Sentinel's planner, with no store: a vault is a list of note paths, and the
// plan is checked against what each change leaves for the next.

import { describe, expect, it } from 'vitest';

import {
  ChangePlan,
  NotePlanError,
  indexRenameFor,
  summarizeChanges,
  touchedByMoves,
  type PlanLookup,
  type PlannedChange,
} from './plan.js';

const O = 'owner';

function vault(paths: string[], folders: string[] = []): PlanLookup {
  const under = (p: string, f: string) => p === f || p.startsWith(`${f}/`);
  return {
    hasNote: async (_o, p) => paths.includes(p),
    exists: async (_o, p) => [...paths, ...folders].some((x) => under(x, p)),
    notesUnder: async (_o, f) => paths.filter((p) => p.startsWith(`${f}/`)),
  };
}

/** Check every change in order; the error code of each, or 'ok'. */
async function run(lookup: PlanLookup, changes: Omit<PlannedChange, 'owner'>[]) {
  const plan = new ChangePlan(lookup);
  const out: Array<{ code: string; origin?: string; message?: string }> = [];
  for (const [i, c] of changes.entries()) {
    try {
      const r = await plan.check({ owner: O, ...c }, i);
      out.push({ code: 'ok', ...r });
    } catch (err) {
      if (!(err instanceof NotePlanError)) throw err;
      out.push({ code: err.code, message: err.message });
    }
  }
  return out;
}

const ATLAS = ['crew/erebor/_erebor.md', 'crew/erebor/log.md', 'home.md'];

describe('ChangePlan', () => {
  it('follows a folder move, its index included, for the changes after it', async () => {
    const r = await run(vault(ATLAS), [
      { action: 'move', path: 'crew/erebor', to: 'crew/atlas' },
      { action: 'edit', path: 'crew/atlas/_atlas.md' },
      { action: 'replace', path: 'crew/atlas/log.md' },
      { action: 'create_folder', path: 'crew/atlas/archive' },
      { action: 'create', path: 'crew/atlas/archive/old.md' },
    ]);
    expect(r).toEqual([
      { code: 'ok' },
      { code: 'ok', origin: 'crew/erebor/_erebor.md' },
      { code: 'ok', origin: 'crew/erebor/log.md' },
      { code: 'ok' },
      { code: 'ok' },
    ]);
  });

  it('refuses what an earlier change moved away, and a destination already taken', async () => {
    const r = await run(vault(ATLAS), [
      { action: 'move', path: 'crew/erebor', to: 'crew/atlas' },
      { action: 'edit', path: 'crew/erebor/log.md' },
      { action: 'create', path: 'crew/atlas/log.md' },
      { action: 'move', path: 'home.md', to: 'crew/atlas/_atlas.md' },
    ]);
    expect(r.map((x) => x.code)).toEqual(['ok', 'NOT_FOUND', 'ALREADY_EXISTS', 'ALREADY_EXISTS']);
  });

  it('refuses a folder move whose notes would land on notes already there', async () => {
    const r = await run(vault([...ATLAS, 'crew/atlas/log.md']), [
      { action: 'move', path: 'crew/erebor', to: 'crew/atlas' },
    ]);
    expect(r).toEqual([{ code: 'ALREADY_EXISTS', message: 'crew/atlas/log.md already exists' }]);
  });

  it('keeps an index already named after the new folder', async () => {
    const r = await run(vault([...ATLAS, 'crew/erebor/_atlas.md']), [
      { action: 'move', path: 'crew/erebor', to: 'crew/atlas' },
      { action: 'edit', path: 'crew/atlas/_erebor.md' },
      { action: 'edit', path: 'crew/atlas/_atlas.md' },
    ]);
    expect(r).toEqual([
      { code: 'ok' },
      { code: 'ok', origin: 'crew/erebor/_erebor.md' },
      { code: 'ok', origin: 'crew/erebor/_atlas.md' },
    ]);
  });

  it('lets a note be written once, however it is named', async () => {
    const r = await run(vault(ATLAS), [
      { action: 'edit', path: 'crew/erebor/log.md' },
      { action: 'move', path: 'crew/erebor', to: 'crew/atlas' },
      { action: 'edit', path: './crew/atlas/log.md' },
    ]);
    expect(r[2]).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('change 1 too'),
    });
  });

  it('refuses writes inside a folder the plan deletes, before or after the delete', async () => {
    const after = await run(vault(ATLAS), [
      { action: 'delete', path: 'crew', recursive: true },
      { action: 'edit', path: 'crew/erebor/log.md' },
    ]);
    expect(after[1]).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('deleted by change 1'),
    });
    const before = await run(vault(ATLAS), [
      { action: 'edit', path: 'crew/erebor/log.md' },
      { action: 'delete', path: 'crew', recursive: true },
    ]);
    expect(before[1]).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a move into itself and a climbing path', async () => {
    const plan = new ChangePlan(vault(ATLAS));
    await expect(
      plan.check({ owner: O, action: 'move', path: 'crew', to: 'crew/inner' }, 0),
    ).rejects.toThrow(/inside itself/);
    await expect(plan.check({ owner: O, action: 'edit', path: '../x.md' }, 1)).rejects.toThrow();
  });

  it('keeps owners apart', async () => {
    const plan = new ChangePlan(vault(ATLAS));
    await plan.check({ owner: 'a', action: 'move', path: 'home.md', to: 'start.md' }, 0);
    await expect(plan.check({ owner: 'b', action: 'edit', path: 'home.md' }, 1)).resolves.toEqual({
      origin: 'home.md',
    });
  });
});

describe('indexRenameFor', () => {
  it('names the index after the new folder, and nothing when the name stays', () => {
    expect(indexRenameFor('a/luna', 'b/simon')).toEqual({
      from: 'b/simon/_luna.md',
      to: 'b/simon/_simon.md',
    });
    expect(indexRenameFor('a/luna', 'b/luna')).toBeNull();
  });
});

describe('the report', () => {
  const owners = [{ owner: O }, { owner: O }, { owner: O }];

  it('follows a rewritten note to where a later move took it, and drops one a later change wrote', () => {
    const touched = touchedByMoves(owners, [
      { action: 'move', status: 'done', path: 'b', linksRewritten: ['home.md', 'x.md'] },
      {
        action: 'move',
        status: 'done',
        path: 'start.md',
        moved: [{ from: 'home.md', to: 'start.md' }],
      },
      { action: 'edit', status: 'done', path: 'x.md' },
    ]);
    expect(touched).toEqual(new Map([[O, ['start.md']]]));
  });

  it('sums up what was done', () => {
    expect(
      summarizeChanges([
        {
          action: 'move',
          status: 'done',
          path: 'b',
          moved: [{ from: 'a/x.md', to: 'b/x.md' }],
          linksRewritten: ['h.md'],
        },
        { action: 'create', status: 'done', path: 'b/y.md' },
        { action: 'edit', status: 'skipped', path: 'b/z.md' },
      ]),
    ).toBe('1 moved (1 note), links rewritten in 1 note, 1 created, 1 not run');
  });
});
