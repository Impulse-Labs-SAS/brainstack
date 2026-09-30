// Resolve a wikilink target string to an actual note path.
// Rules (from Modelo-de-datos.md):
//   1. Match exact path if the wikilink already includes one (e.g. `Zuno/Pricing`).
//   2. Match in the same folder as the source note.
//   3. Match in any descendant folder of the source's folder.
//   4. Unique match anywhere in the brain.
//   5. Otherwise: unresolved (multiple matches → ambiguous, callers can warn).

import type { LinkTargetType, ParsedLink, ResolvedLink } from '../types.js';

import { toPosixPath } from '../paths.js';

export interface ResolutionInputs {
  /** Posix path of the source note (relative to NOTES_DIR). */
  sourcePath: string;
  /** All known note paths in the brain (posix, relative). */
  noteIndex: ReadonlySet<string>;
  /** All known attachment paths in the brain (posix, relative). */
  attachmentIndex: ReadonlySet<string>;
  /**
   * Owner id of every known path (note or attachment). NULL only for a row
   * written before ownership existed. Needed only when `allowedOwners` is set.
   */
  ownerByPath?: ReadonlyMap<string, string | null>;
  /**
   * When set, only resolutions whose owner is in it are accepted. Targets
   * outside it degrade to `unresolved`, which masks wikilinks that cross into
   * a vault the reader cannot see. When absent, every owner is accepted.
   */
  allowedOwners?: ReadonlySet<string>;
}

