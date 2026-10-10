// What the lab's prompt shows, standing in for Crawl's history: what each of
// the lab's crawls was asked, and the recent crawls listed under the input.
// The vaults are invented, and so are these: the questions only have to read
// like something a person would ask of the shape each crawl has — a walk
// between two notes, a reach into the island no thread gets to, references
// nothing settles, all of it at once.
//
// Three of the recents were made by hand and one by an assistant over MCP,
// which the lab has not shown yet: the prompt marks it new and never plays
// it on its own, which is what the gate judges.

import type { RecentCrawl } from '../../crawl-history';
import type { SampleVault } from '../../sample-vault';

type Preset = keyof SampleVault['crawls'];

/** What each lab crawl was asked: invented, like the vaults. */
export const LAB_ASKED: Readonly<Record<Preset, string>> = {
  walk: 'Walk me from the kickoff note to the one it led to',
  gap: 'What does the island have to do with the rest of it?',
  ask: 'Where is the agenda, and which runbook do we follow?',
  tour: 'Everything you know about this, end to end',
};

/** Minutes before `now` each was made, newest first: the assistant's the latest. */
const MADE: ReadonlyArray<{ id: Preset; minutes: number; by: 'assistant' | 'web' }> = [
  { id: 'tour', minutes: 2, by: 'assistant' },
  { id: 'ask', minutes: 9, by: 'web' },
  { id: 'gap', minutes: 26, by: 'web' },
  { id: 'walk', minutes: 75, by: 'web' },
];

/**
 * The lab's recent crawls over `vault`, ids the presets they play: three made
 * by hand, `tour` run by an assistant ("Claude") over MCP, minutes apart
 * before `now` (ms).
 */
export function labRecents(vault: SampleVault, now: number): RecentCrawl[] {
  return MADE.map(({ id, minutes, by }) => ({
    id,
    createdAt: now - minutes * 60_000,
    source: by,
    client: by === 'assistant' ? 'Claude' : null,
    prompt: LAB_ASKED[id],
    notes: vault.crawls[id].notes.length,
  }));
}
