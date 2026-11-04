// apply_changes: Sentinel's writing, as BrainStack runs it — a plan of
// changes in one call.
//
// An assistant that has decided to rename a folder, create two notes in it,
// link them from its index and adjust three others used to spend one round
// trip per step, each a full turn of the model, and then read the vault again
// to learn what the moves had done. Here the whole plan arrives at once and is
// checked before anything is written: every path is valid, every note to
// change exists, every destination is free, every edit's anchor is there,
// every checksum is current. One failure and nothing is written — the answer
// says which changes would have failed and why, so the plan can be fixed and
// sent again whole.
//
// Changes run in the order given, and each is checked against what the ones
// before it leave behind: an edit of `b/_b.md` after the move that renames
// `a/` to `b/` is checked against `a/_a.md`, which is where that note still is
// while the plan is being checked. A note may be written by one change only
// (moves aside): every change to it goes in one edit.
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
  fitsNoteLimit,
  HOW_TO_SPLIT,
  noteSize,
  type NoteEdit,
  type NoteSize,
} from '@brainstack/core/sentinel';

import { AppError, describeError, toAppError } from '../lib/errors.js';

import { indexRenameFor, type NoteService, type PlannedEdit } from './NoteService.js';

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
  const plan = new Plan(notes, maxChars);
  const checked: Array<{ ok: Checked } | { error: ChangeResult['error'] }> = [];
  for (const [i, change] of changes.entries()) {
    try {
      checked.push({ ok: await plan.check(change, i) });
    } catch (err) {
      checked.push({ error: failure(err) });
    }
  }
  if (checked.some((c) => 'error' in c)) {
    const results = changes.map((c, i): ChangeResult => {
      const r = checked[i]!;
      return 'error' in r ? { ...head(c), status: 'failed', error: r.error } : head(c);
    });
    return { saved: false, results, touched: [], summary: summarize(results) };
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
  return { saved, results, touched, summary: summarize(results) };
}

const key = (owner: string, path: string) => `${owner}\u0000${path}`;
const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The vault as the plan will have left it, change by change, without writing
 * any of it: what moved where, what was created or deleted, and which note
 * each change writes. Asked about a path, it answers for the state after the
 * changes checked so far.
 */
class Plan {
  private readonly moves: Array<{ owner: string; from: string; to: string }> = [];
  private readonly created = new Map<string, number>();
  private readonly createdFolders = new Set<string>();
  private readonly deleted: Array<{ owner: string; path: string; recursive: boolean; at: number }> =
    [];
  /** The note each content change writes, by its path before the plan: a note is written once. */
  private readonly written = new Map<string, number>();

  constructor(
    private readonly notes: NoteService,
    private readonly maxChars: number | undefined,
  ) {}

  /**
   * Where a path named now was before the plan began, following the moves
   * back; null when nothing was there — it is where something moved away from.
   */
  private origin(owner: string, path: string): string | null {
    let p = path;
    for (let i = this.moves.length - 1; i >= 0; i--) {
      const m = this.moves[i]!;
      if (m.owner !== owner) continue;
      if (under(p, m.to)) p = m.from + p.slice(m.to.length);
      else if (under(p, m.from)) return null;
    }
    return p;
  }

  /** The change, by number, that deleted this note or a folder above it. */
  private deletedBy(owner: string, origin: string): number | undefined {
    const d = this.deleted.find(
      (x) => x.owner === owner && (x.recursive ? under(origin, x.path) : origin === x.path),
    );
    return d?.at;
  }

  private async noteExists(owner: string, path: string): Promise<boolean> {
    if (!path.toLowerCase().endsWith('.md')) return false; // a folder or an attachment
    const origin = this.origin(owner, path);
    if (origin === null) return this.created.has(key(owner, `#${path}`));
    if (this.deletedBy(owner, origin) !== undefined) return false;
    if (this.created.has(key(owner, origin))) return true;
    return this.notes.hasNote(owner, origin);
  }

  /** A note, or a folder — one created in this plan, or one implied by a note in it. */
  private async anythingAt(owner: string, path: string): Promise<boolean> {
    const origin = this.origin(owner, path);
    if (origin === null) return false;
    if (this.deletedBy(owner, origin) !== undefined) return false;
    const mine = (k: string) =>
      k.startsWith(`${owner}\u0000`) && under(k.slice(owner.length + 1), origin);
    if ([...this.created.keys()].some(mine) || [...this.createdFolders].some(mine)) return true;
    return this.notes.exists(owner, origin);
  }

