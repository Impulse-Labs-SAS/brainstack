// @brainstack/server — the server's building blocks, for code that runs inside
// this repository's workspace. Only `@brainstack/server/plugin` (`extend.ts`)
// is a contract for code outside it; what is exported here may change in any
// release.

// --- Boot and plugins --------------------------------------------------------
export * from './extend.js';

// --- Config and logging ------------------------------------------------------
export { _resetConfigForTests, type AppEnv } from './config/env.js';
export { getLogger } from './lib/logger.js';
export { AppError } from './lib/errors.js';

// --- Vault paths -------------------------------------------------------------
export {
  ownerIdFromPhysicalPath,
  toLogical,
  toPhysical,
} from './lib/vault.js';

// --- Service graph -----------------------------------------------------------
export {
  buildServices,
  connectAndBuild,
  type BuildServicesOptions,
  type Services,
} from './wiring.js';

// --- HTTP --------------------------------------------------------------------
export { buildApp, type BuildAppOptions } from './http/app.js';
export { SESSION_COOKIE, type AuthBindings, type Principal } from './http/middleware/auth.js';

// --- MCP ---------------------------------------------------------------------
export {
  buildMcpServer,
  type BuildMcpServerOptions,
  type McpPrincipal,
} from './mcp/server.js';

// --- tRPC --------------------------------------------------------------------
export { appRouter, type AppRouter } from './trpc/router.js';

// --- Services ----------------------------------------------------------------
export { ApiKeyService, type ApiKey, type CreatedApiKey } from './services/ApiKeyService.js';
export { AuthService, type Session, type User } from './services/AuthService.js';
export { CrossOwnerReader, type CrossOwnerLink } from './services/CrossOwnerReader.js';
export { InviteService, type CreatedInvite } from './services/InviteService.js';
export {
  MAX_TREE_DEPTH,
  NoteService,
  type NoteRowDto,
  type TreeNode,
} from './services/NoteService.js';
export { backfillOwnerId, type OwnerBackfillResult } from './services/OwnerBackfill.js';
export { SearchService, type SearchHit } from './services/SearchService.js';
export {
  SharingService,
  normalizeFolderPath,
  pathFallsUnder,
  type SharedRoot,
  type ShareMember,
} from './services/SharingService.js';
export { TotpService, type TotpEnrollment } from './services/TotpService.js';
