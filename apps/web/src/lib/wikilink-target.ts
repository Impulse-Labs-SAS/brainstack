// Splits a raw `[[...]]` inner string into target/alias/section, mirroring
// `splitWikilinkBody` in packages/core/src/parser/wikilinks.ts (alias first,
// then section) so the web renderer resolves exactly what the server indexed.
//
// Before this existed, `remark-wikilinks.ts` split only `|` and
// `wikilinks-client.ts` split nothing, so `[[Note#Section]]` indexed fine on
// the server but always rendered as a broken link here — two independent
// copies of this logic had drifted apart. Import this instead of writing a
// third one.

export interface SplitWikilinkTarget {
  target: string;
  alias: string | null;
  section: string | null;
}

export function splitWikilinkTarget(raw: string): SplitWikilinkTarget {
  let working = raw.trim();

  let alias: string | null = null;
  const pipeIdx = working.indexOf('|');
  if (pipeIdx !== -1) {
    alias = working.slice(pipeIdx + 1).trim();
    working = working.slice(0, pipeIdx).trim();
  }

  let section: string | null = null;
  const hashIdx = working.indexOf('#');
  if (hashIdx !== -1) {
    section = working.slice(hashIdx + 1).trim();
    working = working.slice(0, hashIdx).trim();
  }

  return { target: working, alias: alias || null, section: section || null };
}
