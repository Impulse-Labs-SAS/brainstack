// Lista de tipos bloqueados, duplicada del lado del cliente para evitar
// tirar de @brainstack/core (que importa node:fs y demás). Mantener en
// sync con packages/core/src/uploads/blocked.ts — un test en el server
// chequea que el servidor rechaza estos mismos sets.

export const BLOCKED_UPLOAD_MIMES: readonly string[] = ['audio/', 'video/'];

export const BLOCKED_UPLOAD_EXTS: readonly string[] = [
  'mp3',
  'wav',
  'ogg',
  'flac',
  'aac',
  'm4a',
  'opus',
  'webm',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'mpeg',
  'mpg',
];

export const BLOCKED_UPLOAD_MESSAGE = 'audio/video uploads están deshabilitados por ahora';

export interface BlockedCheck {
  mime?: string | null | undefined;
  filename: string;
}

export function isBlockedUpload({ mime, filename }: BlockedCheck): boolean {
  const m = (mime ?? '').toLowerCase();
  if (m && BLOCKED_UPLOAD_MIMES.some((prefix) => m.startsWith(prefix))) {
    return true;
  }
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = filename.slice(dot + 1).toLowerCase();
  return BLOCKED_UPLOAD_EXTS.includes(ext);
}
