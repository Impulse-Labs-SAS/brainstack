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
  /** Owner del hit. NULL en self-host. Si != userId, es un hit shared. */
  ownerId: string | null;
}

export interface SearchScope {
  ownerId: string;
  folderPath: string;
}

export interface SearchOptions {
  limit?: number;
  /** Si false, excluye notas del propio user. Default true. */
  includeMine?: boolean;
  /**
   * Lista de (owner, folder) compartidos al user. Los hits dentro de estos
   * scopes se incluyen además de los propios (si includeMine=true).
   * Omitir o pasar [] desactiva la búsqueda cross-owner.
   */
  sharedScopes?: SearchScope[];
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
    const includeMine = options.includeMine ?? true;
    const sharedScopes = options.sharedScopes ?? [];

    if (!hosted) {
      // Self-host: comportamiento previo, sin filtro de owner.
      return this.opts.db.sqlite
        .prepare<unknown[], { path: string; title: string; snippet: string; score: number }>(
          `SELECT path, title,
                  snippet(notes_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet,
                  bm25(notes_fts) AS score
           FROM notes_fts
           WHERE notes_fts MATCH ?
           ORDER BY score LIMIT ?`,
        )
        .all(ftsQuery, limit)
        .map((r) => ({ ...r, ownerId: null }));
    }

    // Hosted: construir WHERE como OR de bloques (mine, shared scopes).
    const params: unknown[] = [ftsQuery];
    const blocks: string[] = [];
    if (includeMine) {
      blocks.push('n.owner_id = ?');
      params.push(userId);
    }
    for (const scope of sharedScopes) {
      blocks.push('(n.owner_id = ? AND n.path LIKE ?)');
      params.push(scope.ownerId, `${scope.ownerId}/${scope.folderPath}/%`);
    }
    if (blocks.length === 0) return [];

    const where = blocks.join(' OR ');
    params.push(limit);

    const sql = `SELECT f.path,
                f.title,
                snippet(notes_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet,
                bm25(notes_fts) AS score,
                n.owner_id AS owner_id
         FROM notes_fts f
         JOIN notes n ON n.path = f.path
         WHERE notes_fts MATCH ? AND (${where})
         ORDER BY score
         LIMIT ?`;

    return this.opts.db.sqlite
      .prepare<
        unknown[],
        { path: string; title: string; snippet: string; score: number; owner_id: string }
      >(sql)
      .all(...params)
      .map((r) => ({
        // Path lógico relativo al owner; el frontend infiere mine/shared
        // viendo si ownerId === userId.
        path: toLogical(r.owner_id, r.path, this.opts.cfg),
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        ownerId: r.owner_id,
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
