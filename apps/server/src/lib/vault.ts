// Logical vs physical note paths.
//
// `notes.path` is the primary key, so two users cannot both own "Inbox/idea.md"
// unless something distinguishes them. The sqlite line solved this on disk, by
// giving each user a directory under NOTES_DIR. Postgres keeps the same shape
// without the disk: the stored path carries the owner as its first segment, and
// the callers never see it.
//
// So `Inbox/idea.md` for user u_42 is stored as `u_42/Inbox/idea.md`, and the
// web app, the MCP client and the agent all keep speaking in logical paths.
// `notes.owner_id` holds the same owner as a column, because a prefix is not
// something you can index or join on.
//
// Self-host has one user and no prefix: both functions are the identity there.

export type Deployment = 'self-host' | 'hosted';

export interface VaultConfig {
  deployment: Deployment;
}

/**
 * Logical to physical. Idempotent: a path that already carries the prefix is
 * returned unchanged, so passing a stored path back through is harmless.
 */
export function toPhysical(userId: string, logicalPath: string, cfg: VaultConfig): string {
  if (cfg.deployment === 'self-host') return logicalPath;
  if (!userId) throw new Error('toPhysical: userId required in hosted');
  const norm = logicalPath.replace(/^[\\/]+/, '');
  if (norm === userId || norm.startsWith(`${userId}/`)) return norm;
  return `${userId}/${norm}`;
}

/**
 * Physical to logical.
 *
 * Throws when the path belongs to somebody else, and that is the point: it is
 * the last line of defence for a query that forgot to filter by owner. A leak
 * shows up as an error rather than as another user's note on screen.
 */
export function toLogical(userId: string, physicalPath: string, cfg: VaultConfig): string {
  if (cfg.deployment === 'self-host') return physicalPath;
  if (!userId) throw new Error('toLogical: userId required in hosted');
  const norm = physicalPath.replace(/^[\\/]+/, '');
  if (norm === userId) return '';
  const prefix = `${userId}/`;
  if (!norm.startsWith(prefix)) {
    throw new Error(`toLogical: path "${physicalPath}" does not belong to user "${userId}"`);
  }
  return norm.slice(prefix.length);
}

/** The owner a stored path belongs to, by convention. Null in self-host. */
export function ownerIdFromPhysicalPath(physicalPath: string, cfg: VaultConfig): string | null {
  if (cfg.deployment === 'self-host') return null;
  const segs = physicalPath.replace(/^[\\/]+/, '').split('/');
  return segs[0] || null;
}
