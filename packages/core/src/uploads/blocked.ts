// Tipos de archivo cuyo upload está deshabilitado por ahora. Se chequea
// tanto en el cliente (UX: rechazo temprano + toast claro) como en el
// servicio (defense in depth). Centralizar la lista acá garantiza que
// ambos lados queden en sync.
//
// Razón: no todos los modelos de IA aguas abajo procesan audio/video, así
// que mientras la UX no los soporte explícitamente preferimos no permitir
// que entren al brain. Levantar la restricción cuando habilitemos el flujo.

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

export interface BlockedCheck {
  /** Mime declarado por el browser/file API. Puede venir vacío. */
  mime?: string | null | undefined;
  /** Nombre o path completo del archivo — se usa para la extensión. */
  filename: string;
}

/** True si el archivo está en la lista de tipos bloqueados. */
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

export const BLOCKED_UPLOAD_MESSAGE = 'audio/video uploads están deshabilitados por ahora';
