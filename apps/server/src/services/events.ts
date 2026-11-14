// What happened, as the services report it.
//
// A service that changes something says so through an `emit` callback the
// wiring hands it, the way `NoteService` reports a folder that is gone. It
// names what changed and in whose vault; who did it and through what is
// filled in by whoever listens (see `events.ts` at the root of `src`), so no
// service has to be told about callers. `actorId` is set here only where the
// service knows better than the request: a sign-up has no caller yet.
//
// Listeners hear an event after the write has landed. They cannot stop it, and
// one that fails changes nothing about the write or its answer.

import type { SharePermission } from './SharingService.js';

export type EventInput =
  | { type: 'note.created'; ownerId: string; path: string }
  | { type: 'note.updated'; ownerId: string; path: string }
  | {
      type: 'note.moved';
      ownerId: string;
      from: string;
      to: string;
      /** Set when the note left `ownerId`'s vault for another one. */
      toOwnerId?: string;
    }
  | { type: 'note.deleted'; ownerId: string; paths: string[]; folders: string[] }
  | { type: 'folder.created'; ownerId: string; path: string }
  | {
      type: 'share.requested';
      ownerId: string;
      path: string;
      /** Who the share would be with, as the request named them. */
      email: string;
      permission: SharePermission;
    }
  | {
      type: 'share.granted';
      ownerId: string;
      path: string;
      userId: string;
      permission: SharePermission;
    }
  | { type: 'share.revoked'; ownerId: string; path: string; userId: string }
  | { type: 'auth.signed_up'; userId: string; method: 'password' | 'google' }
  | { type: 'auth.signed_in'; userId: string }
  | { type: 'api_key.created'; userId: string; keyId: string; name: string; scopes: string[] }
  | { type: 'oauth_client.connected'; userId: string; clientId: string };

/** How a service reports an event. Never throws. */
export type EmitEvent = (event: EventInput & { actorId?: string | null }) => Promise<void>;
