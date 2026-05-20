// Client-side wikilink resolver. Mirrors the rules of
// packages/core/src/resolver/wikilinks.ts but without node:path imports so
// it can run in the browser. Inputs come from the file tree fetched via
// trpc.notes.tree.

import { attachmentUrl } from './server-url';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'other';

export interface TreeIndex {
  notes: Set<string>;
  attachments: Set<string>;
}

export interface ResolvedAttachment {
  kind: AttachmentKind;
  src: string;
  /** Logical posix path. */
  path: string;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogg', 'mov', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const PDF_EXT = new Set(['pdf']);

export function kindForExtension(ext: string): AttachmentKind {
  const e = ext.toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (PDF_EXT.has(e)) return 'pdf';
  return 'other';
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function extOf(p: string): string | null {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  if (i <= 0) return null;
  return base.slice(i + 1).toLowerCase();
}

function withMd(target: string): string {
  return target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
}

export interface TreeNodeLike {
  path: string;
  type: 'folder' | 'note' | 'attachment';
  children?: TreeNodeLike[];
}

export function buildIndex(root: TreeNodeLike | null | undefined): TreeIndex {
  const notes = new Set<string>();
  const attachments = new Set<string>();
  if (!root) return { notes, attachments };
  const walk = (node: TreeNodeLike): void => {
    if (node.type === 'note' && node.path) notes.add(node.path);
    else if (node.type === 'attachment' && node.path) attachments.add(node.path);
    if (node.children) for (const c of node.children) walk(c);
  };
  walk(root);
  return { notes, attachments };
}

/** Resolve a wikilink target to a note path (with .md). */
export function resolveNoteTarget(
  target: string,
  sourcePath: string,
  idx: TreeIndex,
): string | null {
  const raw = target.replace(/\\/g, '/');
  if (raw.includes('/')) {
    const t = withMd(raw);
    return idx.notes.has(t) ? t : null;
  }
  const filename = withMd(raw);
  const sourceDir = dirOf(sourcePath);
  const sameFolder = sourceDir === '' ? filename : `${sourceDir}/${filename}`;
  if (idx.notes.has(sameFolder)) return sameFolder;
  const descendants: string[] = [];
  for (const p of idx.notes) {
    if (basename(p) !== filename) continue;
    if (sourceDir === '' || p.startsWith(`${sourceDir}/`)) descendants.push(p);
  }
  if (descendants.length === 1) return descendants[0]!;
  const global: string[] = [];
  for (const p of idx.notes) if (basename(p) === filename) global.push(p);
  if (global.length === 1) return global[0]!;
  return null;
}

export function resolveAttachmentTarget(
  target: string,
  idx: TreeIndex,
): string | null {
  const raw = target.replace(/\\/g, '/');
  if (idx.attachments.has(raw)) return raw;
  const name = basename(raw);
  const matches: string[] = [];
  for (const p of idx.attachments) if (basename(p) === name) matches.push(p);
  if (matches.length === 1) return matches[0]!;
  return null;
}

/** Decide how an `![[target]]` should render. */
export function resolveEmbed(
  target: string,
  sourcePath: string,
  idx: TreeIndex,
): ResolvedAttachment | { kind: 'note'; path: string } | null {
  const ext = extOf(target);
  if (ext && ext !== 'md') {
    const attPath = resolveAttachmentTarget(target, idx);
    if (!attPath) return null;
    return {
      kind: kindForExtension(ext),
      src: attachmentUrl(attPath),
      path: attPath,
    };
  }
  const notePath = resolveNoteTarget(target, sourcePath, idx);
  if (notePath) return { kind: 'note', path: notePath };
  return null;
}

export function notePathToRoute(path: string): string {
  return `/notes/${encodePath(path.replace(/\.md$/i, ''))}`;
}

export function attachmentPathToRoute(path: string): string {
  return `/files/${encodePath(path)}`;
}

export function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
