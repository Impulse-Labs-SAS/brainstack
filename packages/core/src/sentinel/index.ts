// Sentinel — BrainStack's engine for working with notes: it reads (the
// context behind `gather_context` and every search) and writes (edits that say
// what changes instead of resending a note whole). It is part of BrainStack,
// not a product of its own; the entry point `@brainstack/core/sentinel` only
// keeps it in one place.

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
  MAX_LINK,
  MAX_MAX_CHARS,
  describeVia,
  type ContextNote,
  type ContextVia,
  type Digest,
  type LeftOutNote,
} from './score.js';
export {
  DEFAULT_SEARCH_HITS,
  MAX_SEARCH_HITS,
  searchNotes,
  type SearchHit,
  type SearchInput,
} from './search.js';
export { type NameEntry } from './names.js';
export { placeNote, type PlaceInput, type PlaceResult, type PlacedFolder } from './place.js';
export { NOTE_MAX_CHARS, fitsNoteLimit, noteSize, type NoteSize } from './size.js';
export {
  MAX_EDITS,
  NoteEditError,
  applyEdits,
  listSections,
  outline,
  type NoteEdit,
  type Section,
} from './edit.js';
