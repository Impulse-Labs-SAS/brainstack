// Approving a share an assistant asked for: the same outcome as the owner
// sharing the folder by hand. An existing account gets the grant; any other
// address gets an email invitation.

import { AppError } from '../lib/errors.js';

import type { AuthService } from './AuthService.js';
import type { CreatedInvite, InviteService } from './InviteService.js';
import type { SharingService } from './SharingService.js';

export type ApprovedShare =
  | { status: 'granted'; folderPath: string; email: string; permission: 'read' | 'write' }
  | {
      status: 'invited';
      folderPath: string;
      email: string;
      permission: 'read' | 'write';
      expiresAt: CreatedInvite['expiresAt'];
    };

export async function approveShareRequest(
  deps: { sharing: SharingService; invites: InviteService; auth: AuthService },
  ownerId: string,
  requestId: string,
): Promise<ApprovedShare> {
  const request = await deps.sharing.takeShareRequest(ownerId, requestId);
  if (!request) throw new AppError('no such share request, or it expired', 'NOT_FOUND', 404);

  const target = await deps.auth.findUserByEmail(request.email);
  if (target?.id === ownerId) {
    throw new AppError("you can't share a folder with yourself", 'INVALID_INPUT', 400);
  }
  if (target) {
    await deps.sharing.grant({
      ownerId,
      sharedWithUserId: target.id,
      folderPath: request.folderPath,
      grantedBy: ownerId,
      permission: request.permission,
    });
    return { status: 'granted', ...request };
  }

  const invite = await deps.invites.create({
    ownerId,
    folderPath: request.folderPath,
    mode: 'email',
    inviteeEmail: request.email,
    permission: request.permission,
  });
  return { status: 'invited', ...request, expiresAt: invite.expiresAt };
}
