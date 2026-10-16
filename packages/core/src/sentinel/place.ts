// Sentinel's reading before a write: where a new note belongs, whether one
// like it is already there, and what it should link to.
//
// Deciding where to save is a read, not a write, and the slowest part of a
// save was an assistant doing that read by hand: listing the tree, opening
// indexes, searching for a note it might duplicate. Here it is one crawl over
// the note's title and text, read for a different question — not "what does
// this refer to" but "what is this next to":
//
//  - A note whose title or alias is the proposed title is a duplicate: the
//    assistant should add to it, not create a second one.
//  - The folder the strongest related notes live in, weighed by their scores,
//    is where it most likely belongs; the next two are alternatives. With the
//    folder's index (`_<Folder>.md`) when it has one, so the link to the new
//    note goes in the same call.
//  - What the text names, and the notes most related to it, are what it
//    should link to.
//
// It proposes; it writes nothing. The person still approves the save, as for
// any other write.

import { foldForMatch } from '../links/mentions.js';

import { crawlContext, type ContextSource, type GatherContextResult } from './crawl.js';
import type { NameEntry } from './names.js';
import { folderOf } from './score.js';

/** Related notes read to vote on a folder. */
const VOTERS = 12;
/** Folders offered besides the best one. */
const ALTERNATIVES = 2;
/** Links offered besides the notes the text names. */
const RELATED_LINKS = 3;

export interface PlaceInput {
  /** The title the new note would have. */
  title: string;
  /** What it would say, or a summary of it. */
  text?: string;
}

export interface PlacedFolder {
  /** '' for the root of the vault. */
  folder: string;
  /** The folder's index note, when it has one: where to link the new note from. */
  index?: string;
  /** One line for a person: why this folder. */
  reason: string;
}

export interface PlaceResult {
  /** Notes already called what the new one would be called: add to one of these instead. */
  duplicates: Array<{ path: string; title: string }>;
  /** Where it most likely belongs. Null when nothing related was found. */
  folder: PlacedFolder | null;
  alternatives: PlacedFolder[];
  /** What the new note should link to: the notes its text names, then the most related. */
  links: Array<{ path: string; title: string; reason: string }>;
  /** The crawl the proposal was read from, for the history to replay. */
  crawl: GatherContextResult;
}

export async function placeNote(source: ContextSource, input: PlaceInput): Promise<PlaceResult> {
  // The crawl and the duplicate check both need every title: asked once.
  let names: Promise<NameEntry[]> | undefined;
  const titles = () => (names ??= source.titles());
  const once: ContextSource = { ...source, titles };

  const text = input.text?.trim() ? `${input.title}\n\n${input.text}` : input.title;
  const crawl = await crawlContext(once, { text, depth: 1 });
  const index = await titles();

  const wanted = foldForMatch(input.title.trim());
  const duplicates = wanted
    ? index
        .filter(
          (n) =>
            foldForMatch(n.title) === wanted ||
            n.aliases.some((a) => typeof a === 'string' && foldForMatch(a) === wanted),
        )
        .map(({ path, title }) => ({ path, title }))
    : [];

  // Every related note votes for its folder with its score.
  const votes = new Map<string, { weight: number; titles: string[] }>();
  for (const n of crawl.notes.slice(0, VOTERS)) {
    const folder = folderOf(n.path);
    const vote = votes.get(folder) ?? { weight: 0, titles: [] };
    vote.weight += n.score;
    vote.titles.push(n.title);
    votes.set(folder, vote);
  }
  const paths = new Set(index.map((n) => n.path));
  const ranked = [...votes.entries()]
    .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
    .map(([folder, vote]): PlacedFolder => {
      const name = folder.slice(folder.lastIndexOf('/') + 1);
      const moc = folder ? `${folder}/_${name}.md` : '';
      const shown = vote.titles.slice(0, 3).join(', ');
      const more = vote.titles.length > 3 ? ` and ${vote.titles.length - 3} more` : '';
      return {
        folder,
        ...(moc && paths.has(moc) ? { index: moc } : {}),
        reason: `${vote.titles.length} related ${vote.titles.length === 1 ? 'note' : 'notes'} here: ${shown}${more}`,
      };
    });

  const named = crawl.notes.filter((n) => n.via.kind === 'named');
  const related = crawl.notes
    .filter((n) => n.via.kind !== 'named' && !isIndexPath(n.path))
    .slice(0, RELATED_LINKS);
  const links = [...named, ...related].map((n) => ({
    path: n.path,
    title: n.title,
    reason: n.via.kind === 'named' ? 'the text names it' : n.reason,
  }));

  return {
    duplicates,
    folder: ranked[0] ?? null,
    alternatives: ranked.slice(1, 1 + ALTERNATIVES),
    links,
    crawl,
  };
}

/** `_<Folder>.md`: an index, linked to the new note rather than from it. */
function isIndexPath(path: string): boolean {
  return path.slice(path.lastIndexOf('/') + 1).startsWith('_');
}
