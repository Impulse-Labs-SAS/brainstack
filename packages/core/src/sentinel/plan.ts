// Sentinel's planning of writes: what a plan of changes means, change by
// change, and whether it can run — before anything is written.
//
// A plan is a list of changes in order: create, edit, replace or delete a
// note, create a folder, move a note or a folder. Each is checked against what
// the ones before it leave behind: an edit of `b/_b.md` after the move that
// renames `a/` to `b/` is checked against `a/_a.md`, which is where that note
// still is while the plan is being checked. A note may be written by one
// change only (moves aside): every change to it goes in one edit.
//
// Nothing here touches a store. What is already there is asked of a lookup the
// caller implements, the way the link rewriter asks a `NoteBodySource` for
// bodies. Whose vault a change is in arrives with it as `owner`; who may make
// it is decided before the plan is built, by whoever runs it.
//
// Running the plan, and checking an edit's anchors or a note's size against
// its stored body, is the caller's: `origin` tells it which note to look at.

import { normalizeRelativePath } from '../paths.js';

/** What the planner needs to know about a change. */
export interface PlannedChange {
  action: 'create' | 'edit' | 'replace' | 'delete' | 'create_folder' | 'move';
  /** Whose vault the change is in. */
  owner: string;
  /** For a move, where it moves from. */
  path: string;
  /** For a move, where to. */
  to?: string;
  /** For a delete. */
  recursive?: boolean;
}

/** What is in a vault before the plan, as the caller's store answers it. */
export interface PlanLookup {
  /** Is there a note at this path? */
  hasNote(owner: string, path: string): Promise<boolean>;
  /** Is there anything at this path — a note, or a folder, empty or implied by its notes? */
  exists(owner: string, path: string): Promise<boolean>;
  /** The notes under a folder, by path. */
  notesUnder(owner: string, folder: string): Promise<string[]>;
}

/** A change the plan cannot make, and why. Its message is meant for whoever sent it. */
export class NotePlanError extends Error {
  override readonly name = 'NotePlanError';
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'ALREADY_EXISTS' | 'INVALID_INPUT',
  ) {
    super(message);
  }
}

export interface CheckedChange {
  /**
   * For an edit or a replace: the note to check it against, by its path
   * before the plan began. A move earlier in the plan may have changed where
   * it is named, not what it is.
   */
  origin?: string;
}

const key = (owner: string, path: string) => `${owner}\u0000${path}`;
const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The rename a folder's index note takes when the folder moves: `a/luna` to
 * `b/simon` takes `b/simon/_luna.md` (where the folder move left it) to
 * `b/simon/_simon.md`. Null when the folder keeps its name.
 */
export function indexRenameFor(from: string, to: string): { from: string; to: string } | null {
  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? '';
  const oldName = base(from);
  const newName = base(to);
  if (!oldName || !newName || oldName === newName) return null;
  const folder = to.replace(/\/+$/, '');
  return { from: `${folder}/_${oldName}.md`, to: `${folder}/_${newName}.md` };
}

/**
 * The vault as the plan will have left it, change by change, without writing
 * any of it: what moved where, what was created or deleted, and which note
 * each change writes. Changes are checked with `check`, in order; asked about
 * a path, the plan answers for the state after the changes checked so far.
 * A change that fails its check leaves the plan as it was.
 */
export class ChangePlan {
  private readonly moves: Array<{ owner: string; from: string; to: string }> = [];
  private readonly created = new Map<string, number>();
  private readonly createdFolders = new Set<string>();
  private readonly deleted: Array<{ owner: string; path: string; recursive: boolean; at: number }> =
    [];
  /** The note each content change writes, by its path before the plan: a note is written once. */
  private readonly written = new Map<string, number>();

