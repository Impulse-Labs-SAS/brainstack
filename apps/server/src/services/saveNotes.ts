// save_notes: Sentinel's writing, as BrainStack runs it — several writes in
// one call.
//
// An assistant that has decided to create two notes, link them from their
// index and adjust three others used to spend one round trip per write, each a
// full turn of the model. Here the whole plan arrives at once and is checked
// before anything is written: every path is valid and named once, every note
// to change exists, every edit's anchor is there, every checksum is current.
// One failure and nothing is written — the answer says which writes would
// have failed and why, so the plan can be fixed and sent again whole.
//
// There is no transaction to make the writes themselves atomic (the Neon HTTP
// driver has none). They run in the order given, and an edit lands only on the
// version it was checked against; if one still fails — somebody saved that
// note a moment ago — the writes before it stay, the rest do not run, and the
// answer says exactly that.
//
// With `maxChars`, a write may not leave a note longer than that unless it was
// already longer and does not grow (core's size.ts says why). Refused, it says
// how to split the note, because that is what the caller has to do next.
//
// Permission is not decided here. The MCP layer asks SharingService about
// every write before calling in, and passes each write's owner.
//
// The answer is a report of what was written, in the order it was, shaped so
// the Sentinel view can one day replay a write the way it replays a read.

import { extractFrontmatter, normalizeRelativePath, type Frontmatter } from '@brainstack/core';
import {
  fitsNoteLimit,
  HOW_TO_SPLIT,
  noteSize,
  type NoteEdit,
  type NoteSize,
} from '@brainstack/core/sentinel';

import { AppError, describeError, toAppError } from '../lib/errors.js';

import type { NoteService, PlannedEdit } from './NoteService.js';

/** Writes accepted in one call, at most. */
export const MAX_WRITES = 25;

interface Owned {
  path: string;
  /** Whose vault the write is in, as the caller's permission was checked for it. */
  owner: string;
}

export type NoteWrite = Owned &
  (
    | { action: 'create'; content: string; frontmatter?: Frontmatter }
    | { action: 'edit'; edits: NoteEdit[]; expectedChecksum?: string }
    | { action: 'replace'; content: string; expectedChecksum?: string }
    | { action: 'delete'; recursive?: boolean }
  );

export interface WriteResult {
  action: NoteWrite['action'];
  /** Set only for a write in somebody else's vault: a folder they shared. */
  ownerId?: string;
  path: string;
  /**
   * `done` landed; `failed` was tried, or would have failed, and says why in
   * `error`; `skipped` did not run because another write failed.
   */
  status: 'done' | 'failed' | 'skipped';
  error?: { code: string; message: string };
  /** The note's new version, for a later edit's `expectedChecksum`. */
  checksum?: string;
  /** For a create: the `_<Folder>.md` index notes above it, to link it from. */
  affectedMocs?: string[];
  /** For a delete: what is gone. */
  deleted?: string[];
  deletedFolders?: string[];
}

export interface WriteReport {
  /** True when every write landed. */
  saved: boolean;
  results: WriteResult[];
}

/** What phase one learnt, for phase two to write without asking again. */
type Checked = { write: NoteWrite; plan?: PlannedEdit; baseChecksum?: string };

export interface SaveOptions {
  /** Told about a failure nobody caused, before the answer turns it into "internal error". */
  onUnexpected: (err: unknown) => void;
  /** Characters a note's body may reach; unset, notes may be any length the input limits allow. */
  maxChars?: number;
}

export async function saveNotes(
  notes: NoteService,
  viewerId: string,
  writes: readonly NoteWrite[],
  { onUnexpected, maxChars }: SaveOptions,
): Promise<WriteReport> {
  if (writes.length > MAX_WRITES) {
    throw new AppError(
      `at most ${MAX_WRITES} writes per call; got ${writes.length}`,
      'INVALID_INPUT',
      400,
    );
  }
  const head = (w: NoteWrite): WriteResult => ({
    action: w.action,
    ...(w.owner !== viewerId ? { ownerId: w.owner } : {}),
    path: w.path,
    status: 'skipped',
  });
  const failure = (err: unknown) => {
    if (!toAppError(err)) onUnexpected(err);
    return describeError(err);
  };

  // -- Phase one: check everything, write nothing ---------------------------
  const clashes = conflicts(writes);
  const checked = await Promise.all(
    writes.map(async (write, i): Promise<{ ok: Checked } | { error: WriteResult['error'] }> => {
      try {
        const clash = clashes.get(i);
        if (clash) throw new AppError(clash, 'INVALID_INPUT', 400);
        return { ok: await check(notes, write, maxChars) };
      } catch (err) {
        return { error: failure(err) };
      }
    }),
  );
  if (checked.some((c) => 'error' in c)) {
    return {
      saved: false,
      results: writes.map((w, i) => {
        const c = checked[i]!;
        return 'error' in c ? { ...head(w), status: 'failed', error: c.error } : head(w);
      }),
    };
  }

  // -- Phase two: write, in order --------------------------------------------
  const results = writes.map(head);
  for (const [i, c] of checked.entries()) {
    const { ok } = c as { ok: Checked };
    try {
      results[i] = { ...results[i]!, status: 'done', ...(await write(notes, ok)) };
    } catch (err) {
      results[i] = { ...results[i]!, status: 'failed', error: failure(err) };
      return { saved: false, results };
    }
  }
  return { saved: true, results };
}

