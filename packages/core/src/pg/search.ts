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

import { sql, type SQL } from 'drizzle-orm';

import type { PgDb } from './client.js';
import { escapeLike } from './notes.js';
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
  /**
   * The notes the search may rank: one owner's vault, plus any `folders` —
   * stored folder paths, owner prefix included — such as those shared with
   * the reader. Applied inside the query, so a caller whose notes are a small
   * slice of a large database still gets `limit` hits of their own, instead
   * of the top of every vault filtered down afterwards. Omitted, the search
   * runs over every note in the store.
   */
  scope?: SearchScope;
}

/** Which notes a search or a count may look at. See `SearchOptions.scope`. */
export interface SearchScope {
  /** Whose vault to include whole. Omitted, only `folders` are searched. */
  ownerId?: string;
  folders?: readonly string[];
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
    const readable = options.scope ? readableFilter(options.scope) : sql`TRUE`;
    if (readable === null) return [];

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
      WHERE (${readable})
        AND n.body_tsv @@ (${prefixTsq} || ${stemTsq})
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

  /**
   * How many of one owner's notes match each query, with the same matching as
   * `search`, in one round trip: it is how rare each word is in a vault. A
   * ranking that weighs a word everywhere less than a word in three notes
   * needs these counts, which `search` — ranked, capped, across every vault —
   * cannot give. A query with nothing to search counts 0.
   *
   * Counted over one owner's notes plus any `folders` — stored folder paths,
   * owner prefix included — such as those shared with the reader. It is a
   * count, not rows anyone sees; each folder still goes through `escapeLike`,
   * so a name with `%` or `_` cannot widen it into a neighbour.
   */
  async counts(queries: readonly string[], scope: SearchScope): Promise<number[]> {
    const tokenized = queries.map(tokenize);
    const searchable = tokenized.flatMap((tokens, i) => (tokens.length > 0 ? [{ i, tokens }] : []));
    const out = queries.map(() => 0);
    const readable = readableFilter(scope);
    if (searchable.length === 0 || readable === null) return out;

    const array = (items: string[]) =>
      sql`ARRAY[${sql.join(
        items.map((x) => sql`${x}`),
        sql`, `,
      )}]::text[]`;
    const prefix = array(searchable.map(({ tokens }) => tokens.map((t) => `${t}:*`).join(' | ')));
    const stem = array(searchable.map(({ tokens }) => tokens.join(' | ')));
    const result = await this.db.execute<{ ord: number | string; n: number | string }>(sql`
      SELECT q.ord, count(n.path) AS n
      FROM unnest(${prefix}, ${stem}) WITH ORDINALITY AS q(p, s, ord)
      LEFT JOIN notes n
        ON (${readable})
       AND n.body_tsv @@ (to_tsquery(${PREFIX_CONFIG}::regconfig, q.p)
                          || to_tsquery(${STEM_CONFIG}::regconfig, q.s))
      GROUP BY q.ord
    `);
    for (const row of result.rows) {
      out[searchable[Number(row.ord) - 1]!.i] = Number(row.n);
    }
    return out;
  }
}

/**
 * The SQL condition a scope stands for, or `null` when it covers nothing.
 * Each folder goes through `escapeLike`, so a name with `%` or `_` cannot widen
 * it into a neighbour. It narrows the query; callers that show rows still
 * re-check each one in memory against the shares it came from.
 */
function readableFilter(scope: SearchScope): SQL | null {
  const parts = [
    ...(scope.ownerId === undefined ? [] : [sql`n.owner_id = ${scope.ownerId}`]),
    ...(scope.folders ?? []).map((f) => sql`n.path LIKE ${`${escapeLike(f)}/%`}`),
  ];
  return parts.length === 0 ? null : sql.join(parts, sql` OR `);
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
    // Operators out, and control characters with them: Postgres refuses a NUL
    // in text, which failed the whole query instead of matching nothing.
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .map((t) => t.replace(/[&|!():*'"\\<>\u0000-\u001f\u007f]/g, '').trim())
    .filter(Boolean);
}

/** The prefix half of the query, exposed for tests and debugging. */
export function toTsQuery(input: string): string {
  const tokens = tokenize(input);
  return tokens.length === 0 ? '' : tokens.map((t) => `${t}:*`).join(' | ');
}
