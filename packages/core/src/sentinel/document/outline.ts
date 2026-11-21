// A document's headings as a tree of sections.
//
// Each section holds its own text — its heading line and what comes before its
// first subsection — and its subsections. Text before the first heading is a
// section of its own, with no heading (level 0). Headings inside code fences are
// text, not structure.

export interface Heading {
  /** 1 for `#` … 6 for `######`. */
  level: number;
  text: string;
}

export interface Section {
  /** Absent for the text before the first heading. */
  heading?: Heading;
  /** The heading line and the text up to the first subsection. */
  head: string;
  children: Section[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function parseOutline(text: string): Section[] {
  const roots: Section[] = [];
  const stack: Section[] = [];
  let lines: string[] = [];
  let current: Section | null = null;
  let fence: string | null = null;

  const close = () => {
    if (current) current.head = lines.join('\n').trim();
    lines = [];
  };
  const open = (section: Section) => {
    close();
    const level = section.heading?.level ?? 0;
    // The text before the first heading contains nothing: any heading closes it.
    while (stack.length > 0 && (!stack.at(-1)!.heading || stack.at(-1)!.heading!.level >= level))
      stack.pop();
    (stack.at(-1)?.children ?? roots).push(section);
    stack.push(section);
    current = section;
  };

  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) fence = fence === null ? marker : fence === marker ? null : fence;
    const h = fence === null && !marker ? HEADING.exec(line) : null;
    if (h) {
      open({ heading: { level: h[1]!.length, text: h[2]! }, head: '', children: [] });
    } else if (!current && line.trim() !== '') {
      open({ head: '', children: [] });
    }
    lines.push(line);
  }
  close();
  return roots;
}

/** A section's whole text: its own and every subsection's, in order. */
export function sectionText(section: Section): string {
  return [section.head, ...section.children.map(sectionText)].filter((t) => t !== '').join('\n\n');
}

/** Every heading in a section, its own first, in reading order. */
export function sectionHeadings(section: Section): Heading[] {
  return [
    ...(section.heading ? [section.heading] : []),
    ...section.children.flatMap(sectionHeadings),
  ];
}

/** Whether a section's own text is its heading line and nothing else. */
export function isBareHeading(section: Section): boolean {
  return section.heading !== undefined && !section.head.includes('\n');
}
