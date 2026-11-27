// `@username` mentions: the user's username, and the notes they were mentioned in.
// Pending mentions reach the assistant on their own, with any answer
// (`../notices.ts`); these tools are for setting the name and looking back.

import { USERNAME_RULES } from '@brainstack/core/sentinel';
import { z } from 'zod';

import { field } from '../../config/limits.js';

import type { MentionService } from '../../services/MentionService.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JSON_TEXT } from '../shared.js';
import type { McpToolContext } from '../context.js';

export function registerMentionTools(
  server: McpServer,
  ctx: McpToolContext,
  mentions: MentionService,
): void {
  const { toMcpError, requireUserId, requireWriteAccess } = ctx;

  server.registerTool(
    'set_username',
    {
      title: 'Set my username',
      description: `Set the username other people write after an @ to mention the user in a note ("@ana"); whoever is mentioned hears about it from their own assistant. Call it only with a name the user chose in this conversation. ${USERNAME_RULES}. Fails with ALREADY_EXISTS when someone else has it: ask for another.`,
      inputSchema: { username: field().min(1) },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ username }) => {
      try {
        requireWriteAccess();
        const saved = await mentions.setUsername(requireUserId(), username);
        return JSON_TEXT({ username: saved, mentionAs: `@${saved}` });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_mentions',
    {
      title: 'List my mentions',
      description:
        'The notes the user was mentioned in with their @username, newest first: who wrote it, the note (path, and ownerId for a shared folder), the line, and when. New mentions are already passed on with any tool answer; use this when the user asks to see them again. Also returns their username, null when they have none.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      try {
        const userId = requireUserId();
        const [username, recent] = await Promise.all([
          mentions.getUsername(userId),
          mentions.recent(userId, limit ?? 20),
        ]);
        return JSON_TEXT({
          username,
          mentions: recent.map((m) => ({
            path: m.path,
            ownerId: m.ownerId,
            by: m.author
              ? { username: m.author.username, displayName: m.author.displayName }
              : null,
            line: m.snippet,
            at: new Date(m.createdAt).toISOString(),
          })),
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );
}
