// The prompt the Sentinel view hands the person: what they asked, the notes
// that answer it, and what is still theirs to settle, as text to paste into an
// assistant or an IDE. Pure, tested directly.
//
// It comes in two formats. "References" lists each note by path, for an
// assistant connected to BrainStack, which opens them itself with get_note;
// a note in a folder somebody shared carries its ownerId, which get_note
// needs. "Full text" carries each note's body, so it works pasted anywhere.
//
// The words around the notes are the product's, so they are English; what the
// notes and the question say stays as their author wrote it.

export type BriefFormat = 'refs' | 'full';

export interface BriefNote {
  path: string;
  /** Set for a note in a folder somebody shared: `path` is then relative to their root. */
  ownerId?: string;
  title: string;
  isDecision: boolean;
  /** Why it is here, in a few words: "matches “GPS”", "linked from Plan". */
  reason: string;
  /** The body, or as much of it as is carried; absent when it could not be read. */
  body?: string;
  /** `body` is not the whole note. */
  truncated?: boolean;
}

/** A reference nothing settled, left for the assistant to ask about. */
export interface BriefQuestion {
  term: string;
  reason: 'no-match' | 'ambiguous';
  candidates?: ReadonlyArray<{ path: string; ownerId?: string; title: string }>;
}

export interface Brief {
  question: string;
  notes: readonly BriefNote[];
  open: readonly BriefQuestion[];
  format: BriefFormat;
}

/**
 * What a brief of fetched bodies carries at most, all notes together: what
 * gather_context hands an assistant by default, so a full-text brief from the
 * history weighs what one from a search just run does.
 */
export const FULL_TEXT_CHARS = 16_000;
/** No note is cut shorter than this, however many share the budget. */
const LEAST_BODY_CHARS = 600;

const OPENING =
  "Here is context from my BrainStack, where I keep my notes, for what I want to do next. Read it before you begin: it holds what I already know and what I have already decided.";

export function buildBrief({ question, notes, open, format }: Brief): string {
  const lines: string[] = [OPENING, '', '## What I want to do', question.trim()];
  const decisions = notes.filter((n) => n.isDecision);
  const rest = notes.filter((n) => !n.isDecision);
  const full = format === 'full';

  if (decisions.length > 0) {
    lines.push('', '## Decisions already made', 'Follow these unless I say otherwise.');
    for (const n of decisions) lines.push(...(full ? fullEntry(n) : [refLine(n)]));
  }
  if (rest.length > 0) {
    lines.push('', full ? '## Notes' : '## Notes to read');
    for (const group of byFolder(rest)) {
      if (!full && group.heading) lines.push(group.heading);
      for (const n of group.notes) lines.push(...(full ? fullEntry(n) : [refLine(n)]));
    }
  }
  if (notes.length === 0) lines.push('', 'None of my notes matched this.');
  if (open.length > 0) {
    lines.push('', '## Ask me before assuming');
    for (const q of open) lines.push(questionLine(q));
  }

  const closing = full
    ? notes.some((n) => n.truncated || n.body === undefined)
      ? 'Where a note ends in "…" it was cut. Ask me for the rest if you need it.'
      : null
    : notes.length > 0
      ? notes.some((n) => n.ownerId)
        ? 'Open each note with the BrainStack get_note tool, by its path, and its ownerId where it has one, before you propose anything.'
        : 'Open each note with the BrainStack get_note tool, by its path, before you propose anything.'
      : null;
  if (closing) lines.push('', closing);
  return lines.join('\n');
}

/**
 * A title, path, reason or term on one line. They come from notes, and a
 * note in a shared folder is somebody else's: a line break in a title would
 * let it write lines into the prompt that read as the person's own. Bodies
 * need nothing of the kind — they sit in a fence their text cannot close.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function refLine(n: BriefNote): string {
  return `- ${oneLine(n.title)} (${oneLine(n.path)}${n.ownerId ? `, ownerId: ${oneLine(n.ownerId)}` : ''})`;
}

function fullEntry(n: BriefNote): string[] {
  const head = ['', `### ${oneLine(n.title)}`, `${oneLine(n.path)} · ${oneLine(n.reason)}`];
  if (n.body === undefined) return [...head, '(This note could not be read. Ask me for it if you need it.)'];
  const body = n.truncated && !n.body.endsWith('…') ? `${n.body}…` : n.body;
  const fence = fenceFor(body);
  return [...head, '', `${fence}markdown`, body, fence];
}

/** Three backticks, or one more than the longest run in `text`: a fence its own text cannot close. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function questionLine(q: BriefQuestion): string {
  const term = oneLine(q.term);
  if (q.reason === 'ambiguous' && q.candidates && q.candidates.length > 0) {
    const paths = q.candidates.map((c) => oneLine(c.path)).join(', ');
    return `- "${term}": ${q.candidates.length} of my notes have that title (${paths}). Ask me which one I mean.`;
  }
  return `- "${term}": none of my notes covers it. Ask me what I have in mind.`;
}

export interface FolderGroup<T> {
  /** One per folder and owner. */
  key: string;
  folder: string;
  ownerId?: string;
  /** "Projects/Atlas/", "Clients/ (shared with me)"; null for notes at the top of one's own vault. */
  heading: string | null;
  notes: T[];
}

/**
 * Notes by folder, in the order their first note comes. A shared folder is
 * its owner's: two vaults may both hold `Plans/`, so the owner is part of
 * the key. Notes at the top of one's own vault come first, under no heading.
 */
export function byFolder<T extends { path: string; ownerId?: string }>(
  notes: readonly T[],
): Array<FolderGroup<T>> {
  const groups = new Map<string, FolderGroup<T>>();
  for (const n of notes) {
    const folder = folderOf(n.path);
    const key = `${n.ownerId ?? ''}\u0000${folder}`;
    let g = groups.get(key);
    if (!g) {
      const heading = folder
        ? `${oneLine(folder)}/${n.ownerId ? ' (shared with me)' : ''}`
        : n.ownerId
          ? '(shared with me)'
          : null;
      g = { key, folder, ...(n.ownerId ? { ownerId: n.ownerId } : {}), heading, notes: [] };
      groups.set(key, g);
    }
    g.notes.push(n);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.heading === null), ...all.filter((g) => g.heading !== null)];
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Roughly how many tokens `text` costs a model: four characters each, near enough to judge a paste by. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** "~840 tokens", "~3.2k tokens". */
export function tokensLabel(text: string): string {
  const t = approxTokens(text);
  return `~${t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t} tokens`;
}

/** How much of each fetched body a full-text brief of `count` notes carries. */
export function bodyShare(count: number): number {
  return Math.max(LEAST_BODY_CHARS, Math.floor(FULL_TEXT_CHARS / Math.max(1, count)));
}

/**
 * The body cut at a word boundary to at most `max` characters, as the engine
 * cuts its excerpts: whitespace kept (it is Markdown), never half an emoji.
 */
export function cutBody(body: string, max: number): { text: string; truncated: boolean } {
  const trimmed = body.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  let cut = trimmed.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const lastSpace = cut.search(/\s\S*$/);
  const text = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return { text: `${text}…`, truncated: true };
}
