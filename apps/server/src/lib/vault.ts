// Resolver de vault-root deployment-aware.
//
// Self-host: todos los users (en la práctica, el único user) comparten el
// vault físico apuntado por NOTES_DIR.
//
// Hosted: cada user vive bajo NOTES_DIR/<userId>/. El aislamiento físico
// es una segunda línea de defensa además de la authz lógica del
// SharingService. Ver docs/Sharing-design.md §5.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface VaultRootResolverConfig {
  deployment: 'self-host' | 'hosted';
  notesDirAbs: string;
}

/**
 * Devuelve el path absoluto del vault root del user dado. En hosted, crea
 * el subdir si todavía no existe (idempotente).
 */
export function resolveVaultRoot(
  userId: string,
  cfg: VaultRootResolverConfig,
): string {
  if (cfg.deployment === 'self-host') return cfg.notesDirAbs;
  if (!userId) throw new Error('resolveVaultRoot: userId requerido en hosted');
  const root = join(cfg.notesDirAbs, userId);
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Dado el path físico absoluto de un archivo dentro de NOTES_DIR, devuelve
 * el userId dueño según la convención de hosted (primer segmento del
 * subdir). En self-host devuelve null porque no hay convención por path.
 */
export function ownerIdFromPhysicalPath(
  absoluteFilePath: string,
  cfg: VaultRootResolverConfig,
): string | null {
  if (cfg.deployment === 'self-host') return null;
  const rel = absoluteFilePath
    .slice(cfg.notesDirAbs.length)
    .replace(/^[\\/]+/, '');
  const segs = rel.split(/[\\/]/);
  if (segs.length === 0 || !segs[0]) return null;
  return segs[0];
}
