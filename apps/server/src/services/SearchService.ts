// Search across a user's own notes and the folders shared with them.
//
// The ranking itself belongs to PgSearchService, which indexes each note twice
// — unstemmed for prefix matching, stemmed for morphology — and querying the
// union of both is what makes Spanish search behave. Nothing here touches that.
//
// What this adds is scope. Hits are restricted to notes the caller may see, and
// paths come back logical, without the owner prefix.

import { PgSearchService, type PgDb } from '@brainstack/core/pg';

import { ownerIdFromPhysicalPath, toLogical } from '../lib/vault.js';

import { normalizeFolderPath, pathFallsUnder } from './SharingService.js';

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  /** Relevance, lower is better. */
  score: number;
  /** Owner of the hit. When it differs from the caller, the hit is shared. */
  ownerId: string;
}

export interface SearchScope {
  ownerId: string;
  folderPath: string;
}

export interface SearchOptions {
  limit?: number;
  /** When false, the caller's own notes are excluded. Defaults to true. */
  includeMine?: boolean;
  /**
   * Folders other people shared with the caller. Hits inside these are included
   * alongside their own. Omitting it turns cross-owner search off.
   */
  sharedScopes?: SearchScope[];
}

export interface SearchServiceOptions {
  db: PgDb;
  search?: PgSearchService;
}

export class SearchService {
  private readonly engine: PgSearchService;

  constructor(opts: SearchServiceOptions) {
    this.engine = opts.search ?? new PgSearchService(opts.db);
  }

  async search(userId: string, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];

    const limit = options.limit ?? 10;
    const includeMine = options.includeMine ?? true;
    const sharedScopes = options.sharedScopes ?? [];
    if (!includeMine && sharedScopes.length === 0) return [];

    // Scope goes into the query, so the ranking only ever sees what the caller
    // may read and `limit` hits of theirs come back however large the database.
    // Every hit is still checked below against the shares it came from: the
    // query narrows, the loop decides.
    const hits = await this.engine.search(trimmed, {
      limit,
      scope: {
        ...(includeMine ? { ownerId: userId } : {}),
        folders: storedFolders(sharedScopes),
      },
    });

    const visible: SearchHit[] = [];
    for (const hit of hits) {
      const ownerId = ownerIdFromPhysicalPath(hit.path);
      if (!ownerId) continue;

      const mine = ownerId === userId;
      if (mine && !includeMine) continue;

      if (!mine) {
        const relative = stripOwner(hit.path, ownerId);
        const shared = sharedScopes.some(
          (s) => s.ownerId === ownerId && pathFallsUnder(relative, s.folderPath),
        );
        if (!shared) continue;
      }

      visible.push({
        path: mine ? toLogical(userId, hit.path) : stripOwner(hit.path, ownerId),
        title: hit.title,
        snippet: hit.snippet,
        score: Number(hit.score),
        ownerId,
      });
    }

    return visible;
  }

  /**
   * How many of the notes the caller may read — their own, and the folders
   * in `sharedScopes` — match each query, in one round trip.
   */
  counts(
    userId: string,
    queries: readonly string[],
    sharedScopes: readonly SearchScope[] = [],
  ): Promise<number[]> {
    return this.engine.counts(queries, {
      ownerId: userId,
      folders: storedFolders(sharedScopes),
    });
  }
}

/**
 * Shared scopes as stored folder paths, owner prefix included, the shape the
 * engine filters on. A scope with no folder stands for the owner's whole vault.
 */
function storedFolders(scopes: readonly SearchScope[]): string[] {
  return scopes.map((s) => {
    const folder = normalizeFolderPath(s.folderPath);
    return folder === '' ? s.ownerId : `${s.ownerId}/${folder}`;
  });
}

/** Drop a known owner prefix. Used for hits belonging to somebody else. */
function stripOwner(physicalPath: string, ownerId: string): string {
  const prefix = `${ownerId}/`;
  return physicalPath.startsWith(prefix) ? physicalPath.slice(prefix.length) : physicalPath;
}