  constructor(private readonly lookup: PlanLookup) {}

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
    return this.lookup.hasNote(owner, origin);
  }

  /** A note, or a folder — one created in this plan, or one implied by a note in it. */
  private async anythingAt(owner: string, path: string): Promise<boolean> {
    const origin = this.origin(owner, path);
    if (origin === null) return false;
    if (this.deletedBy(owner, origin) !== undefined) return false;
    const mine = (k: string) =>
      k.startsWith(`${owner}\u0000`) && under(k.slice(owner.length + 1), origin);
    if ([...this.created.keys()].some(mine) || [...this.createdFolders].some(mine)) return true;
    return this.lookup.exists(owner, origin);
  }

  /** The note a content change writes, as it was named before the plan; refused if another change writes it too. */
  private claim(change: PlannedChange, i: number): string {
    const path = normalizeRelativePath(change.path);
    const origin = this.origin(change.owner, path) ?? `#${path}`;
    const k = key(change.owner, origin);
    const earlier = this.written.get(k);
    if (earlier !== undefined) {
      throw new NotePlanError(
        `${change.path} is written by change ${earlier + 1} too; put every change to it in one edit`,
        'INVALID_INPUT',
      );
    }
    const gone = this.deletedBy(change.owner, origin);
    if (gone !== undefined) {
      throw new NotePlanError(`${change.path} is deleted by change ${gone + 1}`, 'INVALID_INPUT');
    }
    this.written.set(k, i);
    return origin;
  }

  /** Check change number `i` (from 0) against what the changes before it leave, and record it. */
  async check(change: PlannedChange, i: number): Promise<CheckedChange> {
    // An empty or climbing path is refused before any lookup.
    const path = normalizeRelativePath(change.path);
    const { owner } = change;
    switch (change.action) {
      case 'create': {
        if (await this.noteExists(owner, path)) {
          throw new NotePlanError(`${change.path} already exists`, 'ALREADY_EXISTS');
        }
        const origin = this.claim(change, i);
        this.created.set(key(owner, origin), i);
        return {};
      }
      case 'edit':
      case 'replace': {
        // A note created earlier in the plan was claimed by its create.
        const origin = this.claim(change, i);
        if (origin.startsWith('#')) {
          throw new NotePlanError(`${change.path} does not exist`, 'NOT_FOUND');
        }
        return { origin };
      }
      case 'delete': {
        // A recursive delete may name a folder.
        const found = change.recursive
          ? await this.anythingAt(owner, path)
          : await this.noteExists(owner, path);
        if (!found) throw new NotePlanError(`${change.path} does not exist`, 'NOT_FOUND');
        const origin = this.claim(change, i);
        if (change.recursive) {
          const inside = [...this.written.entries()].find(
            ([k]) =>
              k.startsWith(`${owner}\u0000`) && k.slice(owner.length + 1).startsWith(`${origin}/`),
          );
          if (inside) {
            throw new NotePlanError(
              `${change.path} holds a note change ${inside[1] + 1} writes; deleting it would undo that`,
              'INVALID_INPUT',
            );
          }
        }
        this.deleted.push({ owner, path: origin, recursive: change.recursive ?? false, at: i });
        return {};
      }
      case 'create_folder': {
        const origin = this.origin(owner, path) ?? `#${path}`;
        this.createdFolders.add(key(owner, origin));
        return {};
      }
      case 'move': {
        const to = normalizeRelativePath(change.to ?? '');
        if (to === path) return {};
        if (to.startsWith(`${path}/`)) {
          throw new NotePlanError(`can't move ${change.path} inside itself`, 'INVALID_INPUT');
        }
        const isNote = await this.noteExists(owner, path);
        if (!isNote && !(await this.anythingAt(owner, path))) {
          throw new NotePlanError(`${change.path} does not exist`, 'NOT_FOUND');
        }
        if (await this.noteExists(owner, to)) {
          throw new NotePlanError(`${change.to} already exists`, 'ALREADY_EXISTS');
        }
        if (!isNote) {
          // A folder's notes must each find their place free, or the move stops
          // halfway through with the folder split across two places.
          const origin = this.origin(owner, path);
          const inside = origin ? await this.lookup.notesUnder(owner, origin) : [];
          for (const n of inside) {
            const dest = to + n.slice(origin!.length);
            if (await this.noteExists(owner, dest)) {
              throw new NotePlanError(`${dest} already exists`, 'ALREADY_EXISTS');
            }
          }
        }
        this.moves.push({ owner, from: path, to });
        if (!isNote) {
          // The folder's index follows its name, as the store's move does it.
          const rename = indexRenameFor(path, to);
          if (
            rename &&
            (await this.noteExists(owner, rename.from)) &&
            !(await this.noteExists(owner, rename.to))
          ) {
            this.moves.push({ owner, ...rename });
          }
        }
        return {};
      }
    }
  }
}

