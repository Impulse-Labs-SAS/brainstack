// gather_context over Postgres: the seeds, the hop along wikilinks, what is
// reported instead of guessed, the budget, and the vault boundary.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteService } from './NoteService.js';
import { SearchService } from './SearchService.js';
import { gatherContext } from './gatherContext.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users } = pgSchema;

const ME = 'u1';
const SOMEONE_ELSE = 'u2';

let database: TestDatabase;
let notes: NoteService;
let search: SearchService;

const gather = (text: string, opts: { terms?: string[]; depth?: number; maxChars?: number } = {}) =>
  gatherContext({ notes, search }, ME, { text, ...opts });

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  for (const id of [ME, SOMEONE_ELSE]) {
    await database.db
      .insert(users)
      .values({ id, email: `${id}@brain.test`, createdAt: Date.now(), updatedAt: 0 });
  }
  notes = new NoteService({ db: database.db });
  search = new SearchService({ db: database.db });
});

describe('gatherContext', () => {
  it('returns the notes the text names, then what they link to', async () => {
    await notes.create(ME, 'roadmap.md', '# Roadmap Q4\n\nShip [[billing]] first.');
    await notes.create(ME, 'billing.md', '# Billing service\n\nInvoices and plans.');
    await notes.create(ME, 'onboarding.md', '# Onboarding flow\n\nSteps for new users.');
    await notes.create(ME, 'unrelated.md', '# Gardening\n\nTomatoes.');

    const result = await gather('Plan the Roadmap Q4 work around the onboarding flow.');

    const paths = result.notes.map((n) => n.path);
    expect(paths.slice(0, 2).sort()).toEqual(['onboarding.md', 'roadmap.md']);
    expect(paths).toContain('billing.md');
    expect(paths).not.toContain('unrelated.md');

    expect(result.notes.find((n) => n.path === 'roadmap.md')).toMatchObject({
      reason: 'the text says "Roadmap Q4"',
      via: { kind: 'named' },
    });
    expect(result.notes.find((n) => n.path === 'billing.md')).toMatchObject({
      reason: 'linked from Roadmap Q4',
      via: { kind: 'linked', hop: 1 },
    });
    expect(result.coverage).toEqual({ resolved: 2, total: 2 });
  });

  it('follows backlinks too', async () => {
    await notes.create(ME, 'pricing.md', '# Pricing decision\n\nTiered.');
    await notes.create(ME, 'sales.md', '# Sales playbook\n\nSee [[pricing]].');

    const result = await gather('What does the Pricing decision say?');
    expect(result.notes.find((n) => n.path === 'sales.md')?.reason).toBe(
      'links to Pricing decision',
    );
  });

  it('stops at the seeds with depth 0', async () => {
    await notes.create(ME, 'roadmap.md', '# Roadmap Q4\n\nShip [[billing]] first.');
    await notes.create(ME, 'billing.md', '# Billing service');

    const result = await gather('Roadmap Q4', { depth: 0 });
    expect(result.notes.map((n) => n.path)).toEqual(['roadmap.md']);
  });

  it('reports a title two notes share, with both, instead of picking one', async () => {
    await notes.create(ME, 'alpha/architecture.md', '# Architecture\n\nAlpha.');
    await notes.create(ME, 'beta/architecture.md', '# Architecture\n\nBeta.');

    const result = await gather('Review the architecture before starting.');
    expect(result.notes).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        term: 'architecture',
        reason: 'ambiguous',
        candidates: [
          { path: 'alpha/architecture.md', title: 'Architecture' },
          { path: 'beta/architecture.md', title: 'Architecture' },
        ],
      },
    ]);
    expect(result.coverage).toEqual({ resolved: 0, total: 1 });
  });

  it('searches the vague terms, and reports the ones nothing matches', async () => {
    await notes.create(ME, 'refunds.md', '# Customer policies\n\nRefunds within thirty days.');

    const result = await gather('Handle refunds like we agreed, and the usual escalation.', {
      terms: ['refunds', 'escalation', 'Refunds'],
    });
    expect(result.notes[0]).toMatchObject({
      path: 'refunds.md',
      reason: 'matches "refunds"',
      via: { kind: 'search' },
    });
    expect(result.unresolved).toEqual([{ term: 'escalation', reason: 'no-match' }]);
    expect(result.coverage).toEqual({ resolved: 1, total: 2 });
  });

  it('weighs a decision above a note it would otherwise tie with', async () => {
    await notes.create(ME, 'hub.md', '# Launch plan\n\n[[notes]] and [[decided]].');
    await notes.create(ME, 'notes.md', '# Meeting notes');
    await notes.create(ME, 'decided.md', '# Go with plan B', { tags: ['decision'] });

    const result = await gather('Launch plan');
    const linked = result.notes.filter((n) => n.via.kind === 'linked');
    expect(linked.map((n) => n.path)).toEqual(['decided.md', 'notes.md']);
    expect(linked[0]!.isDecision).toBe(true);
  });

  it('keeps the excerpts within the budget', async () => {
    const long = 'Lorem ipsum dolor sit amet. '.repeat(400);
    await notes.create(ME, 'one.md', `# First topic\n\n${long}`);
    await notes.create(ME, 'two.md', `# Second topic\n\n${long}`);

    const result = await gather('First topic and Second topic', { maxChars: 1_000 });
    expect(result.budget.usedChars).toBeLessThanOrEqual(1_000);
    expect(result.notes.reduce((n, note) => n + note.excerpt.length, 0)).toBe(
      result.budget.usedChars,
    );
    expect(result.notes[0]!.truncated).toBe(true);
  });

  it('never returns another user’s notes, however plainly the text names them', async () => {
    await notes.create(SOMEONE_ELSE, 'secret.md', '# Secret project\n\nHidden.');
    await notes.create(ME, 'mine.md', '# My project');

    const result = await gather('Secret project and My project', { terms: ['Hidden'] });
    expect(result.notes.map((n) => n.path)).toEqual(['mine.md']);
    expect(result.unresolved).toEqual([{ term: 'Hidden', reason: 'no-match' }]);
  });
});
