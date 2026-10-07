// Sentinel — the context engine behind `gather_context`. Its own entry point,
// `@brainstack/core/sentinel`, so it can leave this package for its own the
// day a second system uses it.

export {
  crawlContext,
  MAX_DEPTH,
  MAX_TERMS,
  MAX_TEXT_CHARS,
  type ContextSource,
  type GatherContextInput,
  type GatherContextResult,
  type UnresolvedReference,
} from './crawl.js';
export {
  DEFAULT_MAX_CHARS,
  MAX_MAX_CHARS,
  describeVia,
  type ContextNote,
  type ContextVia,
  type Digest,
  type LeftOutNote,
} from './score.js';
