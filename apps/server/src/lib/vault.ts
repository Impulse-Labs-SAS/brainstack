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

/**
 * Convierte un path lógico (el que conoce el frontend o el agente MCP,
 * sin prefix de owner) al path físico que vive en DB/FS. En self-host es
 * identity; en hosted prefixea `<userId>/`. Idempotente: si el input ya
 * arranca con `<userId>/`, no duplica.
 */
export function toPhysical(
  userId: string,
  logicalPath: string,
  cfg: VaultRootResolverConfig,
): string {
  if (cfg.deployment === 'self-host') return logicalPath;
  if (!userId) throw new Error('toPhysical: userId requerido en hosted');
  const norm = logicalPath.replace(/^[\\/]+/, '');
  if (norm === userId || norm.startsWith(userId + '/')) return norm;
  return `${userId}/${norm}`;
}

/**
 * Inverso de `toPhysical`. En self-host es identity. En hosted strippea
 * el prefix `<userId>/`. Si el path no empieza con el prefix esperado,
 * throw — señal de que un row de otro user se filtró sin querer.
 */
export function toLogical(
  userId: string,
  physicalPath: string,
  cfg: VaultRootResolverConfig,
): string {
  if (cfg.deployment === 'self-host') return physicalPath;
  if (!userId) throw new Error('toLogical: userId requerido en hosted');
  const norm = physicalPath.replace(/^[\\/]+/, '');
  const prefix = userId + '/';
  if (norm === userId) return '';
  if (!norm.startsWith(prefix)) {
    throw new Error(`toLogical: path "${physicalPath}" no pertenece a user "${userId}"`);
  }
  return norm.slice(prefix.length);
}
