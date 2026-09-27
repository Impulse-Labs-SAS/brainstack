// @brainstack/core — public API.
//
// Framework-agnostic primitives for parsing, resolving and rewriting the
// BrainStack markdown brain. Higher layers (apps/server, packages/skill) import
// from here only.
//
// Storage is not here: it lives behind the `/pg` subpath, because Postgres is
// the source of truth and nothing above this package should be able to reach
// for a filesystem that no longer exists.

export type {
  Frontmatter,
  LinkKind,
  LinkTargetType,
  NoteRow,
  ParsedFacet,
  ParsedLink,
  ParsedNote,
  ResolvedLink,
} from './types.js';

// --- Paths -------------------------------------------------------------------
export {
  PathTraversalError,
  normalizeNoteKey,
  normalizeRelativePath,
  toPosixPath,
} from './paths.js';

// --- Links -------------------------------------------------------------------
export {
  rewriteLinkTargets,
  type LinkRewriteMapping,
  type NoteBodySource,
  type RewriteResult,
} from './links/rewrite-links.js';
export { linkSnippet } from './links/snippet.js';
export {
  findMentions,
  foldForMatch,
  linkMentions,
  mentionSnippet,
  mentionTerms,
  MIN_MENTION_LENGTH,
  type Mention,
  type MentionCandidate,
  type MentionTerm,
} from './links/mentions.js';

// --- Parser ------------------------------------------------------------------
export {
  buildCodeMask,
  extractFacets,
  extractFrontmatter,
  extractLinks,
  extractTags,
  FACET_SKIP_KEYS,
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

export const CORE_PACKAGE_VERSION = '0.1.0';
