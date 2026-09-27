// @brainstack/core/pg — Postgres store.
//
// The source of truth for notes, links and tags. Everything here is async, and
// nothing opens a transaction: the Neon HTTP driver, one of the two it runs on,
// has neither a synchronous API nor interactive transactions.

export {
  openPgDatabase,
  pgDriverFor,
  runPgMigrations,
  ensurePgSchema,
  type BrainStackPgDatabase,
  type PgDb,
  type PgDriver,
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
  escapeLike,
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
