// MCP server setup. Registers BrainStack tools on a single McpServer instance
// and exposes a helper to connect to a given transport (Streamable HTTP).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_EDITS, NOTE_MAX_CHARS, noteSize, type NoteEdit } from '@brainstack/core/sentinel';
import { z } from 'zod';

import type { Logger } from 'pino';

import { emailField, field, frontmatterField, noteContent } from '../config/limits.js';
import { listBacklinksSafely } from '../lib/backlinks.js';
import { AppError, describeError, toAppError } from '../lib/errors.js';
import { READ_ONLY_MESSAGE } from '../lib/scopes.js';

import type { AuthService } from '../services/AuthService.js';
import type { CrawlHistoryService } from '../services/CrawlHistoryService.js';
import type { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import {
  gatherContext,
  placeNoteInVault,
  searchBrain,
  MAX_DEPTH,
  MAX_MAX_CHARS,
  MAX_TERMS,
  MAX_TEXT_CHARS,
} from '../services/gatherContext.js';
import { MAX_TREE_DEPTH, type NoteService } from '../services/NoteService.js';
import { MAX_WRITES, saveNotes, type NoteWrite, type SaveOptions } from '../services/saveNotes.js';
import type { SearchService } from '../services/SearchService.js';
import { normalizeFolderPath, type SharingService } from '../services/SharingService.js';

import { GUIDE, SERVER_INSTRUCTIONS } from './guide.generated.js';

export interface McpPrincipal {
  /** The authenticated user calling the MCP server. */
  userId: string;
  /**
   * The API key it called with — `oauth:<clientId>` for a client of this
   * server's OAuth provider. Only used to name the assistant in the crawl history.
   */
  clientRef?: string;
  /** A key without `notes:write`: every tool that changes something refuses. */
  readOnly?: boolean;
}

export interface BuildMcpServerOptions {
  notes: NoteService;
  search: SearchService;
  sharing: SharingService;
  /** Reads across an ownership boundary, masking what the grant does not cover. */
  crossOwner: CrossOwnerReader;
  /** Resolves the email a caller unshares into an account. */
  auth: AuthService;
  /** Where `gather_context` leaves each crawl for the Sentinel view to replay. */
  crawls: CrawlHistoryService;
  logger: Logger;
  /**
   * Who is calling. Every tool that touches a vault refuses to run without
   * one: there is no vault that belongs to nobody.
   */
  principal?: McpPrincipal | null;
}

const TEXT = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const JSON_TEXT = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** Notes `get_notes` opens in one call, at most. */
const MAX_NOTES_READ = 20;
/**
 * Body characters `get_notes` answers with, all notes together. Twenty notes
 * at the size limit would be an answer of forty million characters; past this
 * the rest are cut, and say so.
 */
const MAX_NOTES_READ_CHARS = 400_000;

/** One of Sentinel's edits, as an assistant sends it. */
const EDIT = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('replace'),
    find: noteContent().min(1).describe('Text in the note to replace. Must appear exactly once.'),
    replace: noteContent().describe('What replaces it. Empty deletes it.'),
  }),
  z.object({
    op: z.literal('append'),
    text: noteContent(),
    section: field()
      .optional()
      .describe(
        'A heading, like "Notas" or "## Notas" — or the start of one, when only one heading begins with it. Omit to append to the end of the note.',
      ),
  }),
  z.object({
    op: z.literal('prepend'),
    text: noteContent(),
    section: field()
      .optional()
      .describe('A heading: the text goes right under it. Omit to prepend to the whole note.'),
  }),
  z.object({
    op: z.literal('set_frontmatter'),
    values: frontmatterField().describe('Keys to set; a null value removes the key.'),
  }),
]);
const EDITS = z.array(EDIT).min(1).max(MAX_EDITS);

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

