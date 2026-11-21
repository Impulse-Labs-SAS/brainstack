// Where a document is cut into notes.
//
// Sections are kept whole: a section travels with its subsections, and small
// neighbouring sections share a note, packed in order up to the budget. Only a
// section that alone is longer than a note is opened: its own text becomes a
// piece, kept together with what follows it so a heading never ends a note, and
// each subsection is placed the same way. A piece of text still too long is cut
// at paragraphs, then lines, then — a wall of text with no breaks — the length.
//
// Two rules keep each note about one thing:
// - The introduction (text before the first heading, or under the document's
//   title) is a note of its own; it is never packed with the section after it.
// - A section that had to be opened shares its notes with nothing else, so the
//   notes that continue it are only that section, and can be named after it.
//
// Which heading is the document's title is not decided here: the caller says,
// through `isTitle` (naming.ts knows how to tell).

import { noteSize } from '../size.js';

import {
  isBareHeading,
  sectionHeadings,
  sectionText,
  type Heading,
  type Section,
} from './outline.js';

export interface Part {
  text: string;
  /** Every heading whose line is in this part, in reading order. */
  headings: Heading[];
  /**
   * The opened section this part belongs to, when the part does not hold that
   * section's heading itself: the part continues it.
   */
  continues?: Heading;
}

interface Block {
  text: string;
  headings: Heading[];
  /** The opened section this block is part of; blocks of different ones never share a note. */
  group?: Heading;
  /** Never shares a note with the block after it. */
  alone?: boolean;
  /** Always shares a note with the block after it. */
  glue?: boolean;
}

const fits = (text: string, budget: number) => noteSize(text).chars <= budget;

export function partition(
  sections: readonly Section[],
  budget: number,
  isTitle: (heading: Heading) => boolean,
): Part[] {
  const blocks = sections.flatMap((s) => place(s, budget, isTitle, undefined));
  return pack(blocks, budget).map(toPart);
}

function place(
  section: Section,
  budget: number,
  isTitle: (heading: Heading) => boolean,
  group: Heading | undefined,
): Block[] {
  const intro = !section.heading || isTitle(section.heading);
  const whole = sectionText(section);
  // A title with nothing under it but its subsections is not an introduction:
  // it goes along with what follows.
  const bare = section.heading !== undefined && isBareHeading(section);
  if (fits(whole, budget)) {
    const block: Block = {
      text: whole,
      headings: sectionHeadings(section),
      ...(group ? { group } : {}),
    };
    if (intro && !(bare && section.children.length === 0)) block.alone = true;
    else if (intro) block.glue = true;
    return [block];
  }
  // Opened. Its subsections belong to it — unless it is the introduction,
  // whose subsections are the document's own sections.
  const inner = intro ? group : (group ?? section.heading);
  const own: Block[] = cut(section.head, budget).map((text, i) => ({
    text,
    headings: i === 0 && section.heading ? [section.heading] : [],
    ...(inner ? { group: inner } : {}),
  }));
  if (own.length > 0) {
    const last = own.at(-1)!;
    if (intro && !bare) last.alone = true;
    else if (section.children.length > 0) last.glue = true;
  }
  return [...own, ...section.children.flatMap((c) => place(c, budget, isTitle, inner))];
}

function pack(blocks: Block[], budget: number): Block[][] {
  const parts: Block[][] = [];
  for (const block of blocks) {
    const last = parts.at(-1);
    const previous = last?.at(-1);
    const sameGroup = previous?.group === block.group;
    if (last && previous && !previous.alone && (previous.glue || sameGroup)) {
      if (fits(joined([...last, block]), budget)) {
        last.push(block);
        continue;
      }
      // A heading never ends a note: take it along to the next one.
      if (previous.glue && last.length > 1 && fits(joined([previous, block]), budget)) {
        last.pop();
        parts.push([previous, block]);
        continue;
      }
    }
    parts.push([block]);
  }
  return parts;
}

const joined = (blocks: Block[]) => blocks.map((b) => b.text).join('\n\n');

function toPart(blocks: Block[]): Part {
  const headings = blocks.flatMap((b) => b.headings);
  const group = blocks[0]!.group;
  const continues = group && !headings.includes(group) ? group : undefined;
  return { text: joined(blocks), headings, ...(continues ? { continues } : {}) };
}

/**
 * Text cut to pieces of at most `budget` characters: at paragraphs, a paragraph
 * still too long at lines, a line still too long at the length. Small pieces
 * are joined back up to the budget, so a heading line stays with the text under
 * it.
 */
export function cut(text: string, budget: number, separators = ['\n\n', '\n']): string[] {
  if (text.trim() === '') return [];
  if (fits(text, budget)) return [text];
  const [separator, ...rest] = separators;
  if (separator === undefined) return cutAtLength(text, budget);
  const units = text.split(separator).filter((u) => u.trim() !== '');
  if (units.length < 2) return cut(text, budget, rest);
  const pieces: string[] = [];
  for (const unit of units.flatMap((u) => cut(u.trim(), budget, rest))) {
    const last = pieces.at(-1);
    if (last !== undefined && fits(`${last}${separator}${unit}`, budget)) {
      pieces[pieces.length - 1] = `${last}${separator}${unit}`;
    } else {
      pieces.push(unit);
    }
  }
  return pieces;
}

/**
 * A wall of text with no breaks, cut at the length, in code points so a
 * character outside the BMP is never split in half. A tenth of the budget is
 * left free, so the heading above the wall still fits beside its first piece.
 */
function cutAtLength(text: string, budget: number): string[] {
  const size = Math.max(1, Math.floor(budget * 0.9));
  const points = [...text];
  const out: string[] = [];
  for (let i = 0; i < points.length; i += size)
    out.push(
      points
        .slice(i, i + size)
        .join('')
        .trim(),
    );
  return out.filter((t) => t !== '');
}