/**
 * Writes that would trip over another write in the same call, by index, with
 * why: two writes to one path, or a write inside a folder another write
 * deletes. Checked against the store one by one, each would pass; written in
 * order, the second would find its note changed or gone, after the first had
 * already landed.
 */
function conflicts(writes: readonly NoteWrite[]): Map<number, string> {
  const placed = writes.map((w) => {
    try {
      return { owner: w.owner, path: normalizeRelativePath(w.path) };
    } catch {
      return null; // an invalid path fails its own check
    }
  });
  const out = new Map<number, string>();
  placed.forEach((a, i) => {
    if (!a) return;
    placed.forEach((b, j) => {
      if (!b || i === j || a.owner !== b.owner) return;
      if (a.path === b.path) {
        out.set(
          i,
          `${writes[i]!.path} is named by more than one write; put every change to it in one edit`,
        );
        return;
      }
      const other = writes[j]!;
      if (other.action === 'delete' && other.recursive && a.path.startsWith(`${b.path}/`)) {
        out.set(i, `${writes[i]!.path} is inside ${other.path}, which write ${j + 1} deletes`);
      }
    });
  });
  return out;
}

async function check(
  notes: NoteService,
  write: NoteWrite,
  maxChars: number | undefined,
): Promise<Checked> {
  normalizeRelativePath(write.path); // an empty or climbing path is refused before any lookup
  const limit = (after: NoteSize, before?: NoteSize) => {
    if (maxChars !== undefined && !fitsNoteLimit(after, before, maxChars)) {
      throw tooLong(write.path, after, before, maxChars);
    }
  };
  switch (write.action) {
    case 'create':
      // With a frontmatter argument the content is stored whole as the body,
      // a block of its own included; without one, its block is split off.
      limit(noteSize(write.frontmatter ? write.content : extractFrontmatter(write.content).body));
      if (await notes.hasNote(write.owner, write.path)) {
        throw new AppError(`${write.path} already exists`, 'ALREADY_EXISTS', 409);
      }
      return { write };
    case 'edit': {
      const plan = await notes.planEdit(write.owner, write.path, write.edits, {
        ...(write.expectedChecksum ? { expectedChecksum: write.expectedChecksum } : {}),
      });
      limit(plan.size.after, plan.size.before);
      return { write, plan };
    }
    case 'replace': {
      const current = await notes.get(write.owner, write.path);
      // A stale read first: the size is judged against the version the caller
      // read, and a caller working from an old one needs to hear that.
      if (write.expectedChecksum && write.expectedChecksum !== current.checksum) {
        throw new AppError(
          `${write.path} was changed by someone else since you read it`,
          'CHANGED',
          409,
        );
      }
      limit(noteSize(extractFrontmatter(write.content).body), noteSize(current.body));
      return { write, baseChecksum: current.checksum };
    }
    case 'delete': {
      // A recursive delete may name a folder, which `exists` answers for too.
      const found = write.recursive
        ? await notes.exists(write.owner, write.path)
        : await notes.hasNote(write.owner, write.path);
      if (!found) throw new AppError(`${write.path} does not exist`, 'NOT_FOUND', 404);
      return { write };
    }
  }
}

/** The refusal, with what to do instead: the caller's next step is to split the note. */
function tooLong(
  path: string,
  after: NoteSize,
  before: NoteSize | undefined,
  max: number,
): AppError {
  const was =
    before && before.chars > max
      ? ` It is already ${before.chars} characters, past the limit: a change may shrink it but not grow it.`
      : '';
  return new AppError(
    `${path} would be ${after.chars} characters (${after.lines} lines); a note an assistant ` +
      `writes stays within ${max}, so that it always reaches an assistant whole.${was} ` +
      HOW_TO_SPLIT,
    'TOO_LONG',
    413,
  );
}

async function write(notes: NoteService, { write: w, plan, baseChecksum }: Checked) {
  switch (w.action) {
    case 'create': {
      const r = await notes.create(w.owner, w.path, w.content, w.frontmatter);
      return { path: r.path, checksum: r.checksum, affectedMocs: r.affectedMocs };
    }
    case 'edit':
      return notes.writePlanned(w.owner, plan!);
    case 'replace':
      return notes.update(w.owner, w.path, w.content, { expectedChecksum: baseChecksum! });
    case 'delete':
      // The path as the store names it, like every other write's: a `./` or a
      // trailing slash the caller typed is not what was deleted.
      return {
        path: normalizeRelativePath(w.path),
        ...(await notes.remove(w.owner, w.path, { recursive: w.recursive ?? false })),
      };
  }
}
