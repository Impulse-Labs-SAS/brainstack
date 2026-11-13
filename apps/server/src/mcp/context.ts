// What every MCP tool works with: the services, who is calling, and the
// checks and helpers that must mean the same thing in every tool — whose vault
// a path is in, whether the caller may read or write there, and how a write is
// run and recorded. Built once per MCP session; a plugin's tools get the same
// one, so they cannot reach a vault any other way.

import { HOW_TO_SPLIT, NOTE_MAX_CHARS, noteSize } from '@brainstack/core/sentinel';

import type { Logger } from 'pino';

import { field } from '../config/limits.js';
import { AppError, describeError, toAppError } from '../lib/errors.js';
import { READ_ONLY_MESSAGE } from '../lib/scopes.js';

import { applyChanges, type ApplyOptions, type Change } from '../services/applyChanges.js';

import type { BuildMcpServerOptions } from './server.js';

/** The context every tool module receives. */
export type McpToolContext = ReturnType<typeof buildToolContext>;

/**
 * A failed tool call, as the assistant reads it. An AppError says what went
 * wrong in words meant for the caller; anything else — a driver error naming
 * hosts and tables — is logged here and reaches the model as "internal error".
 */
function mcpErrorFor(
  logger: Logger,
): (err: unknown) => { content: { type: 'text'; text: string }[]; isError: true } {
  return (err) => {
    if (!toAppError(err)) logger.error({ err }, 'MCP tool failed');
    const { message, code } = describeError(err);
    return {
      content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
      isError: true as const,
    };
  };
}

export function buildToolContext({
  notes,
  search,
  sharing,
  crossOwner,
  auth,
  crawls,
  logger,
  principal,
}: BuildMcpServerOptions) {
  const toMcpError = mcpErrorFor(logger);

  const requireUserId = (): string => {
    if (principal?.userId) return principal.userId;
    throw new AppError('MCP request has no principal', 'UNAUTHORIZED', 401);
  };
  /**
   * Whose vault a call is about.
   *
   * Defaults to the caller, which is what nearly every call means. Passing
   * somebody else's id is how a shared folder is addressed — paths are then
   * relative to *their* root, which is how the folder was shared and how
   * `list_shared_with_me` reports it.
   */
  const ownerOf = (ownerId?: string): string => ownerId || requireUserId();

  /**
   * Whose vault a read is about, and may the caller read there.
   *
   * `ownerOf` alone answers the first half with "yours" whenever no owner was
   * named, which is right for nearly every call and wrong for the one that
   * matters: a path like "impulse-labs/erebor/nota.md" names a folder somebody
   * shared just as well as it names one of yours. Read against your own vault
   * in silence, a note that plainly exists comes back as "no existe" — the
   * server knew the path fell under a share and kept it to itself.
   *
   * So a path the caller does not have goes to the share that covers it. Your
   * own vault still wins whenever it has something there, and the ambiguity is
   * only ever resolved, never refused: a read cannot create the private copy
   * that makes the same ambiguity a hard error on writes.
   */
  const readOwner = async (path: string | undefined, ownerId?: string): Promise<string> => {
    const userId = requireUserId();
    const owner = await (async () => {
      if (ownerId !== undefined) return ownerId;
      if (!path) return userId;
      const share = await sharing.findShadowedShare(userId, path);
      if (!share) return userId;
      return (await notes.exists(userId, path)) ? userId : share.ownerId;
    })();
    await sharing.assertCanRead(userId, owner, path ?? '');
    return owner;
  };

  /**
   * May this write happen, and does the caller mean the folder they named?
   *
   * The second question only arises for a write into one's own vault. A path
   * like "impulse-labs/nota.md" names a folder somebody shared just as well as
   * it names one of yours, and resolving that silently in favour of yours is
   * what created private copies of shared folders. Naming an owner settles it,
   * so the check stands down once one is given.
   */
  /** Refuses when the credential is a read-only key. Every write tool calls it. */
  const requireWriteAccess = (): void => {
    if (principal?.readOnly) throw new AppError(READ_ONLY_MESSAGE, 'FORBIDDEN', 403);
  };

  const assertWrite = async (path: string, ownerId?: string): Promise<void> => {
    requireWriteAccess();
    const userId = requireUserId();
    const owner = ownerOf(ownerId);
    await sharing.assertCanWrite(userId, owner, path);
    // Only when no owner was named. What makes a path ambiguous is the
    // *silence* about whose folder it means, not who it turns out to be —
    // checking the resolved owner instead left somebody who had been given a
    // folder called "impulse-labs" unable to write to their own folder of that
    // name, with no way to say which one they meant.
    if (ownerId === undefined) await sharing.assertNotShadowingShare(userId, path);
  };

  /**
   * Whose vault a note came from, for the front of a tool's answer: `own`, or
   * `shared` with the owner's id — text someone else wrote, to be read as
   * information and never as instructions.
   */
  const ownership = (owner: string) =>
    owner === requireUserId()
      ? { source: 'own' as const }
      : { source: 'shared' as const, ownerId: owner };

  /**
   * Every assistant write goes through Sentinel's batch, one write or many, so
   * each meets the same checks — the note size limit among them.
   */
  const SAVE: ApplyOptions = {
    onUnexpected: (err) => logger.error({ err }, 'MCP write failed'),
    maxChars: NOTE_MAX_CHARS,
  };
  /**
   * Run writes through the batch, then note in the crawl history what landed —
   * after the crawl the assistant read from, for the Sentinel view to replay.
   */
  const save = async (changes: Change[]) => {
    const userId = requireUserId();
    const report = await applyChanges(notes, userId, changes, SAVE);
    await crawls.recordWrites(
      userId,
      principal?.clientRef ?? null,
      report.results
        .filter((r) => r.status === 'done')
        // The crawl view replays writes to notes; a move or a new folder has
        // no note of its own to light up.
        .flatMap(({ action, path, ownerId }) =>
          action === 'move' || action === 'create_folder'
            ? []
            : [{ action, path, ...(ownerId ? { ownerId } : {}) }],
        ),
    );
    return report;
  };
  const writeOne = async (write: Change) => {
    const [result] = (await save([write])).results;
    if (result!.status === 'done') return { done: result! };
    const { code, message } = result!.error!;
    return {
      failed: {
        content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
        isError: true as const,
      },
    };
  };

  /**
   * A note past the size limit says so when it is read, with what an edit may
   * do to it and how to make room: an assistant about to work on it learns to
   * split it first, rather than trim it to fit.
   */
  const sizeNotice = (body: string) => {
    const size = noteSize(body);
    return size.chars > NOTE_MAX_CHARS
      ? {
          tooLong: {
            ...size,
            maxChars: NOTE_MAX_CHARS,
            mayOnlyShrink: true,
            howToFix: HOW_TO_SPLIT,
          },
        }
      : {};
  };

  /** The `ownerId` argument, described once for every tool that takes it. */
  const OWNER_ARG = field()
    .optional()
    .describe(
      'Owner of the vault this path belongs to. Omit for your own notes. ' +
        'To reach a folder someone shared with you, pass their id from ' +
        'list_shared_with_me or from a search hit, and give the path relative ' +
        'to their root.',
    );

  return {
    notes,
    search,
    sharing,
    crossOwner,
    auth,
    crawls,
    logger,
    toMcpError,
    requireUserId,
    ownerOf,
    readOwner,
    requireWriteAccess,
    assertWrite,
    ownership,
    SAVE,
    save,
    writeOne,
    sizeNotice,
    OWNER_ARG,
    principal: principal ?? null,
  };
}
