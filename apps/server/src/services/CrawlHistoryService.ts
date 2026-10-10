// The crawls `gather_context` made for each user, so the Sentinel view can list
// them and replay one — including the ones an assistant made over MCP, which
// the web app would otherwise never hear about.
//
// What is kept is the replay, not the answer: paths, titles and why each note
// was reached. The excerpts the assistant was handed are not stored; they are
// the notes themselves, and a second copy would outlive an edit or a delete.
//
// Rows belong to the user who crawled, who is always the vault's owner here —
// `gather_context` reads the caller's own vault only. Nobody else lists them,
// a folder share included.

import { pgSchema, type PgDb } from '@brainstack/core/pg';
import { and, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Logger } from 'pino';

import { AppError } from '../lib/errors.js';

import type { GatherContextResult } from './gatherContext.js';

const { crawlHistory, apiKeys, oauthClients } = pgSchema;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Crawls kept per user, newest first, whatever their age. */
export const MAX_CRAWLS_PER_USER = 50;
/** Of the prompt, what is stored: enough to recognise it, not a copy of a brief. */
export const STORED_PROMPT_CHARS = 2_000;
/** Of the prompt, what a listing carries. */
const LISTED_PROMPT_CHARS = 200;

export type CrawlSource = 'assistant' | 'web';

/** What a replay needs from a `gather_context` answer. */
export interface CrawlReplay {
  notes: Array<
    Pick<GatherContextResult['notes'][number], 'path' | 'ownerId' | 'title' | 'isDecision' | 'via'>
  >;
  unresolved: GatherContextResult['unresolved'];
  coverage: GatherContextResult['coverage'];
  notesLeftOut: number;
}

export interface CrawlSummary {
  id: string;
  createdAt: number;
  source: CrawlSource;
  /** The API key's or OAuth client's name an assistant called with, when known. */
  client: string | null;
  /** The start of the prompt. */
  prompt: string;
  notes: number;
  coverage: { resolved: number; total: number };
}

export interface CrawlRecord extends CrawlSummary {
  replay: CrawlReplay;
}

export interface CrawlHistoryOptions {
  db: PgDb;
  /** Days a crawl is kept. 0 turns history off and empties it. */
  retentionDays: number;
  logger?: Logger;
  now?: () => number;
}

export function toReplay(result: GatherContextResult): CrawlReplay {
  return {
    notes: result.notes.map(({ path, ownerId, title, isDecision, via }) => ({
      path,
      ...(ownerId ? { ownerId } : {}),
      title,
      isDecision,
      via,
    })),
    unresolved: result.unresolved,
    coverage: result.coverage,
    notesLeftOut: result.budget.notesLeftOut,
  };
}

export class CrawlHistoryService {
  private readonly now: () => number;

  constructor(private readonly opts: CrawlHistoryOptions) {
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.retentionDays > 0;
  }

