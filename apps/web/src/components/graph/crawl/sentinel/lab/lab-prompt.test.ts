import { describe, expect, it } from 'vitest';

import { promptRecents } from '../../prompt/recents';
import { sampleVault } from '../../sample-vault';
import { largeVault } from '../../space/large-vault';

import { LAB_ASKED, labRecents } from './lab-prompt';

const NOW = Date.UTC(2026, 0, 15, 12);
/** The lab's presets: the crawls every lab vault carries. */
const PRESETS = Object.keys(sampleVault().crawls) as (keyof typeof LAB_ASKED)[];

describe('the lab’s prompt data', () => {
  it('asks something of every crawl the lab plays', () => {
    for (const preset of PRESETS) expect(LAB_ASKED[preset].trim().length).toBeGreaterThan(0);
  });

  it('lists every lab crawl as a recent, newest first, the assistant’s marked new until it is seen', () => {
    for (const vault of [sampleVault(), largeVault()]) {
      const items = labRecents(vault, NOW);
      expect(items.map((c) => c.id).sort()).toEqual([...PRESETS].sort());
      for (const c of items) {
        expect(c.createdAt).toBeLessThan(NOW);
        expect(c.notes).toBe(vault.crawls[c.id as keyof typeof vault.crawls].notes.length);
        expect(c.prompt).toBe(LAB_ASKED[c.id as keyof typeof LAB_ASKED]);
      }

      const fresh = promptRecents(items, new Set(), NOW);
      expect(fresh[0]!.id).toBe('tour');
      expect(fresh.filter((r) => r.fresh).map((r) => r.id)).toEqual(['tour']);
      expect(fresh[0]!.meta.startsWith('Claude · ')).toBe(true);
      expect(fresh.slice(1).every((r) => r.meta.startsWith('You · '))).toBe(true);

      const seen = promptRecents(items, new Set(['tour']), NOW);
      expect(seen.some((r) => r.fresh)).toBe(false);
    }
  });
});
