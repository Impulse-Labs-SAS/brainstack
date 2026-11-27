// `@username` mentions: the name each person is mentioned by, the mentions a
// save adds, and handing them to the mentioned person's assistant.
//
// What a mention is, and which ones a save added, is Sentinel's
// (`handles.ts`). This service keeps the rows: whose username is which, and
// the mentions waiting to be told. Whether the person may read the note is
// asked through `canRead`, wired to `SharingService` — someone who cannot open
// a note is never told it exists, however it names them.
//
// There is no live channel. A mention waits here until the mentioned person
// next uses their assistant: every MCP answer carries what is pending (see
// `mcp/notices.ts`) and stamps it delivered.

import {
  addedHandleMentions,
  normalizeUsername,
  suggestUsername,
  USERNAME_RULES,
} from '@brainstack/core/sentinel';
import { pgSchema, type PgDb } from '@brainstack/core/pg';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Logger } from 'pino';

import { AppError } from '../lib/errors.js';

import type { NoteWrite } from './NoteService.js';

const { users, userMentions } = pgSchema;

/** How long after an assistant asked for a username it is asked again. */
export const USERNAME_ASK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** Mentions one answer hands on, at most; the rest wait for the next. */
export const MAX_MENTIONS_PER_NOTICE = 10;
/** People one save may notify. Past it the rest are ignored, not queued. */
export const MAX_MENTIONS_PER_WRITE = 20;

export interface MentionServiceOptions {
  db: PgDb;
  logger: Logger;
  /** Whether `userId` may read `path` in `ownerId`'s vault. */
  canRead: (userId: string, ownerId: string, path: string) => Promise<boolean>;
  now?: () => number;
}

export interface Mention {
  id: string;
  ownerId: string;
  path: string;
  snippet: string;
  createdAt: number;
  deliveredAt: number | null;
  /** Who wrote it, as others see them. Null once their account is gone. */
  author: { id: string; username: string | null; displayName: string | null } | null;
}

export interface PersonRef {
  userId: string;
  username: string;
  displayName: string | null;
}

/** What an assistant should pass on with its answer, if anything. */
export interface MentionNotices {
  mentions: Mention[];
  /** Set when the user has no username and their assistant should ask for one. */
  askUsername: { suggested: string | null } | null;
}

