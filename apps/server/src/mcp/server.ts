// MCP server setup. Registers BrainStack tools on a single McpServer instance
// and exposes a helper to connect to a given transport (stdio, HTTP, etc).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Logger } from 'pino';

import { AppError } from '../lib/errors.js';

import type { NoteService } from '../services/NoteService.js';
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
    'add_to_inbox',
    {
      title: 'Add a note to the inbox',
      description: 'Create a new note in the Inbox/ folder. Use this for quick capture without classifying.',
      inputSchema: { content: z.string().min(1), title: z.string().optional() },
    },
    async ({ content, title }) => {
      try {
        const path = await notes.addToInbox(content, title);
        return TEXT(`Saved to ${path}`);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description: 'Create a new note at the given path. Fails if a note already exists.',
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ path, content, frontmatter }) => {
      try {
        const final = await notes.create(path, content, frontmatter);
        return TEXT(`Created ${final}`);
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
