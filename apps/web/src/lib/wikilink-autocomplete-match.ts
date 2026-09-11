// Matching logic for `[[` autocomplete — pure, tested in Node without a
// CodeMirror instance, same pattern as import-md.ts. The CM6 extension
// (components/editor/wikilink-autocomplete.ts) only owns the trigger
// detection and the insert; this owns "what counts as a match, in what order".

export interface WikilinkCandidate {
  /** Logical path, e.g. `Proyectos/zuno.md`. */
  path: string;
  title: string;
}

export interface WikilinkMatch extends WikilinkCandidate {
  /** What to insert inside `[[...]]` — path without `.md`. */
  insertTarget: string;
}

function stripMd(path: string): string {
  return path.replace(/\.md$/i, '');
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Ranks candidates for a `[[` query: exact title/basename match first, then
 * prefix matches, then anything containing the query — each tier
 * alphabetical by title. An empty query returns every candidate in that same
 * alphabetical order, so opening `[[` with nothing typed yet still suggests
 * something.
 */
export function matchWikilinkCandidates(
  candidates: readonly WikilinkCandidate[],
  query: string,
  limit = 20,
): WikilinkMatch[] {
  const q = query.trim().toLowerCase();

  const scored = candidates
    .map((c) => {
      const title = c.title.toLowerCase();
      const base = basename(stripMd(c.path)).toLowerCase();
      let tier: number | null;
      if (q === '') tier = 3;
      else if (title === q || base === q) tier = 0;
      else if (title.startsWith(q) || base.startsWith(q)) tier = 1;
      else if (title.includes(q) || base.includes(q)) tier = 2;
      else tier = null;
      return tier === null ? null : { candidate: c, tier };
    })
    .filter((x): x is { candidate: WikilinkCandidate; tier: number } => x !== null);

  scored.sort((a, b) => a.tier - b.tier || a.candidate.title.localeCompare(b.candidate.title));

  return scored.slice(0, limit).map(({ candidate }) => ({
    ...candidate,
    insertTarget: stripMd(candidate.path),
  }));
}