export function buildMcpServer({
  notes,
  search,
  sharing,
  crossOwner,
  auth,
  crawls,
  logger,
  principal,
}: BuildMcpServerOptions): McpServer {
  const toMcpError = mcpErrorFor(logger);
  // `instructions` reach the assistant on connect, before any tool is called,
  // so the habits that matter most hold even where nobody installed the skill.
  const server = new McpServer(
    { name: 'brainstack', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

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
  const SAVE: SaveOptions = {
    onUnexpected: (err) => logger.error({ err }, 'MCP write failed'),
    maxChars: NOTE_MAX_CHARS,
  };
  /**
   * Run writes through the batch, then note in the crawl history what landed —
   * after the crawl the assistant read from, for the Sentinel view to replay.
   */
  const save = async (writes: NoteWrite[]) => {
    const userId = requireUserId();
    const report = await saveNotes(notes, userId, writes, SAVE);
    await crawls.recordWrites(
      userId,
      principal?.clientRef ?? null,
      report.results
        .filter((r) => r.status === 'done')
        .map(({ action, path, ownerId }) => ({ action, path, ...(ownerId ? { ownerId } : {}) })),
    );
    return report;
  };
  const writeOne = async (write: NoteWrite) => {
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
   * do to it: an assistant about to work on it learns to split it first.
   */
  const sizeNotice = (body: string) => {
    const size = noteSize(body);
    return size.chars > NOTE_MAX_CHARS
      ? { tooLong: { ...size, maxChars: NOTE_MAX_CHARS, mayOnlyShrink: true } }
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

  server.registerTool(
    'search_brain',
    {
      title: 'Search the brain',
      description:
        "Full-text search over notes in BrainStack, ranked the way gather_context ranks them: a note the query names by title first, then the matches, those outside the named note's folder lower. `scope` decides what is searched: `all` (default) the user's own notes and the folders shared with them, `mine` only their own, `shared` only the shared ones. Returns up to `limit` hits (default 10, at most 50), each with a `snippet`, a `reason`, and the `ownerId` of the vault it lives in.",
      inputSchema: {
        query: field().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        scope: z.enum(['mine', 'shared', 'all']).optional(),
      },
    },
    async ({ query, limit, scope }) => {
      try {
        const userId = requireUserId();
        // Everything the caller may read, unless they narrow it. Defaulting to
        // `mine` meant a client that never passed a scope could not see a
        // shared folder at all, and answered "no existe" for notes sitting in
        // one — the failure looked like missing data rather than a narrow
        // search.
        const effectiveScope = scope ?? 'all';
        const sharedScopes =
          effectiveScope !== 'mine'
            ? (await sharing.listSharedRoots(userId)).map((r) => ({
                ownerId: r.ownerId,
                folderPath: r.folderPath,
              }))
            : [];
        // The same engine as gather_context, so the two never disagree about
        // which note comes first.
        const hits = await searchBrain(
          { notes, search },
          userId,
          { query, limit, scope: effectiveScope },
          sharedScopes,
        );
        logger.debug({ query, hits: hits.length, scope: effectiveScope }, 'search_brain');
        return JSON_TEXT(hits);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Read a note',
      description: 'Read a single note from the brain by its path (relative to NOTES_DIR).',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        const note = await notes.get(owner, path);
        // Whose words these are comes before the words: a shared note can be
        // written by anyone with access to the folder, and reads back with the
        // same weight as the user's own unless the assistant is told first.
        return JSON_TEXT({ ...ownership(owner), ...note, ...sizeNotice(note.body) });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_notes',
    {
      title: 'Read several notes',
      description: `Read up to ${MAX_NOTES_READ} notes in one call — the ones gather_context listed in \`leftOut\` or cut short, for example — instead of one get_note each. Each entry takes a \`path\` and, for a folder shared with the user, its \`ownerId\`. A note that cannot be read comes back with an \`error\` in its place; the others are read regardless. Bodies share a budget of ${MAX_NOTES_READ_CHARS} characters: a note cut to fit says \`truncated: true\` — open it alone with get_note.`,
      inputSchema: {
        notes: z
          .array(z.object({ path: field().min(1), ownerId: OWNER_ARG }))
          .min(1)
          .max(MAX_NOTES_READ),
      },
    },
    async ({ notes: wanted }) => {
      try {
        const read = await Promise.all(
          wanted.map(async ({ path, ownerId }) => {
            try {
              const owner = await readOwner(path, ownerId);
              const note = await notes.get(owner, path);
              return { ...ownership(owner), ...note, ...sizeNotice(note.body) };
            } catch (err) {
              if (!toAppError(err)) logger.error({ err }, 'get_notes read failed');
              return { path, ...(ownerId ? { ownerId } : {}), error: describeError(err) };
            }
          }),
        );
        let room = MAX_NOTES_READ_CHARS;
        return JSON_TEXT(
          read.map((note) => {
            if (!('body' in note)) return note;
            if (note.body.length <= room) {
              room -= note.body.length;
              return note;
            }
            const body = note.body.slice(0, room);
            room = 0;
            return { ...note, body, truncated: true };
          }),
        );
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List notes in BrainStack. Filter by folder prefix, tag, a frontmatter facet (facetKey + facetValue — see list_facets), or frontmatter status. Sorted by mtime desc.',
      inputSchema: {
        folder: field().optional(),
        tag: field().optional(),
        facetKey: field().optional(),
        facetValue: field().optional(),
        status: field().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ ownerId, facetKey, facetValue, ...args }) => {
      try {
        const owner = await readOwner(args.folder, ownerId);
        const facet = facetKey && facetValue ? { key: facetKey, value: facetValue } : undefined;
        const rows = await notes.list(owner, { ...args, ...(facet ? { facet } : {}) });
        return JSON_TEXT(
          owner === requireUserId() ? rows : rows.map((r) => ({ ownerId: owner, ...r })),
        );
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description: `Create a new note at the given path. Fails if a note already exists, or if its body is longer than ${NOTE_MAX_CHARS} characters (TOO_LONG): split a longer one into several notes. Returns the final path plus \`affectedMocs\`: the existing \`_<Folder>.md\` index note for the parent folder, if any, which you should consider updating to link the new note.`,
      inputSchema: {
        path: field().min(1),
        content: noteContent(),
        frontmatter: frontmatterField().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, content, frontmatter, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        const { done, failed } = await writeOne({
          action: 'create',
          owner: ownerOf(ownerId),
          path,
          content,
          ...(frontmatter ? { frontmatter } : {}),
        });
        if (failed) return failed;
        return JSON_TEXT({
          path: done.path,
          affectedMocs: done.affectedMocs ?? [],
          checksum: done.checksum,
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update a note',
      description: `Replace the whole contents of an existing note — for a rewrite. To change part of a note, use edit_note, which sends only what changes. Fails if the note does not exist. Pass the \`checksum\` get_note returned as \`expectedChecksum\` so the write is refused, instead of overwriting, if someone changed the note since you read it. The body may not grow past ${NOTE_MAX_CHARS} characters (TOO_LONG); a note already past it may only shrink.`,
      inputSchema: {
        path: field().min(1),
        content: noteContent(),
        ownerId: OWNER_ARG,
        expectedChecksum: field()
          .optional()
          .describe(
            'The checksum get_note returned; the update fails with CHANGED if the note moved on.',
          ),
      },
    },
    async ({ path, content, ownerId, expectedChecksum }) => {
      try {
        await assertWrite(path, ownerId);
        const { done, failed } = await writeOne({
          action: 'replace',
          owner: ownerOf(ownerId),
          path,
          content,
          ...(expectedChecksum ? { expectedChecksum } : {}),
        });
        if (failed) return failed;
        return TEXT(`Updated ${done.path} (checksum ${done.checksum})`);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'edit_note',
    {
      title: 'Edit part of a note',
      description:
        'Change an existing note by saying what changes, without sending it back whole — prefer this to update_note for any change that is not a full rewrite. `edits` apply in order: `replace` swaps one exact passage (it must appear exactly once; an empty `replace` deletes it), `append` adds text at the end of the note or of a `section` (a heading such as "Notas", in any case and with or without accents; the start of a heading names it too, when only one heading begins with it), `prepend` adds it at the start or right under a section\'s heading, `set_frontmatter` merges keys (null removes one). Text is inserted as whole lines; for a paragraph of its own, start an appended text with an empty line and end a prepended one with one. `replace` works on the body only. If an anchor is missing or ambiguous nothing is written and the error says which. Pass the `checksum` from gather_context or get_note as `expectedChecksum`; without one the edit still lands only on the version it was applied to. You do not need to open the note first when gather_context already showed you the passage or listed the section.' +
        ` The body may not grow past ${NOTE_MAX_CHARS} characters (TOO_LONG): split the note instead. A note already past it may only shrink.`,
      inputSchema: {
        path: field().min(1),
        edits: EDITS,
        ownerId: OWNER_ARG,
        expectedChecksum: field()
          .optional()
          .describe('The checksum you read; the edit fails with CHANGED if the note moved on.'),
      },
    },
    async ({ path, edits, ownerId, expectedChecksum }) => {
      try {
        await assertWrite(path, ownerId);
        const { done, failed } = await writeOne({
          action: 'edit',
          owner: ownerOf(ownerId),
          path,
          edits: edits as NoteEdit[],
          ...(expectedChecksum ? { expectedChecksum } : {}),
        });
        if (failed) return failed;
        return JSON_TEXT({ path: done.path, checksum: done.checksum });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'save_notes',
    {
      title: 'Save several changes at once',
      description: `Several writes in one call — use it whenever a plan touches more than one note: creating notes and linking them from their index, adjusting the notes that mention them, removing one. Each write has an \`action\`: \`create\` (path, content, frontmatter?), \`edit\` (path, edits — the same edits as edit_note, expectedChecksum?), \`replace\` (path, content, expectedChecksum? — a full rewrite) or \`delete\` (path, recursive?). Each takes an optional \`ownerId\` for a folder shared with the user. Everything is checked before anything is written: paths, permission, that the notes to change exist, every edit's anchor, every checksum. If any check fails nothing is written and \`results\` says which write failed and why. Writes then run in order; if one still fails (someone saved that note a moment ago) the ones before it stay, the rest are \`skipped\`, and \`saved\` is false. A path may appear in only one write. To link a new note from its index, add an \`edit\` that appends the link to the index's section — no need to read the index first. At most ${MAX_WRITES} writes. No note's body may grow past ${NOTE_MAX_CHARS} characters (TOO_LONG): a longer note is split into several, linked from a short summary note — which is itself one save_notes. Needs the user's approval like any other write: put the whole plan to them once.`,
      inputSchema: {
        writes: z
          .array(
            z.discriminatedUnion('action', [
              z.object({
                action: z.literal('create'),
                path: field().min(1),
                content: noteContent(),
                frontmatter: frontmatterField().optional(),
                ownerId: OWNER_ARG,
              }),
              z.object({
                action: z.literal('edit'),
                path: field().min(1),
                edits: EDITS,
                expectedChecksum: field().optional(),
                ownerId: OWNER_ARG,
              }),
              z.object({
                action: z.literal('replace'),
                path: field().min(1),
                content: noteContent(),
                expectedChecksum: field().optional(),
                ownerId: OWNER_ARG,
              }),
              z.object({
                action: z.literal('delete'),
                path: field().min(1),
                recursive: z.boolean().optional(),
                ownerId: OWNER_ARG,
              }),
            ]),
          )
          .min(1)
          .max(MAX_WRITES),
      },
    },
    async ({ writes }) => {
      try {
        requireWriteAccess();
        const userId = requireUserId();
        // Permission for every write before any note is looked at, with the
        // shared roots fetched once rather than once per write.
        const roots = await sharing.listSharedRoots(userId);
        await Promise.all(
          writes.map(async (w, i) => {
            try {
              await sharing.assertCanWrite(userId, ownerOf(w.ownerId), w.path);
              if (w.ownerId === undefined) {
                await sharing.assertNotShadowingShare(userId, w.path, roots);
              }
            } catch (err) {
              const known = toAppError(err);
              if (!known) throw err;
              throw new AppError(
                `write ${i + 1} (${w.path}): ${known.message}`,
                known.code,
                known.status,
              );
            }
          }),
        );
        const planned = writes.map(({ ownerId, ...w }) => ({
          ...w,
          owner: ownerOf(ownerId),
        })) as NoteWrite[];
        const report = await save(planned);
        return JSON_TEXT(report);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_tree',
    {
      title: 'List the vault tree',
      description:
        'Return a hierarchical view of the vault. Scope to a subfolder with `path`. ' +
        'Cap depth with `depth` (default 4). Folders are listed before files; both alphabetical.',
      inputSchema: {
        path: field().optional(),
        depth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, depth, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        const tree = await notes.listTree(owner, path, depth);
        return JSON_TEXT(owner === requireUserId() ? tree : { ownerId: owner, ...tree });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_decisions',
    {
      title: 'List decisions',
      description:
        'List every note flagged as a decision (tag `decisión`/`decision` or frontmatter `status: decidido`). ' +
        'Optional folder scope.',
      inputSchema: {
        folder: field().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ ownerId, ...args }) => {
      try {
        const owner = await readOwner(args.folder, ownerId);
        const rows = await notes.listDecisions(owner, args);
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Create a folder',
      description:
        'Create a folder (and any missing parents) under the vault root. Idempotent: a no-op if the folder already exists.',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        const final = await notes.createFolder(ownerOf(ownerId), path);
        return TEXT(`Created folder ${final}`);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'move',
    {
      title: 'Move or rename a note, attachment, or folder',
      description:
        'Move/rename a path. Wikilinks pointing at the moved path(s) — including aliases, sections, and attachment embeds — are rewritten across the vault. Folders are moved with all their contents. Returns the final path plus `affectedMocs`: existing `_<Folder>.md` index notes in the source and destination parent folders that you should consider updating.',
      inputSchema: { from: field().min(1), to: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ from, to, ownerId }) => {
      try {
        // One owner for both ends: a move stays inside a single vault.
        await assertWrite(from, ownerId);
        await assertWrite(to, ownerId);
        const result = await notes.move(ownerOf(ownerId), from, to);
        return JSON_TEXT(result);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'move_to_owner',
    {
      title: 'Move a note or folder into another vault',
      description:
        'TRANSFERS OWNERSHIP. Move a note or folder from one person’s vault into another’s — out of a folder somebody shared with you, for example into your own notes. It never takes notes out of the user’s own vault: giving them away is done by the user in the web app (dragging them onto the shared folder in the file tree), and this tool refuses it. This is not a copy and not a reorganisation: the notes leave the source vault and belong to the destination owner afterwards. Whoever owned them stops owning them, and keeps access only if the destination is shared with them — possibly at a narrower permission than they had, or not at all. ALWAYS tell the user this before calling, name who stops being the owner, and get their agreement; a request to tidy up or to move something into another folder does not by itself mean they intend to take ownership of somebody else’s notes. Requires write access at both ends. Wikilinks crossing the new boundary cannot be rewritten (a wikilink cannot name a vault), so the answer lists what was left dangling in each direction rather than repairing it silently. Calling this without `userConfirmedOwnershipTransfer` moves nothing and answers with what the transfer would cost, which is what you put to the user. Use `move` for anything staying inside one vault, which changes no ownership.',
      inputSchema: {
        from: field().min(1),
        fromOwnerId: OWNER_ARG,
        to: field().min(1),
        toOwnerId: z
          .string()
          .min(1)
          .describe('Owner of the destination vault. Required, and must differ from the source.'),
        userConfirmedOwnershipTransfer: z
          .boolean()
          .optional()
          .describe(
            'Set to true ONLY after the user has been told this transfers ownership and has ' +
              'agreed. Leave it out on the first call: the tool then moves nothing and answers ' +
              'with exactly what the transfer would cost, for you to put to the user. Setting ' +
              'it without having asked is a false statement about a conversation that did not ' +
              'happen.',
          ),
      },
    },
    async ({ from, fromOwnerId, to, toOwnerId, userConfirmedOwnershipTransfer }) => {
      try {
        const previousOwner = ownerOf(fromOwnerId);
        // Giving the caller's own notes away cannot be undone by them, and the
        // flag below is only the assistant's word that they agreed. That
        // direction is the person's own action, in the web app, where they
        // confirm it themselves — the same reason share_folder only asks.
        if (previousOwner === requireUserId() && toOwnerId !== previousOwner) {
          throw new AppError(
            'Moving your own notes into someone else’s vault makes them the owner, and only you ' +
              'can do that: drag the note or folder onto the shared folder in the BrainStack web ' +
              'app. Tell the user so; this tool does not do it.',
            'FORBIDDEN',
            403,
          );
        }
        // Taking something out of a vault is a write on that vault.
        await assertWrite(from, fromOwnerId);
        await assertWrite(to, toOwnerId);

        // What the previous owner is left with, which depends on the grants
        // rather than on the notes — so it can be answered before moving.
        const stillWritable = await sharing.canWrite(previousOwner, toOwnerId, to);
        const stillReadable =
          stillWritable || (await sharing.canRead(previousOwner, toOwnerId, to));
        const previousOwnerAccess = stillWritable ? 'write' : stillReadable ? 'read' : 'none';

        // The gate. A description asking the model to warn the user is an
        // instruction, and an instruction can be skipped; by the time the
        // answer explains what the transfer cost, it has already happened.
        // Withholding the move until a flag says the conversation took place
        // is the same warning made structural: the first call cannot move
        // anything, and it hands back the specifics to put to the user.
        if (!userConfirmedOwnershipTransfer) {
          const affected = await notes.list(previousOwner, { folder: from });
          return JSON_TEXT({
            moved: false,
            reason: 'needs the user to agree to a change of ownership',
            wouldTransfer: {
              path: from,
              notes: affected.length,
              fromOwnerId: previousOwner,
              toOwnerId,
              previousOwnerAccessAfterwards: previousOwnerAccess,
            },
            askTheUser:
              `Moving "${from}" into ${toOwnerId}'s vault makes ${toOwnerId} the owner of ` +
              `${affected.length} note(s). ${previousOwner} stops owning them and ` +
              `${
                stillWritable
                  ? 'keeps read and write access through the shared destination.'
                  : stillReadable
                    ? 'is left with read access only, where owning them allowed writing.'
                    : 'is left with no access at all: the destination is not shared back.'
              } They cannot undo this themselves: once they stop owning the notes they ` +
              `cannot move them back, and whether they keep seeing them is from then on the ` +
              `new owner's decision — revoking the share would leave them with nothing. Put ` +
              `this to the user and call again with userConfirmedOwnershipTransfer: true only ` +
              `if they agree.`,
          });
        }
        const result = await notes.moveAcrossVaults({
          fromOwnerId: previousOwner,
          fromPath: from,
          toOwnerId,
          toPath: to,
          viewerId: requireUserId(),
          viewerScopes: (await sharing.listSharedRoots(requireUserId())).map((r) => ({
            ownerId: r.ownerId,
            folderPath: r.folderPath,
          })),
        });

        return JSON_TEXT({
          moved: true,
          ...result,
          ownership: {
            previousOwnerId: previousOwner,
            newOwnerId: toOwnerId,
            previousOwnerAccess,
            tellTheUser: `These notes now belong to ${toOwnerId}; ${previousOwner} no longer owns them and ${
              stillWritable
                ? 'can still read and write them through the shared destination.'
                : stillReadable
                  ? 'can now only read them through the shared destination, where owning them ' +
                    'allowed writing.'
                  : 'can no longer see them at all, because the destination is not shared back ' +
                    'with them. Say this plainly rather than reporting the move as a success.'
            }`,
          },
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete a note, attachment, or folder',
      description:
        'Delete a path. Folders require `recursive: true` unless empty. Does NOT rewrite wikilinks — links pointing here become unresolved.',
      inputSchema: {
        path: field().min(1),
        recursive: z.boolean().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, recursive, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        // What is gone, so the assistant can report the blast radius. This
        // used to answer `undefined`, which the client rejected as an invalid
        // result after the delete had already happened.
        return JSON_TEXT(await notes.remove(ownerOf(ownerId), path, { recursive }));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_links',
    {
      title: 'List backlinks',
      description: 'List every note that links to or embeds the given path (note or attachment).',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        // Not `notes.listLinks` directly: that call is owner-scoped, not
        // permission-aware, and would name a backlink's source even when it
        // sits in a folder this caller was never granted.
        const rows = await listBacklinksSafely(requireUserId(), owner, path, {
          notes,
          crossOwner,
        });
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_outbound_links',
    {
      title: 'List outbound links',
      description:
        'List every note or attachment the given path links to or embeds — the mirror of list_links.',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        const userId = requireUserId();
        // Same masking `linksForOwner` already applies to a shared note: an
        // unreadable target comes back unresolved rather than naming a path
        // outside the grant.
        const rows =
          userId === owner
            ? await notes.listOutboundLinks(owner, path)
            : await crossOwner.linksForOwner(userId, owner, path);
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_related',
    {
      title: 'List related notes',
      description:
        'Notes related to the given path by a shared tag or frontmatter facet (e.g. both using `technologies: nextjs`), ranked by how rare the shared signal is — sharing an uncommon tag outranks sharing a technology half the vault uses. Own vault only; does not take `ownerId`.',
      inputSchema: { path: field().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ path, limit }) => {
      try {
        const userId = requireUserId();
        const rows = await notes.listRelated(userId, path, { limit });
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_unlinked_mentions',
    {
      title: 'List unlinked mentions',
      description:
        "Where a note is named without a wikilink, both ways: `incoming` lists other notes whose text says this note's title or an alias; `outgoing` lists notes whose title this note's text says. Each row has the other note's path, the text as written, how many times, and a snippet. Read-only: to link them, propose the edit to the user and write it with `update_note` once they approve, replacing the text with `[[path|text as written]]`. Own vault only; does not take `ownerId`.",
      inputSchema: { path: field().min(1) },
    },
    async ({ path }) => {
      try {
        const userId = requireUserId();
        return JSON_TEXT(await notes.unlinkedMentions(userId, path));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'gather_context',
    {
      title: 'Gather context for a question or a prompt',
      description:
        "Start here for any question or task about the user's notes: one call instead of search_brain, list_notes and get_note one by one. Pass the user's message as `text` (and, if you like, the vague phrases in it as `terms`). Returns `notes`, ranked: the notes the text names by title, alias or [[link]]; the best full-text hits for the question itself and for each term; and the notes those link to or from (`depth` hops, default 1) — decisions weigh extra. Each note comes with `reason`, `isDecision`, its `checksum` and its body in `excerpt`, whole when it fits `maxChars`; a `truncated` one also lists its `sections` (every heading of the whole note), and one marked `tooLong` is past the size an assistant may write — propose splitting it before adding to it. That is enough to change a note with edit_note or save_notes without opening it — pass the `checksum` as `expectedChecksum`. Open a note with get_note (several with get_notes) only when `truncated` is true and you need the rest. `leftOut` names the strongest notes that did not fit (path, title, reason, no body): open one with get_note if the answer needs it. Returns `unresolved`: terms that matched nothing, and titles several notes share (with `candidates`) — never guess those, ask the user. Reads the user's own vault and the folders other people shared with them: a note in a shared folder comes with its `ownerId` — pass it to get_note with the same `path`. Writes no note; the call is kept in the user's own crawl history, which they can replay in the web app.",
      inputSchema: {
        text: z.string().min(1).max(MAX_TEXT_CHARS),
        terms: z.array(z.string().min(1).max(200)).max(MAX_TERMS).optional(),
        depth: z.number().int().min(0).max(MAX_DEPTH).optional(),
        maxChars: z.number().int().min(500).max(MAX_MAX_CHARS).optional(),
      },
    },
    async (input) => {
      try {
        const userId = requireUserId();
        const sharedScopes = (await sharing.listSharedRoots(userId)).map((r) => ({
          ownerId: r.ownerId,
          folderPath: r.folderPath,
        }));
        const result = await gatherContext({ notes, search }, userId, input, sharedScopes);
        await crawls.record(userId, {
          source: 'assistant',
          clientRef: principal?.clientRef ?? null,
          text: input.text,
          result,
        });
        return JSON_TEXT(result);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'place_note',
    {
      title: 'Find where a new note goes',
      description:
        "Before creating a note: where it belongs, whether one like it already exists, and what it should link to — one call instead of list_tree, search_brain and opening indexes by hand. Pass the `title` it would have and its `text` (or a summary). Returns `duplicates` (notes already called that: propose adding to one of them instead), `folder` (the folder the most related notes live in, with `reason` and its `index` note when it has one — link the new note from it in the same save_notes) and up to two `alternatives`, and `links` (the notes the text names, then the most related; a wikilink cannot cross into another owner's vault). A folder or note in a folder shared with the user comes with its `ownerId`, and a shared folder says whether the user may write there (`writable`). Writes nothing: put the proposal to the user, as for any write. Kept in the user's crawl history like gather_context.",
      inputSchema: {
        title: field().min(1),
        text: z.string().max(MAX_TEXT_CHARS).optional(),
      },
    },
    async ({ title, text }) => {
      try {
        const userId = requireUserId();
        const sharedScopes = (await sharing.listSharedRoots(userId)).map((r) => ({
          ownerId: r.ownerId,
          folderPath: r.folderPath,
        }));
        const { crawl, ...proposal } = await placeNoteInVault(
          { notes, search },
          userId,
          { title, ...(text ? { text } : {}) },
          sharedScopes,
        );
        await crawls.record(userId, {
          source: 'assistant',
          clientRef: principal?.clientRef ?? null,
          text: `Where does “${title}” go?`,
          result: crawl,
        });
        // A folder shared for reading only is still where related notes are,
        // but not somewhere the user can save: say so before they are asked.
        const writable = async <T extends { folder: string; ownerId?: string }>(f: T) =>
          f.ownerId ? { ...f, writable: await sharing.canWrite(userId, f.ownerId, f.folder) } : f;
        return JSON_TEXT({
          ...proposal,
          folder: proposal.folder ? await writable(proposal.folder) : null,
          alternatives: await Promise.all(proposal.alternatives.map(writable)),
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_facets',
    {
      title: 'List facets',
      description:
        "Structured frontmatter metadata other than tags — e.g. `technologies: [nextjs]` or `status: decidido`. Pass `path` for one note's facets (with `ownerId` for a note in a shared folder); omit it (optionally with `key`) to browse every (key, value) pair in use in your own vault, with counts. Browsing never takes another owner's `ownerId`.",
      inputSchema: {
        path: field().optional(),
        key: field().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, key, ownerId }) => {
      try {
        if (path) {
          const owner = await readOwner(path, ownerId);
          return JSON_TEXT(await notes.listFacetsForNote(owner, path));
        }
        // Browsing aggregates a whole vault, and a grant covers one folder of
        // it, so only your own vault can be browsed.
        const userId = requireUserId();
        if (ownerId !== undefined && ownerId !== userId) {
          throw new AppError(
            'browsing facets covers your own vault only; pass `path` to read the facets of one note in a shared folder',
            'FORBIDDEN',
            403,
          );
        }
        return JSON_TEXT(await notes.listFacets(userId, key));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_shared_with_me',
    {
      title: 'List shared folders',
      description:
        'List folders that other users have shared with me. Returns folder path, owner id, owner display name, owner email, permission ("read" or "write"), and granted_at. Pass the owner id as `ownerId` to the note tools to read — or, with write permission, to edit — inside that folder; paths are relative to the owner\'s root.',
      inputSchema: {},
    },
    async () => {
      try {
        const userId = requireUserId();
        return JSON_TEXT(await sharing.listSharedRoots(userId));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_shares',
    {
      title: 'List folders I shared',
      description:
        'List the folders I have shared, who has access to each, and with what permission. Optionally filter to a single folder with `path`.',
      inputSchema: { path: field().optional() },
    },
    async ({ path }) => {
      try {
        const rows = await sharing.listMyShares(requireUserId());
        const wanted = path ? normalizeFolderPath(path) : null;
        return JSON_TEXT(wanted === null ? rows : rows.filter((r) => r.folderPath === wanted));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'share_folder',
    {
      title: 'Ask to share a folder with someone',
      description:
        'Ask to give another person access to a folder, by email. Nothing is shared yet: the request waits for the user to approve it in the BrainStack web app (Settings → Sharing), where they see the folder, the address and the permission. Tell the user that. `permission` is "read" (default) or "write"; write lets them create and edit notes in the folder. Once approved, someone with an account gets access at once and anyone else is emailed an invitation that expires in 7 days. Asking again for the same folder and address updates the request.',
      inputSchema: {
        path: field().min(1),
        email: emailField(),
        permission: z.enum(['read', 'write']).optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ path, email, permission }) => {
      try {
        requireWriteAccess();
        const ownerId = requireUserId();
        const self = await auth.findUserById(ownerId);
        if (self && self.email.toLowerCase() === email.trim().toLowerCase()) {
          throw new AppError("you can't share a folder with yourself", 'INVALID_INPUT', 400);
        }
        // An assistant only ever asks. It reads what other people wrote in
        // folders shared with the user, so a request to share may not be the
        // user's; the grant waits for them, signed in, in the web app.
        const request = await sharing.requestShare({
          ownerId,
          folderPath: path,
          email,
          permission,
          requestedBy: principal?.clientRef ?? null,
        });
        return JSON_TEXT({
          status: 'pending_approval',
          requestId: request.id,
          folderPath: normalizeFolderPath(path),
          permission: permission ?? 'read',
          email,
          expiresAt: request.expiresAt,
          next: 'Ask the user to approve it in the BrainStack web app, under Settings → Sharing.',
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'unshare',
    {
      title: 'Revoke someone from a folder',
      description:
        'Take away one person’s access to a folder and every folder nested in it, by email. Also kills the invitations that could hand it straight back. A no-op when they had no access.',
      inputSchema: { path: field().min(1), email: emailField() },
    },
    async ({ path, email }) => {
      try {
        requireWriteAccess();
        const ownerId = requireUserId();
        // The same answer whether or not the address has an account: this
        // tool is not a way to learn who is a member of the instance.
        const target = await auth.findUserByEmail(email);
        if (target) {
          await sharing.revoke({
            ownerId,
            sharedWithUserId: target.id,
            folderPath: path,
          });
        }
        return JSON_TEXT({
          status: 'revoked',
          folderPath: normalizeFolderPath(path),
          email,
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_brainstack_guide',
    {
      title: 'BrainStack guide for AI assistants',
      description:
        'Return the canonical BrainStack instructions for AI assistants (Skill content).',
      inputSchema: {},
    },
    () => TEXT(GUIDE),
  );

  return server;
}
