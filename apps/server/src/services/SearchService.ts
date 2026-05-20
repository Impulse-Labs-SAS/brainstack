// Search over the BrainStack cache. V1 = full-text via FTS5; semantic search
// es V2. La query es sanitised — los callers pueden pasar input crudo.
//
// Owner-aware: en hosted los hits se restringen a notas del user (por
// owner_id en la tabla notes, via JOIN sobre notes_fts.path). En self-host
// no se filtra. Los paths devueltos pasan por toLogical para que el caller
// reciba paths sin prefix.

import type { BrainStackDatabase } from '@brainstack/core';

import { toLogical, type VaultRootResolverConfig } from '../lib/vault.js';

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  /** FTS5 bm25 score (lower is better). */
  score: number;
}

export interface SearchOptions {
  limit?: number;
}

export interface SearchServiceOptions {
  db: BrainStackDatabase;
  cfg: VaultRootResolverConfig;
}

export class SearchService {
  constructor(private readonly opts: SearchServiceOptions) {}

  search(userId: string, query: string, options: SearchOptions = {}): SearchHit[] {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const limit = options.limit ?? 10;
    const ftsQuery = toFtsMatch(trimmed);
    const hosted = this.opts.cfg.deployment === 'hosted';

    const sql = hosted
      ? `SELECT f.path,
                f.title,
                snippet(notes_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet,
                bm25(notes_fts) AS score
         FROM notes_fts f
         JOIN notes n ON n.path = f.path
         WHERE notes_fts MATCH ? AND n.owner_id = ?
         ORDER BY score
         LIMIT ?`
      : `SELECT path,
                title,
                snippet(notes_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet,
                bm25(notes_fts) AS score
         FROM notes_fts
         WHERE notes_fts MATCH ?
         ORDER BY score
         LIMIT ?`;

    const params: unknown[] = hosted ? [ftsQuery, userId, limit] : [ftsQuery, limit];

    const rows = this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; snippet: string; score: number }>(sql)
      .all(...params);

    return rows.map((r) => ({
      path: hosted ? toLogical(userId, r.path, this.opts.cfg) : r.path,
      title: r.title,
      snippet: r.snippet,
      score: r.score,
    }));
  }
}

/** Convert free-form input into a safe FTS5 MATCH expression. */
function toFtsMatch(input: string): string {
  // Tokenise on whitespace, drop FTS metacharacters, and OR-join the terms
  // wrapped as prefix queries to keep search forgiving.
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replace(/["()*:^]/g, '').trim())
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}
