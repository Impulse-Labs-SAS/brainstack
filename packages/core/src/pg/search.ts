// Full-text search over the Postgres store.
//
// Postgres equivalent of the old FTS5 query, kept deliberately close to it:
//   MATCH        -> @@ tsquery
//   snippet()    -> ts_headline
//   bm25()       -> ts_rank  (note the direction flips, see `score` below)
//
// The query side mirrors how the vector is built (see `migrations.ts`): an
// unstemmed prefix query and a stemmed exact query. The first keeps half-typed
// words working like FTS5 did; the second means "notas" also finds "nota".
// Neither alone is enough — stemming mangles prefixes, and prefixes miss
// morphology — but they must be applied side by side rather than OR'd into one
// tsquery. See the comment in `search` for why.

import { sql } from 'drizzle-orm';

import type { PgDb } from './client.js';
import { PREFIX_CONFIG, STEM_CONFIG } from './schema.js';

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  /** ts_rank score. Unlike bm25, **higher is better**. */
  score: number;
}

export interface SearchOptions {
  limit?: number;
}

/** Raw shape coming back from `db.execute`, which requires an index signature. */
interface SearchRow extends Record<string, unknown> {
  path: string;
  title: string;
  snippet: string;
  score: number | string;
}

export class PgSearchService {
  constructor(private readonly db: PgDb) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const limit = Math.min(options.limit ?? 10, 50);

    const prefixQuery = tokens.map((t) => `${t}:*`).join(' | ');
    const stemQuery = tokens.join(' | ');

    // The two halves are kept apart rather than OR'd into one tsquery, because
    // ranking and highlighting both break on the union:
    //
    //  - `ts_rank` over `prefix | stem` returns exactly 0 whenever only one side
    //    matches — which is the normal case for a half-typed word. Results still
    //    come back, but unranked, so ordering degrades to whatever is newest.
    //  - `ts_headline` parses the document with one config, so a query carrying
    //    lexemes from the other never highlights.
    //
    // Scoring each half and taking the best preserves the rank; highlighting
    // with the config that produced the match preserves the snippet.
    const prefixTsq = sql`to_tsquery(${PREFIX_CONFIG}::regconfig, ${prefixQuery})`;
    const stemTsq = sql`to_tsquery(${STEM_CONFIG}::regconfig, ${stemQuery})`;
    const headlineOpts =
      'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=12, ShortWord=2, MaxFragments=1';

    const result = await this.db.execute<SearchRow>(sql`
      SELECT n.path,
             n.title,
             -- Prefer the half that actually highlighted something; a note found
             -- by stem alone gets no marks from the unstemmed headline.
             CASE
               WHEN h.prefix_snippet LIKE '%<mark>%' THEN h.prefix_snippet
               ELSE h.stem_snippet
             END AS snippet,
             greatest(ts_rank(n.body_tsv, ${prefixTsq}), ts_rank(n.body_tsv, ${stemTsq})) AS score
      FROM notes n,
      LATERAL (
        SELECT
          ts_headline(${PREFIX_CONFIG}::regconfig, n.body, ${prefixTsq}, ${headlineOpts})
            AS prefix_snippet,
          ts_headline(${STEM_CONFIG}::regconfig, n.body, ${stemTsq}, ${headlineOpts})
            AS stem_snippet
      ) h
      WHERE n.body_tsv @@ (${prefixTsq} || ${stemTsq})
      ORDER BY score DESC, n.updated_at DESC
      LIMIT ${limit}
    `);

    return result.rows.map((r) => ({
      path: r.path,
      title: r.title,
      snippet: r.snippet,
      score: Number(r.score),
    }));
  }
}

/**
 * Split free-form input into safe tsquery terms.
 *
 * Every tsquery metacharacter (`& | ! ( ) : * ' "`) is stripped before we add
 * `:*` ourselves, so user input can never inject operators — the tokens are the
 * only thing that reaches `to_tsquery`.
 */
export function tokenize(input: string): string[] {
  return input
    .split(/\s+/)
    .map((t) => t.replace(/[&|!():*'"\\<>]/g, '').trim())
    .filter(Boolean);
}

/** The prefix half of the query, exposed for tests and debugging. */
export function toTsQuery(input: string): string {
  const tokens = tokenize(input);
  return tokens.length === 0 ? '' : tokens.map((t) => `${t}:*`).join(' | ');
}