  /**
   * Keep a crawl, and prune what has aged out. Returns its id, or null when
   * nothing was kept.
   *
   * Never throws: history is a convenience, and a crawl the assistant is
   * waiting on must not fail because it could not be written down. Awaited by
   * the caller all the same — on a serverless runtime nothing is guaranteed to
   * run once the response has gone out.
   */
  async record(
    userId: string,
    crawl: { source: CrawlSource; clientRef?: string | null; text: string; result: GatherContextResult },
  ): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      await this.prune(userId);
      const id = nanoid();
      await this.opts.db.insert(crawlHistory).values({
        id,
        userId,
        source: crawl.source,
        clientRef: crawl.clientRef ?? null,
        prompt: crawl.text.slice(0, STORED_PROMPT_CHARS),
        result: toReplay(crawl.result),
        createdAt: this.now(),
      });
      return id;
    } catch (err) {
      this.opts.logger?.error({ err }, 'could not record a crawl in the history');
      return null;
    }
  }

  /** The user's recent crawls, newest first. */
  async list(userId: string, limit = 20): Promise<CrawlSummary[]> {
    if (!this.enabled) return [];
    const rows = await this.opts.db
      .select({
        id: crawlHistory.id,
        createdAt: crawlHistory.createdAt,
        source: crawlHistory.source,
        clientRef: crawlHistory.clientRef,
        prompt: sql<string>`substring(${crawlHistory.prompt} from 1 for ${LISTED_PROMPT_CHARS})`,
        notes: sql<number>`jsonb_array_length(${crawlHistory.result} -> 'notes')`,
        coverage: sql<CrawlSummary['coverage']>`${crawlHistory.result} -> 'coverage'`,
      })
      .from(crawlHistory)
      .where(and(eq(crawlHistory.userId, userId), sql`${crawlHistory.createdAt} >= ${this.cutoff()}`))
      .orderBy(desc(crawlHistory.createdAt), desc(crawlHistory.id))
      .limit(Math.min(Math.max(limit, 1), MAX_CRAWLS_PER_USER));
    const names = await this.clientNames(
      userId,
      rows.map((r) => r.clientRef),
    );
    return rows.map(({ clientRef, ...r }) => ({
      ...r,
      notes: Number(r.notes),
      client: clientRef ? (names.get(clientRef) ?? null) : null,
    }));
  }

  /** One crawl, to replay. Another user's id reads as not found. */
  async get(userId: string, id: string): Promise<CrawlRecord> {
    const [row] = this.enabled
      ? await this.opts.db
          .select()
          .from(crawlHistory)
          .where(
            and(
              eq(crawlHistory.id, id),
              eq(crawlHistory.userId, userId),
              sql`${crawlHistory.createdAt} >= ${this.cutoff()}`,
            ),
          )
      : [];
    if (!row) throw new AppError('crawl not found', 'NOT_FOUND', 404);
    const replay = row.result as CrawlReplay;
    const names = await this.clientNames(userId, [row.clientRef]);
    return {
      id: row.id,
      createdAt: row.createdAt,
      source: row.source,
      client: row.clientRef ? (names.get(row.clientRef) ?? null) : null,
      prompt: row.prompt,
      notes: replay.notes.length,
      coverage: replay.coverage,
      replay,
    };
  }

  /** Oldest moment a kept crawl may date from. */
  private cutoff(): number {
    return this.now() - this.opts.retentionDays * DAY_MS;
  }

  /**
   * Apply the retention window to every user's crawls; with history off,
   * delete them all. Called at boot, so turning the history off empties it
   * then rather than at some later crawl that will never come.
   */
  async applyRetention(): Promise<void> {
    if (!this.enabled) await this.opts.db.delete(crawlHistory);
    else await this.opts.db.delete(crawlHistory).where(lt(crawlHistory.createdAt, this.cutoff()));
  }

  /**
   * Age out every user's old crawls, and this user's beyond the newest
   * `MAX_CRAWLS_PER_USER`. Done on write so no scheduler is needed — a
   * serverless deploy has none — and kept to two indexed deletes. The cap is
   * best-effort: two crawls written at once may leave one row over it until
   * the next.
   */
  private async prune(userId: string): Promise<void> {
    await this.applyRetention();
    const keep = this.opts.db
      .select({ id: crawlHistory.id })
      .from(crawlHistory)
      .where(eq(crawlHistory.userId, userId))
      .orderBy(desc(crawlHistory.createdAt), desc(crawlHistory.id))
      .limit(MAX_CRAWLS_PER_USER - 1);
    await this.opts.db
      .delete(crawlHistory)
      .where(and(eq(crawlHistory.userId, userId), notInArray(crawlHistory.id, keep)));
  }

  /**
   * Names for the refs crawls were recorded with: an API key's id, or
   * `oauth:<clientId>` for a client of this server's OAuth provider. An API
   * key is looked up among the user's own only.
   */
  private async clientNames(
    userId: string,
    refs: ReadonlyArray<string | null>,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const unique = [...new Set(refs.filter((r): r is string => !!r))];
    const oauth = unique.filter((r) => r.startsWith('oauth:')).map((r) => r.slice(6));
    const keys = unique.filter((r) => !r.startsWith('oauth:'));
    if (oauth.length > 0) {
      const rows = await this.opts.db
        .select({ id: oauthClients.id, name: oauthClients.name })
        .from(oauthClients)
        .where(inArray(oauthClients.id, oauth));
      for (const r of rows) names.set(`oauth:${r.id}`, r.name);
    }
    if (keys.length > 0) {
      const rows = await this.opts.db
        .select({ id: apiKeys.id, name: apiKeys.name })
        .from(apiKeys)
        .where(and(inArray(apiKeys.id, keys), eq(apiKeys.userId, userId)));
      for (const r of rows) names.set(r.id, r.name);
    }
    return names;
  }
}
