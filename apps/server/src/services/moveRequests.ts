// Approving a move into another vault an assistant asked for: the same outcome
// as the person dragging it there themselves. Permission is checked again
// here, because a grant may have changed since the assistant asked.

import { AppError } from '../lib/errors.js';

import type { CrossVaultMoveResult, NoteService } from './NoteService.js';
import type { SharingService } from './SharingService.js';

export interface ApprovedMove extends CrossVaultMoveResult {
  fromOwnerId: string;
  fromPath: string;
  toOwnerId: string;
  toPath: string;
}

export async function approveMoveRequest(
  deps: { sharing: SharingService; notes: NoteService },
  userId: string,
  requestId: string,
): Promise<ApprovedMove> {
  const request = await deps.sharing.takeMoveRequest(userId, requestId);
  if (!request) throw new AppError('no such move request, or it expired', 'NOT_FOUND', 404);

  // Taking something out of a vault is a write on that vault.
  await deps.sharing.assertCanWrite(userId, request.fromOwnerId, request.fromPath);
  await deps.sharing.assertCanWrite(userId, request.toOwnerId, request.toPath);

  const result = await deps.notes.moveAcrossVaults({
    fromOwnerId: request.fromOwnerId,
    fromPath: request.fromPath,
    toOwnerId: request.toOwnerId,
    toPath: request.toPath,
    viewerId: userId,
    viewerScopes: (await deps.sharing.listSharedRoots(userId)).map((r) => ({
      ownerId: r.ownerId,
      folderPath: r.folderPath,
    })),
  });
  return { ...request, ...result };
}
