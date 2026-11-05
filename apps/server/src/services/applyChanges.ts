// apply_changes: Sentinel's writing, as BrainStack runs it — a plan of
// changes in one call.
//
// An assistant that has decided to rename a folder, create two notes in it,
// link them from its index and adjust three others used to spend one round
// trip per step, each a full turn of the model, and then read the vault again
// to learn what the moves had done. Here the whole plan arrives at once and is
// checked before anything is written. One failure and nothing is written —
// the answer says which changes would have failed and why, so the plan can be
// fixed and sent again whole.
//
// What a plan means — the order, what each change finds where the ones before
// it left things, which note each change writes — is Sentinel's
// (`@brainstack/core/sentinel`, plan.ts). This file runs it against the store:
// it answers the planner's lookups, checks each edit's anchors and each note's
// size against its stored body, and writes.
//
// There is no transaction to make the writes themselves atomic (the Neon HTTP
// driver has none). They run in order, and an edit lands only on the version
// it was checked against — or, when a move earlier in the same plan rewrote
// the note's links, on the version that move left, the edit's anchors checked
// again. If one still fails — somebody saved that note a moment ago — the
// changes before it stay, the rest do not run, and the answer says exactly
// that.
//
// With `maxChars`, a write may not leave a note longer than that unless it was
// already longer and does not grow (core's size.ts says why). Refused, it says
// how to split the note, because that is what the caller has to do next.
//
// Permission is not decided here. The MCP layer asks SharingService about
// every change before calling in, and passes each change's owner. Moving
// notes into another vault is not a change this accepts: that gives them
// away, and is put to the person on its own (`move_to_owner`).
//
// The answer is a report of what was done, in order, with the state it left:
// each note's final path and checksum, what every move moved and whose links
// it rewrote — so the assistant does not have to read again to know.

import { extractFrontmatter, normalizeRelativePath, type Frontmatter } from '@brainstack/core';
import {
  ChangePlan,
  fitsNoteLimit,
  HOW_TO_SPLIT,
  noteSize,
  summarizeChanges,
  touchedByMoves,
  type NoteEdit,
  type NoteSize,
} from '@brainstack/core/sentinel';

import { AppError, describeError, toAppError } from '../lib/errors.js';

import type { NoteService, PlannedEdit } from './NoteService.js';

/** Changes accepted in one call, at most. */
export const MAX_CHANGES = 25;

interface Owned {
  /** For a move, where it moves from. */
  path: string;
  /** Whose vault the change is in, as the caller's permission was checked for it. */
  owner: string;
}

export type Change = Owned &
  (
    | { action: 'create'; content: string; frontmatter?: Frontmatter }
    | { action: 'edit'; edits: NoteEdit[]; expectedChecksum?: string }
    | { action: 'replace'; content: string; expectedChecksum?: string }
    | { action: 'delete'; recursive?: boolean }
    | { action: 'create_folder' }
    | { action: 'move'; to: string }
  );

export interface ChangeResult {
  action: Change['action'];
  /** Set only for a change in somebody else's vault: a folder they shared. */
  ownerId?: string;
  /** Where the change left things: a move's destination, a create's final path. */
  path: string;
  /** For a move: where it moved from. */
  from?: string;
  /**
   * `done` landed; `failed` was tried, or would have failed, and says why in
   * `error`; `skipped` did not run because another change failed.
   */
  status: 'done' | 'failed' | 'skipped';
  error?: { code: string; message: string };
  /** The note's new version, for a later edit's `expectedChecksum`. */
  checksum?: string;
  /** For a create or a move: the `_<Folder>.md` index notes above it, to link it from. */
  affectedMocs?: string[];
  /** For a delete: what is gone. */
  deleted?: string[];
  deletedFolders?: string[];
  /** For a move: each note that changed path, with its checksum. A folder's index follows its name. */
  moved?: Array<{ from: string; to: string; checksum?: string }>;
  /** For a move: the notes whose wikilinks were rewritten to follow it. */
  linksRewritten?: string[];
}

