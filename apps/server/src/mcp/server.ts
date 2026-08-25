// MCP server setup. Registers BrainStack tools on a single McpServer instance
// and exposes a helper to connect to a given transport (stdio, HTTP, etc).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Logger } from 'pino';

import { AppError } from '../lib/errors.js';

import type { AuthService } from '../services/AuthService.js';
import type { InviteService } from '../services/InviteService.js';
import { MAX_TREE_DEPTH, type NoteService } from '../services/NoteService.js';
import type { SearchService } from '../services/SearchService.js';
import { normalizeFolderPath, type SharingService } from '../services/SharingService.js';

export interface McpPrincipal {
  /** ID del user autenticado que invoca el MCP. */
  userId: string;
}

export interface BuildMcpServerOptions {
  notes: NoteService;
  search: SearchService;
  sharing: SharingService;
  /** Resolves the email a caller shares with into an account. */
  auth: AuthService;
  /** Used when that email has no account yet. */
  invites: InviteService;
  logger: Logger;
  /**
   * Principal del request actual. Requerido en hosted; opcional en
   * self-host (sharing.enabled=false hace que assertCanRead/Write
   * pasen sin chequear).
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
  auth,
  invites,
  logger,
  principal,
}: BuildMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'brainstack', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // En hosted exigimos principal. En self-host puede faltar; sharing
  // hace short-circuit y los asserts son no-op.
  const requireUserId = (): string => {
    if (principal?.userId) return principal.userId;
    if (sharing.enabled) {
      throw new AppError('mcp request sin principal', 'UNAUTHORIZED', 401);
    }
    return '';
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

  const assertRead = (path: string, ownerId?: string): Promise<void> =>
    sharing.assertCanRead(requireUserId(), ownerOf(ownerId), path);

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
    if (owner === userId) await sharing.assertNotShadowingShare(userId, path);
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
        'Full-text search over notes in BrainStack. `scope` controla qué notas se incluyen: `mine` (default) solo las propias, `shared` solo las compartidas conmigo, `all` ambas. Retorna hits rankeados con snippets.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        scope: z.enum(['mine', 'shared', 'all']).optional(),
      },
    },
    async ({ query, limit, scope }) => {
      try {
        const userId = requireUserId();
        const effectiveScope = scope ?? 'mine';
        const includeMine = effectiveScope !== 'shared';
        const sharedScopes =
          effectiveScope !== 'mine' && sharing.enabled
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
        await assertRead(path, ownerId);
        const note = await notes.get(ownerOf(ownerId), path);
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
        'List notes in BrainStack. Filter by folder prefix, tag, or frontmatter status. Sorted by mtime desc.',
      inputSchema: {
        folder: z.string().optional(),
        tag: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ ownerId, ...args }) => {
      try {
        const owner = ownerOf(ownerId);
        if (owner !== requireUserId()) await assertRead(args.folder ?? '', ownerId);
        const rows = await notes.list(owner, args);
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
        const owner = ownerOf(ownerId);
        if (owner !== requireUserId()) await assertRead(path ?? '', ownerId);
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
        const owner = ownerOf(ownerId);
        if (owner !== requireUserId()) await assertRead(args.folder ?? '', ownerId);
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
        await assertRead(path, ownerId);
        const rows = await notes.listLinks(ownerOf(ownerId), path);
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  if (sharing.enabled) {
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
  }

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