/** What the plan's report needs from each change's result. */
export interface ChangeOutcome {
  action: PlannedChange['action'];
  status: 'done' | 'failed' | 'skipped';
  /** Where the change left things. */
  path: string;
  moved?: ReadonlyArray<{ from: string; to: string }>;
  linksRewritten?: readonly string[];
  deleted?: readonly string[];
}

/**
 * The notes moves rewrote that no change named, at their final path, by
 * owner: their checksum changed, and whoever ran the plan should hand the new
 * one back. A rewritten note that a later move carried is named where it
 * landed; one a later change wrote carries its own checksum, and one a later
 * change deleted is gone.
 */
export function touchedByMoves(
  changes: readonly Pick<PlannedChange, 'owner'>[],
  outcomes: readonly ChangeOutcome[],
): Map<string, string[]> {
  const pending = new Map<string, Set<string>>();
  for (const [i, r] of outcomes.entries()) {
    if (r.status !== 'done') continue;
    const owner = changes[i]!.owner;
    const set = pending.get(owner) ?? new Set<string>();
    pending.set(owner, set);
    if (r.action === 'move') {
      const map = new Map((r.moved ?? []).map((m) => [m.from, m.to]));
      for (const p of [...set]) {
        const to = map.get(p);
        if (to !== undefined) {
          set.delete(p);
          set.add(to);
        }
      }
      for (const p of r.linksRewritten ?? []) set.add(p);
    } else if (r.action === 'delete') {
      for (const p of r.deleted ?? []) set.delete(p);
    } else if (r.action !== 'create_folder') {
      set.delete(r.path);
    }
  }
  const out = new Map<string, string[]>();
  for (const [owner, set] of pending) if (set.size) out.set(owner, [...set].sort());
  return out;
}

/** "1 moved (6 notes), links rewritten in 3 notes, 2 created, 1 edited". */
export function summarizeChanges(outcomes: readonly ChangeOutcome[]): string {
  const done = outcomes.filter((r) => r.status === 'done');
  const count = (a: ChangeOutcome['action']) => done.filter((r) => r.action === a).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const moves = done.filter((r) => r.action === 'move');
  if (moves.length) {
    const notesMoved = moves.reduce((n, r) => n + (r.moved?.length ?? 0), 0);
    parts.push(`${moves.length} moved (${plural(notesMoved, 'note')})`);
    const rewritten = new Set(moves.flatMap((r) => r.linksRewritten ?? [])).size;
    if (rewritten) parts.push(`links rewritten in ${plural(rewritten, 'note')}`);
  }
  const folders = count('create_folder');
  if (folders) parts.push(`${plural(folders, 'folder')} created`);
  for (const [a, word] of [
    ['create', 'created'],
    ['edit', 'edited'],
    ['replace', 'rewritten'],
    ['delete', 'deleted'],
  ] as const) {
    const n = count(a);
    if (n) parts.push(`${n} ${word}`);
  }
  const failed = outcomes.filter((r) => r.status === 'failed').length;
  const skipped = outcomes.filter((r) => r.status === 'skipped').length;
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} not run`);
  return parts.length ? parts.join(', ') : 'nothing changed';
}
