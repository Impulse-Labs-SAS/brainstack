// tRPC context creation. The context exposes the same services the MCP layer
// uses, plus the authenticated principal (resolved from cookie or API key).

import type { ApiKeyService } from '../services/ApiKeyService.js';
import type { AuthService, User } from '../services/AuthService.js';
import type { NoteService } from '../services/NoteService.js';
import type { SearchService } from '../services/SearchService.js';

import type { Principal } from '../http/middleware/auth.js';

export interface ServerServices {
  auth: AuthService;
  apiKeys: ApiKeyService;
  notes: NoteService;
  search: SearchService;
}

export interface TrpcContext extends ServerServices {
  principal: Principal | null;
  /** Convenience accessor for the logged-in user (null when unauthenticated). */
  user: User | null;
}

export function buildContext(
  services: ServerServices,
  principal: Principal | null,
): TrpcContext {
  return {
    ...services,
    principal,
    user: principal?.user ?? null,
  };
}
