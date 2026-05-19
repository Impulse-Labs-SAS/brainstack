// MCP server setup. Registers BrainStack tools on a single McpServer instance
// and exposes a helper to connect to a given transport (stdio, HTTP, etc).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Logger } from 'pino';

import { AppError } from '../lib/errors.js';

import { MAX_TREE_DEPTH, type NoteService } from '../services/NoteService.js';
import type { SearchService } from '../services/SearchService.js';

export interface BuildMcpServerOptions {
  notes: NoteService;
  search: SearchService;
  logger: Logger;
}

const TEXT = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const JSON_TEXT = (value: unknown) =>
  ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

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
  logger,
}: BuildMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'brainstack', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'search_brain',
    {
      title: 'Search the brain',
      description: 'Full-text search over every note in BrainStack. Returns ranked hits with snippets.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ query, limit }) => {
      try {
        const hits = search.search(query, { limit });
        logger.debug({ query, hits: hits.length }, 'search_brain');
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
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      try {
        const note = await notes.get(path);
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
      },
    },
    async (args) => {
      try {
        const rows = notes.list(args);
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
      },
    },
    async ({ path, content, frontmatter }) => {
      try {
        const result = await notes.create(path, content, frontmatter);
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
      inputSchema: { path: z.string().min(1), content: z.string() },
    },
    async ({ path, content }) => {
      try {
        const final = await notes.update(path, content);
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
      },
    },
    async ({ path, depth }) => {
      try {
        const tree = await notes.listTree(path, depth);
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
      },
    },
    async (args) => {
      try {
        const rows = notes.listDecisions(args);
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
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      try {
        const final = await notes.createFolder(path);
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
      inputSchema: { from: z.string().min(1), to: z.string().min(1) },
    },
    async ({ from, to }) => {
      try {
        const result = await notes.move(from, to);
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
      },
    },
    async ({ path, recursive }) => {
      try {
        const result = await notes.remove(path, { recursive });
        return JSON_TEXT(result);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'upload_attachment',
    {
      title: 'Upload an attachment',
      description:
        'Write a binary attachment under Attachments/. `data_base64` is the file content base64-encoded. Returns the final path so it can be embedded as ![[…]].',
      inputSchema: {
        path: z.string().min(1),
        data_base64: z.string().min(1),
        mime: z.string().optional(),
      },
    },
    async ({ path, data_base64, mime }) => {
      try {
        const final = await notes.uploadAttachment({
          path,
          dataBase64: data_base64,
          mime,
        });
        return TEXT(final);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_attachment',
    {
      title: 'Read an attachment',
      description:
        'Return the bytes of an attachment under Attachments/, base64-encoded, along with size and mtime.',
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      try {
        const result = await notes.getAttachment(path);
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
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      try {
        const rows = notes.listLinks(path);
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_brainstack_guide',
    {
      title: 'BrainStack guide for AI assistants',
      description: 'Return the canonical BrainStack instructions for AI assistants (Skill content).',
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

async function readInstructions(): Promise<string> {
  // Resolve relative to this file regardless of where the server is launched.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../../packages/skill/INSTRUCTIONS.md'),
    resolve(here, '../../../packages/skill/INSTRUCTIONS.md'),
    resolve(process.cwd(), 'packages/skill/INSTRUCTIONS.md'),
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
