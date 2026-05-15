// Search over the BrainStack cache. V1 = full-text via FTS5; semantic search
// is V2. The query is sanitised so callers can hand us raw user input.

import type { BrainStackDatabase } from '@brainstack/core';

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

export class SearchService {
  constructor(private readonly db: BrainStackDatabase) {}

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const limit = options.limit ?? 10;

    const ftsQuery = toFtsMatch(trimmed);
    return this.db.sqlite
      .prepare<[string, number], { path: string; title: string; snippet: string; score: number }>(
        `SELECT path,
                title,
                snippet(notes_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet,
                bm25(notes_fts) AS score
         FROM notes_fts
         WHERE notes_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(ftsQuery, limit);
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
