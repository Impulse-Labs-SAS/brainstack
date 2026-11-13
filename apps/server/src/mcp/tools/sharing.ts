// Tools that list shares and ask for new ones. Granting is a request the owner approves in the web app.

import { z } from 'zod';

import { emailField, field } from '../../config/limits.js';
import { AppError } from '../../lib/errors.js';

import { normalizeFolderPath } from '../../services/SharingService.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JSON_TEXT } from '../shared.js';
import type { McpToolContext } from '../context.js';

export function registerSharingTools(server: McpServer, ctx: McpToolContext): void {
  const { sharing, auth, principal, toMcpError, requireUserId, requireWriteAccess } = ctx;

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
}
