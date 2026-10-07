// The crawl history over Postgres: what is kept, who sees it, and how it ages out.

import { pgSchema } from '@brainstack/core/pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiKeyService } from './ApiKeyService.js';
import { CrawlHistoryService, MAX_CRAWLS_PER_USER } from './CrawlHistoryService.js';
import { NoteService } from './NoteService.js';
import { OAuthProviderService } from './OAuthProviderService.js';
import { SearchService } from './SearchService.js';
import { gatherContext, type GatherContextResult } from './gatherContext.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users, crawlHistory } = pgSchema;

const ME = 'u1';
const SOMEONE_ELSE = 'u2';
const DAY = 24 * 60 * 60 * 1000;

let database: TestDatabase;
let notes: NoteService;
let search: SearchService;
let clock: number;

const history = (retentionDays = 30) =>
  new CrawlHistoryService({
    db: database.db,
    retentionDays,
    logger: pino({ level: 'silent' }),
    now: () => clock,
  });

const crawl = (text: string): Promise<GatherContextResult> =>
  gatherContext({ notes, search }, ME, { text });

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  clock = 1_800_000_000_000;
  for (const id of [ME, SOMEONE_ELSE]) {
    await database.db
      .insert(users)
      .values({ id, email: `${id}@brain.test`, createdAt: 0, updatedAt: 0 });
  }
  notes = new NoteService({ db: database.db });
  search = new SearchService({ db: database.db });
  await notes.create(ME, 'roadmap.md', '# Roadmap Q4\n\nShip [[billing]] first.');
  await notes.create(ME, 'billing.md', '# Billing service\n\nInvoices and plans.');
});

describe('CrawlHistoryService', () => {
  it('lists a user’s crawls newest first, and replays one without the excerpts', async () => {
    const crawls = history();
    await crawls.record(ME, { source: 'web', text: 'What about the Roadmap Q4?', result: await crawl('Roadmap Q4') });
    clock += 1_000;
    await crawls.record(ME, {
      source: 'assistant',
      text: 'Billing service, please',
      result: await crawl('Billing service'),
    });

    const list = await crawls.list(ME);
    expect(list.map((c) => [c.source, c.prompt, c.notes])).toEqual([
      ['assistant', 'Billing service, please', 2],
      ['web', 'What about the Roadmap Q4?', 2],
    ]);
    expect(list[1]!.coverage).toEqual({ resolved: 1, total: 1 });

    const one = await crawls.get(ME, list[1]!.id);
    expect(one.replay.notes).toEqual([
      { path: 'roadmap.md', title: 'Roadmap Q4', isDecision: false, via: expect.objectContaining({ kind: 'named' }) },
      { path: 'billing.md', title: 'Billing service', isDecision: false, via: expect.objectContaining({ kind: 'linked' }) },
    ]);
    expect(JSON.stringify(one.replay)).not.toContain('Invoices');
  });

  it('never lists or hands over another user’s crawls', async () => {
    const crawls = history();
    await crawls.record(ME, { source: 'web', text: 'Roadmap Q4', result: await crawl('Roadmap Q4') });
    const [mine] = await crawls.list(ME);

    expect(await crawls.list(SOMEONE_ELSE)).toEqual([]);
    await expect(crawls.get(SOMEONE_ELSE, mine!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('forgets crawls older than the retention window', async () => {
    const crawls = history(7);
    await crawls.record(ME, { source: 'web', text: 'old', result: await crawl('Roadmap Q4') });
    clock += 8 * DAY;
    expect(await crawls.list(ME)).toEqual([]);

    await crawls.record(SOMEONE_ELSE, { source: 'web', text: 'new', result: await crawl('nothing') });
    const rows = await database.db.select().from(crawlHistory);
    expect(rows.map((r) => r.prompt)).toEqual(['new']);
  });

  it('keeps only the newest crawls per user', async () => {
    const crawls = history();
    const result = await crawl('Roadmap Q4');
    for (let i = 0; i < MAX_CRAWLS_PER_USER + 3; i++) {
      clock += 1;
      await crawls.record(ME, { source: 'web', text: `crawl ${i}`, result });
    }
    const rows = await database.db.select().from(crawlHistory);
    expect(rows).toHaveLength(MAX_CRAWLS_PER_USER);
    const list = await crawls.list(ME, MAX_CRAWLS_PER_USER);
    expect(list[0]!.prompt).toBe(`crawl ${MAX_CRAWLS_PER_USER + 2}`);
    expect(list.at(-1)!.prompt).toBe('crawl 3');
  });

  it('keeps nothing when turned off, and empties what was kept when the server starts', async () => {
    await history().record(ME, { source: 'web', text: 'kept', result: await crawl('Roadmap Q4') });
    const off = history(0);
    expect(off.enabled).toBe(false);
    expect(await off.list(ME)).toEqual([]);
    expect(
      await off.record(ME, { source: 'web', text: 'not kept', result: await crawl('Roadmap Q4') }),
    ).toBeNull();

    await off.applyRetention();
    expect(await database.db.select().from(crawlHistory)).toEqual([]);
  });

  it('names the assistant by its API key or OAuth client', async () => {
    const key = await new ApiKeyService({ db: database.db }).create(ME, 'Cursor on the laptop');
    const client = await new OAuthProviderService({ db: database.db }).registerClient({
      name: 'Claude',
      redirectUris: ['https://claude.ai/callback'],
    });
    const crawls = history();
    const result = await crawl('Roadmap Q4');
    await crawls.record(ME, { source: 'assistant', clientRef: key.id, text: 'a', result });
    clock += 1;
    await crawls.record(ME, { source: 'assistant', clientRef: `oauth:${client.id}`, text: 'b', result });
    clock += 1;
    await crawls.record(ME, { source: 'assistant', clientRef: 'gone', text: 'c', result });

    expect((await crawls.list(ME)).map((c) => c.client)).toEqual([
      null,
      'Claude',
      'Cursor on the laptop',
    ]);
  });

  it('does not fail the crawl when it cannot be written down', async () => {
    const crawls = history();
    // No such user: the foreign key refuses the row.
    await expect(
      crawls.record('nobody', { source: 'web', text: 'x', result: await crawl('Roadmap Q4') }),
    ).resolves.toBeNull();
  });

  it('stores the start of a long prompt, and lists less of it', async () => {
    const crawls = history();
    const long = 'word '.repeat(1_000);
    await crawls.record(ME, { source: 'web', text: long, result: await crawl('Roadmap Q4') });
    const [listed] = await crawls.list(ME);
    expect(listed!.prompt).toHaveLength(200);
    expect((await crawls.get(ME, listed!.id)).prompt).toHaveLength(2_000);
  });
});