export interface ResolutionResult {
  targetPath: string;
  targetType: LinkTargetType;
  /** True if more than one candidate matched the wikilink. */
  ambiguous: boolean;
  /** All matching candidates (only populated when `ambiguous` is true). */
  candidates: string[];
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function withMdExtension(target: string): string {
  return target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
}

/** Resolve a single parsed link (wikilink, embed, or markdown) to a target. */
export function resolveLink(link: ParsedLink, ctx: ResolutionInputs): ResolutionResult {
  const raw = toPosixPath(link.rawTarget);

  let result: ResolutionResult;
  // Markdown-style links are always treated as exact, relative-to-source paths.
  if (link.kind === 'markdown') {
    result = resolveExact(raw, ctx, link);
  } else {
    // Embeds with an explicit non-.md extension are attachment lookups.
    const ext = extensionOf(raw);
    if (link.isEmbed && ext && ext !== 'md') {
      result = resolveAttachment(raw, ctx);
    } else {
      // Wikilinks and note-embeds: try the full ladder.
      result = resolveNote(raw, ctx, link);
    }
  }
  return maskByOwner(result, ctx);
}

/**
 * Si `ctx.allowedOwners` está definido, degradar a `unresolved` cualquier
 * resolución que apunte a un path cuyo owner no esté en el set. Para
 * matches ambiguos, primero filtra candidates por owner; si queda 1 se
 * promueve a resuelto, si quedan >1 sigue ambiguo, si 0 va a unresolved.
 */
function maskByOwner(result: ResolutionResult, ctx: ResolutionInputs): ResolutionResult {
  if (!ctx.allowedOwners || !ctx.ownerByPath) return result;
  const ownerOf = (p: string): string | null => ctx.ownerByPath?.get(p) ?? null;

  if (result.ambiguous) {
    const filtered = result.candidates.filter((p) => {
      const o = ownerOf(p);
      return o !== null && ctx.allowedOwners!.has(o);
    });
    if (filtered.length === 1) {
      return {
        targetPath: filtered[0]!,
        targetType: result.targetType === 'unresolved' ? 'note' : result.targetType,
        ambiguous: false,
        candidates: [],
      };
    }
    if (filtered.length === 0) {
      return { ...result, targetType: 'unresolved', ambiguous: false, candidates: [] };
    }
    return { ...result, candidates: filtered };
  }

  if (result.targetType === 'unresolved') return result;
  const owner = ownerOf(result.targetPath);
  if (owner === null || !ctx.allowedOwners.has(owner)) {
    return { ...result, targetType: 'unresolved' };
  }
  return result;
}

function extensionOf(target: string): string | null {
  const base = basename(target);
  const dot = base.lastIndexOf('.');
  if (dot === -1 || dot === 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

function resolveExact(raw: string, ctx: ResolutionInputs, link: ParsedLink): ResolutionResult {
  // Relative paths are resolved against the source's folder.
  const candidate = raw.startsWith('/') ? raw.slice(1) : joinPath(dirOf(ctx.sourcePath), raw);
  const normalised = toPosixPath(candidate);

  if (ctx.noteIndex.has(normalised)) {
    return { targetPath: normalised, targetType: 'note', ambiguous: false, candidates: [] };
  }
  if (ctx.attachmentIndex.has(normalised)) {
    return {
      targetPath: normalised,
      targetType: 'attachment',
      ambiguous: false,
      candidates: [],
    };
  }
  return {
    targetPath: normalised,
    targetType: 'unresolved',
    ambiguous: false,
    candidates: [],
  };
  void link;
}

function joinPath(dir: string, rel: string): string {
  if (dir === '') return rel;
  return `${dir}/${rel}`;
}

function resolveAttachment(raw: string, ctx: ResolutionInputs): ResolutionResult {
  if (ctx.attachmentIndex.has(raw)) {
    return { targetPath: raw, targetType: 'attachment', ambiguous: false, candidates: [] };
  }
  // Search by basename anywhere.
  const target = basename(raw);
  const matches: string[] = [];
  for (const path of ctx.attachmentIndex) {
    if (basename(path) === target) matches.push(path);
  }
  if (matches.length === 1) {
    return {
      targetPath: matches[0] ?? raw,
      targetType: 'attachment',
      ambiguous: false,
      candidates: [],
    };
  }
  if (matches.length > 1) {
    return {
      targetPath: raw,
      targetType: 'unresolved',
      ambiguous: true,
      candidates: matches,
    };
  }
  return { targetPath: raw, targetType: 'unresolved', ambiguous: false, candidates: [] };
}

function resolveNote(raw: string, ctx: ResolutionInputs, link: ParsedLink): ResolutionResult {
  // 1. If the target already includes a path separator, treat as exact (with `.md` appended).
  if (raw.includes('/')) {
    const target = withMdExtension(raw);
    if (ctx.noteIndex.has(target)) {
      return { targetPath: target, targetType: 'note', ambiguous: false, candidates: [] };
    }
    return { targetPath: target, targetType: 'unresolved', ambiguous: false, candidates: [] };
  }

  const filename = withMdExtension(raw);
  const sourceDir = dirOf(ctx.sourcePath);

  // 2. Same folder as source.
  const sameFolder = joinPath(sourceDir, filename);
  if (ctx.noteIndex.has(sameFolder)) {
    return {
      targetPath: sameFolder,
      targetType: 'note',
      ambiguous: false,
      candidates: [],
    };
  }

  // 3. Any descendant folder of source's folder.
  const descendantMatches: string[] = [];
  for (const path of ctx.noteIndex) {
    if (basename(path) !== filename) continue;
    if (sourceDir === '' || path.startsWith(`${sourceDir}/`)) descendantMatches.push(path);
  }
  if (descendantMatches.length === 1) {
    return {
      targetPath: descendantMatches[0] ?? filename,
      targetType: 'note',
      ambiguous: false,
      candidates: [],
    };
  }

  // 4. Unique match anywhere.
  const globalMatches: string[] = [];
  for (const path of ctx.noteIndex) {
    if (basename(path) === filename) globalMatches.push(path);
  }
  if (globalMatches.length === 1) {
    return {
      targetPath: globalMatches[0] ?? filename,
      targetType: 'note',
      ambiguous: false,
      candidates: [],
    };
  }
  if (globalMatches.length > 1) {
    return {
      targetPath: filename,
      targetType: 'unresolved',
      ambiguous: true,
      candidates: globalMatches,
    };
  }

  return {
    targetPath: filename,
    targetType: 'unresolved',
    ambiguous: false,
    candidates: [],
  };
  void link;
}

/** Resolve every link in a parsed note, producing rows ready for the `links` table. */
export function resolveLinks(
  links: readonly ParsedLink[],
  ctx: ResolutionInputs,
): { resolved: ResolvedLink[]; ambiguous: { link: ParsedLink; candidates: string[] }[] } {
  const resolved: ResolvedLink[] = [];
  const ambiguous: { link: ParsedLink; candidates: string[] }[] = [];

  for (const link of links) {
    const result = resolveLink(link, ctx);
    if (result.ambiguous) {
      ambiguous.push({ link, candidates: result.candidates });
    }
    resolved.push({
      sourcePath: ctx.sourcePath,
      targetPath: result.targetPath,
      targetType: result.targetType,
      linkKind: link.kind,
      alias: link.alias,
      section: link.section,
      position: link.position,
    });
  }

  return { resolved, ambiguous };
}