export class MentionService {
  constructor(private readonly opts: MentionServiceOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  // -- Usernames -------------------------------------------------------------

  async getUsername(userId: string): Promise<string | null> {
    const [row] = await this.opts.db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.username ?? null;
  }

  /**
   * Set the name the user is mentioned by. Refused when it breaks the rules
   * or someone else has it; setting the one they already have is a no-op.
   */
  async setUsername(userId: string, input: string): Promise<string> {
    const username = normalizeUsername(input);
    if (!username) {
      throw new AppError(
        `"${input}" cannot be a username: ${USERNAME_RULES}`,
        'INVALID_INPUT',
        400,
      );
    }
    if (await this.isTaken(username, userId)) {
      throw new AppError(`@${username} is already taken`, 'ALREADY_EXISTS', 409);
    }
    try {
      const updated = await this.opts.db
        .update(users)
        .set({ username, updatedAt: this.now() })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (updated.length === 0) throw new AppError('user not found', 'NOT_FOUND', 404);
    } catch (err) {
      // Two people claiming the same name at once: the index decides.
      if (err instanceof AppError) throw err;
      if (await this.isTaken(username, userId)) {
        throw new AppError(`@${username} is already taken`, 'ALREADY_EXISTS', 409);
      }
      throw err;
    }
    return username;
  }

  /** A free username to offer the user, made from their email. */
  async suggestFor(userId: string): Promise<string | null> {
    const [row] = await this.opts.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return null;
    const base = suggestUsername(row.email);
    if (!base) return null;
    for (let n = 0; n < 20; n++) {
      const candidate = n === 0 ? base : normalizeUsername(`${base.slice(0, 27)}${n + 1}`);
      if (candidate && !(await this.isTaken(candidate, userId))) return candidate;
    }
    return null;
  }

  private async isTaken(username: string, exceptUserId: string): Promise<boolean> {
    const rows = await this.opts.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, username), ne(users.id, exceptUserId)))
      .limit(1);
    return rows.length > 0;
  }

  /** The people among `userIds` who have a username, for the editor's `@`. */
  async people(userIds: readonly string[]): Promise<PersonRef[]> {
    if (userIds.length === 0) return [];
    const rows = await this.opts.db
      .select({ userId: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    return rows
      .filter((r): r is PersonRef => r.username !== null)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  // -- Recording -------------------------------------------------------------

  /**
   * Keep the mentions a write added, for each person who exists, may read the
   * note and is not who wrote it. Called after the write has landed; logs and
   * swallows its own failures, since the note is saved either way.
   */
  async recordWrite(write: NoteWrite, authorId: string | null): Promise<number> {
    try {
      const added = addedHandleMentions(write.before, write.after).slice(0, MAX_MENTIONS_PER_WRITE);
      if (added.length === 0) return 0;
      const found = await this.opts.db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(
          inArray(
            users.username,
            added.map((m) => m.username),
          ),
        );
      const idOf = new Map(found.map((u) => [u.username!, u.id]));
      // Without a known author — a command, a test — the note's owner wrote it.
      const author = authorId ?? write.ownerId;
      const at = this.now();
      const rows = [];
      for (const m of added) {
        const userId = idOf.get(m.username);
        if (!userId || userId === author) continue;
        if (!(await this.opts.canRead(userId, write.ownerId, write.path))) continue;
        rows.push({
          id: nanoid(),
          userId,
          authorId: author,
          ownerId: write.ownerId,
          path: write.path,
          snippet: m.snippet,
          createdAt: at,
        });
      }
      if (rows.length > 0) await this.opts.db.insert(userMentions).values(rows);
      return rows.length;
    } catch (err) {
      this.opts.logger.error({ err }, 'recording @mentions failed');
      return 0;
    }
  }

  // -- Delivery --------------------------------------------------------------

  /**
   * What the user's assistant should pass on now: mentions not yet delivered,
   * oldest first, stamped delivered as they are handed over; and, when the
   * user has no username and was not asked lately, a request to ask them.
   */
  async takeNotices(userId: string): Promise<MentionNotices> {
    const at = this.now();
    const [user] = await this.opts.db
      .select({ username: users.username, askedAt: users.usernameAskedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return { mentions: [], askUsername: null };

    let askUsername: MentionNotices['askUsername'] = null;
    if (
      user.username === null &&
      (user.askedAt === null || at - user.askedAt >= USERNAME_ASK_EVERY_MS)
    ) {
      await this.opts.db.update(users).set({ usernameAskedAt: at }).where(eq(users.id, userId));
      askUsername = { suggested: await this.suggestFor(userId) };
    }

    const pending = await this.list(userId, {
      pendingOnly: true,
      limit: MAX_MENTIONS_PER_NOTICE,
      oldestFirst: true,
    });
    // Asked again now: a folder unshared since the mention was written takes
    // its note out of reach, and the line quoted from it with it. Those are
    // stamped too, so they stop being asked about, and never shown.
    const readable = [];
    for (const m of pending) {
      if (await this.opts.canRead(userId, m.ownerId, m.path)) readable.push(m);
    }
    if (pending.length > 0) {
      await this.opts.db
        .update(userMentions)
        .set({ deliveredAt: at })
        .where(
          and(
            eq(userMentions.userId, userId),
            inArray(
              userMentions.id,
              pending.map((m) => m.id),
            ),
          ),
        );
    }
    return { mentions: readable.map((m) => ({ ...m, deliveredAt: at })), askUsername };
  }

  /**
   * The user's latest mentions, delivered or not, newest first — only those
   * whose note they may still read. Reading them delivers nothing.
   */
  async recent(userId: string, limit = 20): Promise<Mention[]> {
    const rows = await this.list(userId, { limit });
    const readable = [];
    for (const m of rows) {
      if (await this.opts.canRead(userId, m.ownerId, m.path)) readable.push(m);
    }
    return readable;
  }

  /** The user's mentions, newest first unless asked otherwise. Unchecked. */
  private async list(
    userId: string,
    opts: { pendingOnly?: boolean; limit?: number; oldestFirst?: boolean } = {},
  ): Promise<Mention[]> {
    const author = {
      id: users.id,
      username: users.username,
      displayName: users.displayName,
    };
    const rows = await this.opts.db
      .select({
        id: userMentions.id,
        ownerId: userMentions.ownerId,
        path: userMentions.path,
        snippet: userMentions.snippet,
        createdAt: userMentions.createdAt,
        deliveredAt: userMentions.deliveredAt,
        author,
      })
      .from(userMentions)
      .leftJoin(users, eq(users.id, userMentions.authorId))
      .where(
        and(
          eq(userMentions.userId, userId),
          opts.pendingOnly ? isNull(userMentions.deliveredAt) : undefined,
        ),
      )
      .orderBy(opts.oldestFirst ? userMentions.createdAt : desc(userMentions.createdAt))
      .limit(opts.limit ?? 20);
    return rows.map((r) => ({
      ...r,
      createdAt: Number(r.createdAt),
      deliveredAt: r.deliveredAt === null ? null : Number(r.deliveredAt),
      author: r.author?.id ? r.author : null,
    }));
  }
}
