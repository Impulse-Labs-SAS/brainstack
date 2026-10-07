// MCP server setup. Registers BrainStack tools on a single McpServer instance
// and exposes a helper to connect to a given transport (stdio, HTTP, etc).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Logger } from 'pino';

import { listBacklinksSafely } from '../lib/backlinks.js';
import { AppError } from '../lib/errors.js';

import type { AuthService } from '../services/AuthService.js';
import type { CrawlHistoryService } from '../services/CrawlHistoryService.js';
import type { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import {
  gatherContext,
  MAX_DEPTH,
  MAX_MAX_CHARS,
  MAX_TERMS,
  MAX_TEXT_CHARS,
} from '../services/gatherContext.js';
import type { InviteService } from '../services/InviteService.js';
import { MAX_TREE_DEPTH, type NoteService } from '../services/NoteService.js';
import type { SearchService } from '../services/SearchService.js';
import { normalizeFolderPath, type SharingService } from '../services/SharingService.js';

export interface McpPrincipal {
  /** The authenticated user calling the MCP server. */
  userId: string;
  /**
   * The API key it called with — `oauth:<clientId>` for a client of this
   * server's OAuth provider. Only used to name the assistant in the crawl history.
   */
  clientRef?: string;
}

export interface BuildMcpServerOptions {
  notes: NoteService;
  search: SearchService;
  sharing: SharingService;
  /** Reads across an ownership boundary, masking what the grant does not cover. */
  crossOwner: CrossOwnerReader;
  /** Resolves the email a caller shares with into an account. */
  auth: AuthService;
  /** Used when that email has no account yet. */
  invites: InviteService;
  /** Where `gather_context` leaves each crawl for the Crawl view to replay. */
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

function toMcpError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const message =
    err instanceof AppError
      ? `[${err.code}] ${err.message}`
      : err instanceof Error
        ? err.message
        : 'Unknown error';
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

export function buildMcpServer({
  notes,
  search,
  sharing,
  crossOwner,
  auth,
  invites,
  crawls,
  logger,
  principal,
}: BuildMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'brainstack', version: '0.1.0' },
    { capabilities: { tools: {} } },
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
  const assertWrite = async (path: string, ownerId?: string): Promise<void> => {
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

  /** The `ownerId` argument, described once for every tool that takes it. */
  const OWNER_ARG = z
    .string()
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
        'Full-text search over notes in BrainStack. `scope` controla qué notas se incluyen: `all` (default) las propias y las compartidas conmigo, `mine` solo las propias, `shared` solo las compartidas. Retorna hits rankeados con snippets; cada hit trae el `ownerId` del vault donde vive.',
      inputSchema: {
        query: z.string().min(1),
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
        const includeMine = effectiveScope !== 'shared';
        const sharedScopes =
          effectiveScope !== 'mine'
            ? (await sharing.listSharedRoots(userId)).map((r) => ({
                ownerId: r.ownerId,
                folderPath: r.folderPath,
              }))
            : [];
        const hits = await search.search(userId, query, { limit, includeMine, sharedScopes });
        logger.debug({ query, hits: hits.length, scope: effectiveScope }, 'search_brain');
        return JSON_TEXT(hits);
      } catch (err) {
        logger.error({ err }, 'search_brain failed');
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Read a note',
      description: 'Read a single note from the brain by its path (relative to NOTES_DIR).',
      inputSchema: { path: z.string().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        const note = await notes.get(await readOwner(path, ownerId), path);
        return JSON_TEXT(note);
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
        folder: z.string().optional(),
        tag: z.string().optional(),
        facetKey: z.string().optional(),
        facetValue: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ ownerId, facetKey, facetValue, ...args }) => {
      try {
        const owner = await readOwner(args.folder, ownerId);
        const facet = facetKey && facetValue ? { key: facetKey, value: facetValue } : undefined;
        const rows = await notes.list(owner, { ...args, ...(facet ? { facet } : {}) });
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Create a new note at the given path. Fails if a note already exists. Returns the final path plus `affectedMocs`: the existing `_<Folder>.md` index note for the parent folder, if any, which you should consider updating to link the new note.',
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, content, frontmatter, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        const result = await notes.create(ownerOf(ownerId), path, content, frontmatter);
        return JSON_TEXT(result);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update a note',
      description: 'Replace the contents of an existing note. Fails if the note does not exist.',
      inputSchema: { path: z.string().min(1), content: z.string(), ownerId: OWNER_ARG },
    },
    async ({ path, content, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        const final = await notes.update(ownerOf(ownerId), path, content);
        return TEXT(`Updated ${final}`);
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
        path: z.string().optional(),
        depth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, depth, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        const tree = await notes.listTree(owner, path, depth);
        return JSON_TEXT(tree);
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
        folder: z.string().optional(),
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
      inputSchema: { path: z.string().min(1), ownerId: OWNER_ARG },
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
      inputSchema: { from: z.string().min(1), to: z.string().min(1), ownerId: OWNER_ARG },
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
        'TRANSFERS OWNERSHIP. Move a note or folder from one person’s vault into another’s — for example, out of a folder somebody shared with you and into your own notes. This is not a copy and not a reorganisation: the notes leave the source vault and belong to the destination owner afterwards. Whoever owned them stops owning them, and keeps access only if the destination is shared with them — possibly at a narrower permission than they had, or not at all. ALWAYS tell the user this before calling, name who stops being the owner, and get their agreement; a request to tidy up or to move something into another folder does not by itself mean they intend to take ownership of somebody else’s notes. Requires write access at both ends. Wikilinks crossing the new boundary cannot be rewritten (a wikilink cannot name a vault), so the answer lists what was left dangling in each direction rather than repairing it silently. Calling this without `userConfirmedOwnershipTransfer` moves nothing and answers with what the transfer would cost, which is what you put to the user. Use `move` for anything staying inside one vault, which changes no ownership.',
      inputSchema: {
        from: z.string().min(1),
        fromOwnerId: OWNER_ARG,
        to: z.string().min(1),
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
        // Taking something out of a vault is a write on that vault.
        await assertWrite(from, fromOwnerId);
        await assertWrite(to, toOwnerId);
        const previousOwner = ownerOf(fromOwnerId);

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
        path: z.string().min(1),
        recursive: z.boolean().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, recursive, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        const result = await notes.remove(ownerOf(ownerId), path, { recursive });
        return JSON_TEXT(result);
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
      inputSchema: { path: z.string().min(1), ownerId: OWNER_ARG },
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
      inputSchema: { path: z.string().min(1), ownerId: OWNER_ARG },
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
      inputSchema: { path: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
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
        'Where a note is named without a wikilink, both ways: `incoming` lists other notes whose text says this note\'s title or an alias; `outgoing` lists notes whose title this note\'s text says. Each row has the other note\'s path, the text as written, how many times, and a snippet. Read-only: to link them, propose the edit to the user and write it with `update_note` once they approve, replacing the text with `[[path|text as written]]`. Own vault only; does not take `ownerId`.',
      inputSchema: { path: z.string().min(1) },
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
        'Start here for any question or task about the user\'s own notes: one call instead of search_brain, list_notes and get_note one by one. Pass the user\'s message as `text` (and, if you like, the vague phrases in it as `terms`). Returns `notes`, ranked: the notes the text names by title, alias or [[link]]; the best full-text hits for the question itself and for each term; and the notes those link to or from (`depth` hops, default 1) — decisions weigh extra. Each note comes with `reason`, `isDecision` and its body in `excerpt`, whole when it fits `maxChars`; open a note with get_note only when `truncated` is true and you need the rest. Returns `unresolved`: terms that matched nothing, and titles several notes share (with `candidates`) — never guess those, ask the user. Writes no note; the call is kept in the user\'s own crawl history, which they can replay in the web app. Own vault only: for folders shared with the user, use search_brain with scope="shared".',
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
        const result = await gatherContext({ notes, search }, userId, input);
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
    'list_facets',
    {
      title: 'List facets',
      description:
        'Structured frontmatter metadata other than tags — e.g. `technologies: [nextjs]` or `status: decidido`. Pass `path` for one note\'s facets; omit it (optionally with `key`) to browse every (key, value) pair in use, with counts.',
      inputSchema: {
        path: z.string().optional(),
        key: z.string().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, key, ownerId }) => {
      try {
        if (path) {
          const owner = await readOwner(path, ownerId);
          return JSON_TEXT(await notes.listFacetsForNote(owner, path));
        }
        return JSON_TEXT(await notes.listFacets(ownerOf(ownerId), key));
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
      inputSchema: { path: z.string().optional() },
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
      title: 'Share a folder with someone',
      description:
        'Give another person access to a folder, by email. `permission` is "read" (default) or "write"; write lets them create and edit notes in the folder, which they address by passing your id as `ownerId`. Someone who already has a BrainStack account is granted access immediately; anyone else is emailed an invitation that expires in 7 days. Access covers the folder and everything under it, including notes created later. Re-sharing a folder with the same person changes their permission.',
      inputSchema: {
        path: z.string().min(1),
        email: z.string().email(),
        permission: z.enum(['read', 'write']).optional(),
      },
    },
    async ({ path, email, permission }) => {
      try {
        const ownerId = requireUserId();
        const target = await auth.findUserByEmail(email);

        if (target && target.id !== ownerId) {
          const shareId = await sharing.grant({
            ownerId,
            sharedWithUserId: target.id,
            folderPath: path,
            grantedBy: ownerId,
            permission,
          });
          return JSON_TEXT({
            status: 'granted',
            shareId,
            folderPath: normalizeFolderPath(path),
            permission: permission ?? 'read',
            sharedWith: { userId: target.id, email: target.email },
          });
        }

        const invite = await invites.create({
          ownerId,
          folderPath: path,
          mode: 'email',
          inviteeEmail: email,
          permission,
        });
        // The accept token is deliberately left out of the answer. It is a
        // bearer credential, and the invitee already has it in their inbox;
        // repeating it here would copy it into a chat transcript for no gain.
        return JSON_TEXT({
          status: 'invited',
          inviteId: invite.inviteId,
          folderPath: normalizeFolderPath(path),
          permission: permission ?? 'read',
          invitedEmail: email,
          expiresAt: invite.expiresAt,
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
        'Take away one person’s access to a folder, by email. Also kills the invitations that could hand it straight back. A no-op when they had no access.',
      inputSchema: { path: z.string().min(1), email: z.string().email() },
    },
    async ({ path, email }) => {
      try {
        const ownerId = requireUserId();
        const target = await auth.findUserByEmail(email);
        if (!target) {
          throw new AppError(`no account for ${email}`, 'NOT_FOUND', 404);
        }
        await sharing.revoke({
          ownerId,
          sharedWithUserId: target.id,
          folderPath: path,
        });
        return JSON_TEXT({
          status: 'revoked',
          folderPath: normalizeFolderPath(path),
          revokedFrom: { userId: target.id, email: target.email },
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
    async () => {
      try {
        const guide = await readInstructions();
        return TEXT(guide);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  return server;
}

/**
 * Where this module lives, when that can be known.
 *
 * `import.meta` exists in ES modules and nowhere else. A bundler that emits
 * CommonJS — Netlify's does, for some entry points — leaves it undefined, and
 * reading `.url` off it throws before any fallback gets a chance. So the
 * question is asked carefully and answered with null when it cannot be.
 */
function moduleDir(): string | null {
  try {
    const url = import.meta?.url;
    return typeof url === 'string' ? dirname(fileURLToPath(url)) : null;
  } catch {
    return null;
  }
}

async function readInstructions(): Promise<string> {
  const here = moduleDir();
  const candidates = [
    // First, because it is the one that holds in a bundle: the file is carried
    // in by `included_files` and lands relative to the function's root.
    resolve(process.cwd(), 'packages/skill/INSTRUCTIONS.md'),
    // Then relative to this file, which is what works when running from source
    // regardless of where the process was launched.
    ...(here
      ? [
          resolve(here, '../../../../packages/skill/INSTRUCTIONS.md'),
          resolve(here, '../../../packages/skill/INSTRUCTIONS.md'),
        ]
      : []),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // try next
    }
  }
  throw new AppError('INSTRUCTIONS.md not found', 'INTERNAL');
}
