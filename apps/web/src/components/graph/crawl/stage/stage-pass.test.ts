import { describe, expect, it } from 'vitest';

import { AT_CRAWL, AT_PROMPT, type Levels } from '../prompt/transition';

import { stagePass } from './stage-pass';

const scene = (atRest: boolean, levels: Levels) => ({ atRest, levels });
const halfway: Levels = { prompt: 0.5, panel: 0.5, cluster: 0.5 };

describe('stagePass', () => {
  it('draws no cluster at rest at the prompt, compiled or not', () => {
    expect(stagePass(scene(true, AT_PROMPT), true)).toBe('bare');
    expect(stagePass(scene(true, AT_PROMPT), false)).toBe('bare');
  });

  it('keeps the frame planes while the frame shows over a space still compiling', () => {
    expect(stagePass(scene(false, AT_PROMPT), false)).toBe('bare');
    expect(stagePass(scene(false, halfway), false)).toBe('bare');
  });

  it('draws the space under way and in the crawl once it is compiled', () => {
    expect(stagePass(scene(false, halfway), true)).toBe('space');
    expect(stagePass(scene(false, AT_CRAWL), true)).toBe('space');
    // No scene to show (the box has no place yet): the space as ever.
    expect(stagePass(null, true)).toBe('space');
  });

  it('only clears with nothing to draw the creature in', () => {
    expect(stagePass(scene(false, AT_CRAWL), false)).toBe('clear');
    expect(stagePass(null, false)).toBe('clear');
  });
});
