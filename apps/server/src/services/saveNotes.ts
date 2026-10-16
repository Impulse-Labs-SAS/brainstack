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
// Permission is not decided here. The MCP layer asks SharingService about
// every write before calling in, and passes each write's owner.
//
// The answer is a report of what was written, in the order it was, shaped so
// the Sentinel view can one day replay a write the way it replays a read.

import { normalizeRelativePath, type Frontmatter } from '@brainstack/core';
import type { NoteEdit } from '@brainstack/core/sentinel';

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

export async function saveNotes(
  notes: NoteService,
  viewerId: string,
  writes: readonly NoteWrite[],
  /** Told about a failure nobody caused, before the answer turns it into "internal error". */
  onUnexpected: (err: unknown) => void,
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
  const twice = repeatedPaths(writes);
  const checked = await Promise.all(
    writes.map(async (write, i): Promise<{ ok: Checked } | { error: WriteResult['error'] }> => {
      try {
        if (twice.has(i)) {
          throw new AppError(
            `${write.path} is named by more than one write; put every change to it in one edit`,
            'INVALID_INPUT',
            400,
          );
        }
        return { ok: await check(notes, write) };
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

/** Indexes of writes that name a path another write also names, in the same vault. */
function repeatedPaths(writes: readonly NoteWrite[]): Set<number> {
  const seen = new Map<string, number[]>();
  writes.forEach((w, i) => {
    let key: string;
    try {
      key = `${w.owner}\u0000${normalizeRelativePath(w.path)}`;
    } catch {
      return; // an invalid path fails its own check
    }
    seen.set(key, [...(seen.get(key) ?? []), i]);
  });
  return new Set([...seen.values()].filter((at) => at.length > 1).flat());
}

async function check(notes: NoteService, write: NoteWrite): Promise<Checked> {
  switch (write.action) {
    case 'create':
      if (await notes.hasNote(write.owner, write.path)) {
        throw new AppError(`${write.path} already exists`, 'ALREADY_EXISTS', 409);
      }
      return { write };
    case 'edit':
      return {
        write,
        plan: await notes.planEdit(write.owner, write.path, write.edits, {
          ...(write.expectedChecksum ? { expectedChecksum: write.expectedChecksum } : {}),
        }),
      };
    case 'replace': {
      const current = await notes.get(write.owner, write.path);
      if (write.expectedChecksum && write.expectedChecksum !== current.checksum) {
        throw new AppError(
          `${write.path} was changed by someone else since you read it`,
          'CHANGED',
          409,
        );
      }
      return { write, baseChecksum: current.checksum };
    }
    case 'delete':
      // A folder has no row to find; a recursive delete of one is checked by
      // the delete itself, as the delete tool does.
      if (!write.recursive && !(await notes.hasNote(write.owner, write.path))) {
        throw new AppError(`${write.path} does not exist`, 'NOT_FOUND', 404);
      }
      return { write };
  }
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
      return notes.remove(w.owner, w.path, { recursive: w.recursive ?? false });
  }
}
