// tRPC context creation. The context exposes the same services the MCP layer
// uses, plus the authenticated principal (resolved from cookie or API key).
//
// `sharedRoots` se memoiza por request: muchos procedures dentro del mismo
// request consultan los grants del user (canRead en listados grandes), así
// que hacerlo una sola vez evita N+1.

import type { ApiKeyService } from '../services/ApiKeyService.js';
import type { AuthService, User } from '../services/AuthService.js';
import type { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import type { NoteService } from '../services/NoteService.js';
import type { InviteService } from '../services/InviteService.js';
import type { SearchService } from '../services/SearchService.js';
import type { SharedRoot, SharingService } from '../services/SharingService.js';

import type { Principal } from '../http/middleware/auth.js';

export interface ServerServices {
  auth: AuthService;
  apiKeys: ApiKeyService;
  notes: NoteService;
  search: SearchService;
  sharing: SharingService;
  invites: InviteService;
  crossOwner: CrossOwnerReader;
}

export interface TrpcContext extends ServerServices {
  principal: Principal | null;
  /** Convenience accessor for the logged-in user (null when unauthenticated). */
  user: User | null;
  /** Carpetas compartidas CONMIGO, calculadas a demanda y cacheadas por request. */
  sharedRoots(): Promise<SharedRoot[]>;
}

export function buildContext(services: ServerServices, principal: Principal | null): TrpcContext {
  let cache: SharedRoot[] | null = null;
  return {
    ...services,
    principal,
    user: principal?.user ?? null,
    async sharedRoots(): Promise<SharedRoot[]> {
      if (cache) return cache;
      const userId = principal?.user.id;
      cache = userId ? await services.sharing.listSharedRoots(userId) : [];
      return cache;
    },
  };
}
