// Shared domain types for BrainStack core.

export type LinkKind = 'wikilink' | 'embed' | 'markdown';
export type LinkTargetType = 'note' | 'attachment' | 'unresolved';

export interface Frontmatter {
  [key: string]: unknown;
}

/** A parsed link as extracted from a markdown body. */
export interface ParsedLink {
  /** Raw target as written (`Pricing`, `Zuno/Pricing`, `img.png`, etc.). */
  rawTarget: string;
  /** Optional section heading (`Nota#Sección`). */
  section: string | null;
  /** Custom alias (`[[Nota|texto]]`). */
  alias: string | null;
  /** Kind of link. */
  kind: LinkKind;
  /** Whether this link is an embed (`![[...]]` or `![](...)`). */
  isEmbed: boolean;
  /** Byte/char offset in the body where the link appears. */
  position: number;
}

/** Result of parsing a single markdown file. */
export interface ParsedNote {
  /** Path relative to NOTES_DIR, forward-slash separated, ends in `.md`. */
  path: string;
  /** From frontmatter `title`, or first H1, or path-derived. */
  title: string;
  frontmatter: Frontmatter;
  body: string;
  /** Hashed body for idempotent re-indexing. */
  checksum: string;
  links: ParsedLink[];
  tags: string[];
}

/** A resolved link, ready to be persisted in the `links` table. */
export interface ResolvedLink {
  sourcePath: string;
  targetPath: string;
  targetType: LinkTargetType;
  linkKind: LinkKind;
  alias: string | null;
  section: string | null;
  position: number;
}

/** A note row as stored in sqlite. */
export interface NoteRow {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  body: string;
  mtime: number;
  checksum: string;
}

/** An attachment row as stored in sqlite. */
export interface AttachmentRow {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  createdAt: number;
}