export interface ChangeReport {
  /** True when every change landed. */
  saved: boolean;
  results: ChangeResult[];
  /**
   * Notes the plan changed without naming them — a move rewrote their links —
   * with their checksum now, so a later edit does not fail as CHANGED.
   */
  touched: Array<{ path: string; checksum: string; ownerId?: string }>;
  /** One line on what was done. */
  summary: string;
}

/** What phase one learnt, for phase two to write without asking again. */
type Checked = { change: Change; plan?: PlannedEdit; baseChecksum?: string };

export interface ApplyOptions {
  /** Told about a failure nobody caused, before the answer turns it into "internal error". */
  onUnexpected: (err: unknown) => void;
  /** Characters a note's body may reach; unset, notes may be any length the input limits allow. */
  maxChars?: number;
}

export async function applyChanges(
  notes: NoteService,
  viewerId: string,
  changes: readonly Change[],
  { onUnexpected, maxChars }: ApplyOptions,
): Promise<ChangeReport> {
  if (changes.length > MAX_CHANGES) {
    throw new AppError(
      `at most ${MAX_CHANGES} changes per call; got ${changes.length}`,
      'INVALID_INPUT',
      400,
    );
  }
  const head = (c: Change): ChangeResult => ({
    action: c.action,
    ...(c.owner !== viewerId ? { ownerId: c.owner } : {}),
    ...(c.action === 'move' ? { from: c.path, path: c.to } : { path: c.path }),
    status: 'skipped',
  });
  const failure = (err: unknown) => {
    if (!toAppError(err)) onUnexpected(err);
    return describeError(err);
  };

  // -- Phase one: check everything, in order, write nothing -----------------
  const plan = new ChangePlan(notes);
  const checked: Array<{ ok: Checked } | { error: ChangeResult['error'] }> = [];
  for (const [i, change] of changes.entries()) {
    try {
      checked.push({ ok: await check(notes, plan, change, i, maxChars) });
    } catch (err) {
      checked.push({ error: failure(err) });
    }
  }
  if (checked.some((c) => 'error' in c)) {
    const results = changes.map((c, i): ChangeResult => {
      const r = checked[i]!;
      return 'error' in r ? { ...head(c), status: 'failed', error: r.error } : head(c);
    });
    return { saved: false, results, touched: [], summary: summarizeChanges(results) };
  }

  // -- Phase two: write, in order --------------------------------------------
  const results = changes.map(head);
  // Notes a move in this plan has moved or rewritten, by owner and path: an
  // edit of one is planned again on the version the move left.
  const shifted = new Set<string>();
  let saved = true;
  for (const [i, c] of checked.entries()) {
    const { ok } = c as { ok: Checked };
    try {
      const done = await write(notes, ok, shifted, maxChars);
      results[i] = { ...results[i]!, status: 'done', ...done };
      if (ok.change.action === 'move') {
        for (const m of done.moved ?? []) shifted.add(key(ok.change.owner, m.to));
        for (const p of done.linksRewritten ?? []) shifted.add(key(ok.change.owner, p));
      }
    } catch (err) {
      results[i] = { ...results[i]!, status: 'failed', error: failure(err) };
      saved = false;
      break;
    }
  }
  const touched = await touchedBy(notes, viewerId, changes, results);
  return { saved, results, touched, summary: summarizeChanges(results) };
}

const key = (owner: string, path: string) => `${owner}\u0000${path}`;
/**
 * One change, checked: the plan says whether it can run and which note it
 * means; the store says whether an edit's anchors are there, whether a
 * checksum is current and whether the note stays within its size.
 */
