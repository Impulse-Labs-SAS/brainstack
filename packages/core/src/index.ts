// @brainstack/core — public API.
//
// Framework-agnostic primitives for parsing, resolving, storing, and watching
// the BrainStack markdown brain. Higher layers (apps/server, packages/skill)
// import from here only.

export type {
  AttachmentRow,
  Frontmatter,
  LinkKind,
  LinkTargetType,
  NoteRow,
  ParsedLink,
  ParsedNote,
  ResolvedLink,
} from './types.js';

// --- Database ----------------------------------------------------------------
export {
  openDatabase,
  runMigrations,
  type BrainStackDatabase,
  type DrizzleDb,
  type OpenDatabaseOptions,
} from './db/client.js';
export * as schema from './db/schema.js';
export { migrations, type Migration } from './db/migrations/index.js';

// --- Filesystem --------------------------------------------------------------
export {
  PathTraversalError,
  relativeToRoot,
  safeResolve,
  toPosixPath,
} from './fs/paths.js';
export {
  FolderNotEmptyError,
  NoteAlreadyExistsError,
  NoteNotFoundError,
  createFolder,
  deleteNote,
  deletePath,
  listFolders,
  listNoteFiles,
  moveNote,
  movePath,
  readNote,
  writeNote,
  type ReadNoteResult,
  type WriteNoteOptions,
} from './fs/notes.js';
export {
  ATTACHMENTS_DIR,
  listAttachments,
  readAttachment,
  writeAttachment,
  type AttachmentInfo,
} from './fs/attachments.js';
export {
  rewriteLinkTargets,
  type LinkRewriteMapping,
  type RewriteResult,
} from './fs/rewrite-links.js';

// --- Parser ------------------------------------------------------------------
export {
  buildCodeMask,
  extractFrontmatter,
  extractLinks,
  extractTags,
  parseNote,
  type ParseNoteOptions,
} from './parser/index.js';

// --- Resolver ----------------------------------------------------------------
export {
  resolveLink,
  resolveLinks,
  type ResolutionInputs,
  type ResolutionResult,
} from './resolver/wikilinks.js';

// --- Indexer / Watcher -------------------------------------------------------
export {
  bootstrapIndex,
  ensureRootExists,
  reindexFile,
  removeFromIndex,
  type BootstrapResult,
  type ReindexResult,
} from './indexer/bootstrap.js';
export {
  startWatcher,
  type WatcherEvent,
  type WatcherHandle,
  type WatcherOptions,
} from './indexer/watcher.js';

export const CORE_PACKAGE_VERSION = '0.1.0';
