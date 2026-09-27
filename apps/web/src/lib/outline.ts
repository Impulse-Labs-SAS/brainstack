// A note's headings, for the Outline tab: level, text and the line they sit
// on. Headings inside code fences are code, not structure, and do not count.

export interface OutlineHeading {
  level: 1 | 2 | 3;
  text: string;
  /** 1-based line in the text given, for moving the editor there. */
  line: number;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

export function extractOutline(markdown: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  let fence: string | null = null;
  markdown.split('\n').forEach((raw, i) => {
    const f = raw.match(FENCE);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (f[1] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = raw.match(HEADING);
    if (!m) return;
    const text = m[2]!.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
    out.push({ level: m[1]!.length as 1 | 2 | 3, text, line: i + 1 });
  });
  return out;
}