  /** The note a content change writes, as it was named before the plan; refused if another change writes it too. */
  private claim(change: Change, i: number): string {
    const path = normalizeRelativePath(change.path);
    const origin = this.origin(change.owner, path) ?? `#${path}`;
    const k = key(change.owner, origin);
    const earlier = this.written.get(k);
    if (earlier !== undefined) {
      throw new AppError(
        `${change.path} is written by change ${earlier + 1} too; put every change to it in one edit`,
        'INVALID_INPUT',
        400,
      );
    }
    const gone = this.deletedBy(change.owner, origin);
    if (gone !== undefined) {
      throw new AppError(`${change.path} is deleted by change ${gone + 1}`, 'INVALID_INPUT', 400);
    }
    this.written.set(k, i);
    return origin;
  }

  private limit(path: string, after: NoteSize, before?: NoteSize) {
    if (this.maxChars !== undefined && !fitsNoteLimit(after, before, this.maxChars)) {
      throw tooLong(path, after, before, this.maxChars);
    }
  }

  async check(change: Change, i: number): Promise<Checked> {
    // An empty or climbing path is refused before any lookup.
    const path = normalizeRelativePath(change.path);
    const { owner } = change;
    switch (change.action) {
      case 'create': {
        // With a frontmatter argument the content is stored whole as the body,
        // a block of its own included; without one, its block is split off.
        this.limit(
          change.path,
          noteSize(change.frontmatter ? change.content : extractFrontmatter(change.content).body),
        );
        if (await this.noteExists(owner, path)) {
          throw new AppError(`${change.path} already exists`, 'ALREADY_EXISTS', 409);
        }
        const origin = this.claim(change, i);
        this.created.set(key(owner, origin), i);
        return { change };
      }
      case 'edit': {
        // A note created earlier in the plan was claimed by its create.
        const origin = this.claim(change, i);
        if (origin.startsWith('#'))
          throw new AppError(`${change.path} does not exist`, 'NOT_FOUND', 404);
        const plan = await this.notes.planEdit(owner, origin, change.edits, {
          ...(change.expectedChecksum ? { expectedChecksum: change.expectedChecksum } : {}),
        });
        this.limit(change.path, plan.size.after, plan.size.before);
        return { change, plan };
      }
      case 'replace': {
        const origin = this.claim(change, i);
        if (origin.startsWith('#'))
          throw new AppError(`${change.path} does not exist`, 'NOT_FOUND', 404);
        const current = await this.notes.get(owner, origin);
        // A stale read first: the size is judged against the version the caller
        // read, and a caller working from an old one needs to hear that.
        if (change.expectedChecksum && change.expectedChecksum !== current.checksum) {
          throw new AppError(
            `${change.path} was changed by someone else since you read it`,
            'CHANGED',
            409,
          );
        }
        this.limit(
          change.path,
          noteSize(extractFrontmatter(change.content).body),
          noteSize(current.body),
        );
        return { change, baseChecksum: current.checksum };
      }
      case 'delete': {
        // A recursive delete may name a folder, which `exists` answers for too.
        const found = change.recursive
          ? await this.anythingAt(owner, path)
          : await this.noteExists(owner, path);
        if (!found) throw new AppError(`${change.path} does not exist`, 'NOT_FOUND', 404);
        const origin = this.claim(change, i);
        if (change.recursive) {
          const inside = [...this.written.entries()].find(
            ([k]) =>
              k.startsWith(`${owner}\u0000`) && k.slice(owner.length + 1).startsWith(`${origin}/`),
          );
          if (inside) {
            throw new AppError(
              `${change.path} holds a note change ${inside[1] + 1} writes; deleting it would undo that`,
              'INVALID_INPUT',
              400,
            );
          }
        }
        this.deleted.push({ owner, path: origin, recursive: change.recursive ?? false, at: i });
        return { change };
      }
      case 'create_folder': {
        const origin = this.origin(owner, path) ?? `#${path}`;
        this.createdFolders.add(key(owner, origin));
        return { change };
      }
      case 'move': {
        const to = normalizeRelativePath(change.to);
        if (to === path) return { change };
        if (to.startsWith(`${path}/`)) {
          throw new AppError(`can't move ${change.path} inside itself`, 'INVALID_INPUT', 400);
        }
        const isNote = await this.noteExists(owner, path);
        if (!isNote && !(await this.anythingAt(owner, path))) {
          throw new AppError(`${change.path} does not exist`, 'NOT_FOUND', 404);
        }
        if (await this.noteExists(owner, to)) {
          throw new AppError(`${change.to} already exists`, 'ALREADY_EXISTS', 409);
        }
        if (!isNote) {
          // A folder's notes must each find their place free, or the move stops
          // halfway through with the folder split across two places.
          const origin = this.origin(owner, path);
          const inside = origin ? await this.notes.notesUnder(owner, origin) : [];
          for (const n of inside) {
            const dest = to + n.slice(origin!.length);
            if (await this.noteExists(owner, dest)) {
              throw new AppError(`${dest} already exists`, 'ALREADY_EXISTS', 409);
            }
          }
        }
        this.moves.push({ owner, from: path, to });
        if (!isNote) {
          // The index follows the folder's name, as NoteService.move does it.
          const rename = indexRenameFor(path, to);
          if (
            rename &&
            (await this.noteExists(owner, rename.from)) &&
            !(await this.noteExists(owner, rename.to))
          ) {
            this.moves.push({ owner, ...rename });
          }
        }
        return { change };
      }
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

/**
 * The notes moves rewrote that no change named, at their final path, with
 * their checksum now. A note a later change wrote carries its own checksum,
 * and one a later change deleted is gone.
 */
async function touchedBy(
  notes: NoteService,
  viewerId: string,
  changes: readonly Change[],
  results: readonly ChangeResult[],
): Promise<ChangeReport['touched']> {
  const pending = new Map<string, Set<string>>(); // owner -> paths
  for (const [i, r] of results.entries()) {
    if (r.status !== 'done') continue;
    const owner = changes[i]!.owner;
    const set = pending.get(owner) ?? new Set<string>();
    pending.set(owner, set);
    if (r.action === 'move') {
      // Follow what this move carried: a rewritten note may itself move later.
      const map = new Map((r.moved ?? []).map((m) => [m.from, m.to]));
      for (const p of [...set]) {
        if (map.has(p)) {
          set.delete(p);
          set.add(map.get(p)!);
        }
      }
      for (const p of r.linksRewritten ?? []) set.add(p);
    } else if (r.action === 'delete') {
      for (const p of [...set]) {
        if ((r.deleted ?? []).includes(p)) set.delete(p);
      }
    } else if (r.action !== 'create_folder') {
      set.delete(r.path);
    }
  }
  const out: ChangeReport['touched'] = [];
  for (const [owner, set] of pending) {
    if (set.size === 0) continue;
    const sums = await notes.checksums(owner, [...set]);
    for (const [path, checksum] of sums) {
      out.push({ path, checksum, ...(owner !== viewerId ? { ownerId: owner } : {}) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** "1 folder moved (6 notes), 3 notes' links rewritten, 2 notes created, 1 edited". */
function summarize(results: readonly ChangeResult[]): string {
  const done = results.filter((r) => r.status === 'done');
  const count = (a: ChangeResult['action']) => done.filter((r) => r.action === a).length;
  const parts: string[] = [];
  const moves = done.filter((r) => r.action === 'move');
  if (moves.length) {
    const notesMoved = moves.reduce((n, r) => n + (r.moved?.length ?? 0), 0);
    parts.push(`${moves.length} moved (${notesMoved} note${notesMoved === 1 ? '' : 's'})`);
    const rewritten = new Set(moves.flatMap((r) => r.linksRewritten ?? [])).size;
    if (rewritten) parts.push(`links rewritten in ${rewritten} note${rewritten === 1 ? '' : 's'}`);
  }
  const folders = count('create_folder');
  if (folders) parts.push(`${folders} folder${folders === 1 ? '' : 's'} created`);
  for (const [a, word] of [
    ['create', 'created'],
    ['edit', 'edited'],
    ['replace', 'rewritten'],
    ['delete', 'deleted'],
  ] as const) {
    const n = count(a);
    if (n) parts.push(`${n} ${word}`);
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} not run`);
  return parts.length ? parts.join(', ') : 'nothing changed';
}
