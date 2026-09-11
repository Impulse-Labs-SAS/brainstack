// @brainstack/core/pg — Postgres store.
//
// The source of truth for notes, links and tags. Everything here is async: the
// Neon HTTP driver has no synchronous API, and no interactive transactions.

export {
  openPgDatabase,
  runPgMigrations,
  ensurePgSchema,
  type BrainStackPgDatabase,
  type PgDb,
} from './client.js';
export { pgMigrations, type PgMigration } from './migrations.js';

export * as pgSchema from './schema.js';
export {
  normalizeNoteKey,
  normalizeRelativePath,
  toPosixPath,
  PathTraversalError,
} from '../paths.js';
export { PREFIX_CONFIG, STEM_CONFIG } from './schema.js';
export {
  NoteAlreadyExistsError as PgNoteAlreadyExistsError,
  NoteNotFoundError as PgNoteNotFoundError,
  PgNoteStore,
  toMarkdown,
  type Backlink,
  type Facet,
  type ListFilter,
  type NoteSummary,
  type StoredNote,
} from './notes.js';
export {
  PgSearchService,
  tokenize,
  toTsQuery,
  type SearchHit as PgSearchHit,
  type SearchOptions as PgSearchOptions,
} from './search.js';
