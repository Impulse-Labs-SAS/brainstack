// What an API key may do. A key carries scopes; until now they were stored
// and never read, so a key made "read only" could write, share and delete
// like any other.

/** The scopes a key can be given. */
export const API_KEY_SCOPES = ['notes:read', 'notes:write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Whether a credential with these scopes may change anything. No scopes at
 * all — every key made before scopes meant something — and the OAuth grant's
 * `mcp` scope keep full access; a key given scopes without `notes:write` is
 * read-only.
 */
export function scopesAllowWrite(scopes: readonly string[]): boolean {
  return scopes.length === 0 || scopes.includes('notes:write') || scopes.includes('mcp');
}

export const READ_ONLY_MESSAGE = 'this API key is read-only: it cannot change, move, share or delete';