async function check(
  notes: NoteService,
  plan: ChangePlan,
  change: Change,
  i: number,
  maxChars: number | undefined,
): Promise<Checked> {
  const limit = (after: NoteSize, before?: NoteSize) => {
    if (maxChars !== undefined && !fitsNoteLimit(after, before, maxChars)) {
      throw tooLong(change.path, after, before, maxChars);
    }
  };
  switch (change.action) {
    case 'create':
      // With a frontmatter argument the content is stored whole as the body,
      // a block of its own included; without one, its block is split off.
      normalizeRelativePath(change.path);
      limit(
        noteSize(change.frontmatter ? change.content : extractFrontmatter(change.content).body),
      );
      await plan.check(change, i);
      return { change };
    case 'edit': {
      const { origin } = await plan.check(change, i);
      const planned = await notes.planEdit(change.owner, origin!, change.edits, {
        ...(change.expectedChecksum ? { expectedChecksum: change.expectedChecksum } : {}),
      });
      limit(planned.size.after, planned.size.before);
      return { change, plan: planned };
    }
    case 'replace': {
      const { origin } = await plan.check(change, i);
      const current = await notes.get(change.owner, origin!);
      // A stale read first: the size is judged against the version the caller
      // read, and a caller working from an old one needs to hear that.
      if (change.expectedChecksum && change.expectedChecksum !== current.checksum) {
        throw new AppError(
          `${change.path} was changed by someone else since you read it`,
          'CHANGED',
          409,
        );
      }
      limit(noteSize(extractFrontmatter(change.content).body), noteSize(current.body));
      return { change, baseChecksum: current.checksum };
    }
    default:
      await plan.check(change, i);
      return { change };
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

async function write(
  notes: NoteService,
  { change: c, plan, baseChecksum }: Checked,
  shifted: ReadonlySet<string>,
  maxChars: number | undefined,
): Promise<Partial<ChangeResult>> {
  // A note a move in this plan moved, or whose links it rewrote: what was
  // checked is no longer what is stored, and only this plan changed it.
  const moved = shifted.has(key(c.owner, normalizeRelativePath(c.path)));
  switch (c.action) {
    case 'create': {
      const r = await notes.create(c.owner, c.path, c.content, c.frontmatter);
      return { path: r.path, checksum: r.checksum, affectedMocs: r.affectedMocs };
    }
    case 'edit': {
      if (!moved) return notes.writePlanned(c.owner, plan!);
      // Planned again on the version the move left, anchors checked again.
      const again = await notes.planEdit(c.owner, c.path, c.edits);
      if (maxChars !== undefined && !fitsNoteLimit(again.size.after, again.size.before, maxChars)) {
        throw tooLong(c.path, again.size.after, again.size.before, maxChars);
      }
      return notes.writePlanned(c.owner, again);
    }
    case 'replace': {
      const base = moved ? (await notes.get(c.owner, c.path)).checksum : baseChecksum!;
      return notes.update(c.owner, c.path, c.content, { expectedChecksum: base });
    }
    case 'delete':
      // The path as the store names it, like every other write's: a `./` or a
      // trailing slash the caller typed is not what was deleted.
      return {
        path: normalizeRelativePath(c.path),
        ...(await notes.remove(c.owner, c.path, { recursive: c.recursive ?? false })),
      };
    case 'create_folder':
      return { path: await notes.createFolder(c.owner, c.path) };
    case 'move': {
      const r = await notes.move(c.owner, c.path, c.to);
      const sums = await notes.checksums(
        c.owner,
        r.moved.map((m) => m.to),
      );
      const own = r.moved.map((m) => ({
        ...m,
        ...(sums.has(m.to) ? { checksum: sums.get(m.to)! } : {}),
      }));
      return {
        from: normalizeRelativePath(c.path),
        path: r.path,
        affectedMocs: r.affectedMocs,
        moved: own,
        linksRewritten: r.linksRewritten,
        // A note moved on its own carries its version like any written note.
        ...(own.length === 1 && own[0]!.to === r.path && own[0]!.checksum
          ? { checksum: own[0]!.checksum }
          : {}),
      };
    }
  }
}

/** The notes moves rewrote that no change named, with their checksum now. */
async function touchedBy(
  notes: NoteService,
  viewerId: string,
  changes: readonly Change[],
  results: readonly ChangeResult[],
): Promise<ChangeReport['touched']> {
  const out: ChangeReport['touched'] = [];
  for (const [owner, paths] of touchedByMoves(changes, results)) {
    const sums = await notes.checksums(owner, paths);
    for (const [path, checksum] of sums) {
      out.push({ path, checksum, ...(owner !== viewerId ? { ownerId: owner } : {}) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
