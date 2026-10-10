import { describe, expect, it } from 'vitest';

import { choiceFromHash, openingView, rememberedChoice, storedChoice } from './view-choice';

const SENTINEL = { view: 'brain', sentinel: true } as const;

describe('openingView', () => {
  it('opens on the Sentinel with nothing said, and on Network without WebGL', () => {
    expect(openingView('', null, true)).toEqual(SENTINEL);
    expect(openingView('', null, false)).toEqual({ view: 'network', sentinel: false });
  });

  it('takes the old #crawl as the Sentinel', () => {
    expect(openingView('#crawl', 'territories', true)).toEqual(SENTINEL);
    expect(openingView('#sentinel', null, true)).toEqual(SENTINEL);
  });

  it('lets the hash beat a stored choice', () => {
    expect(openingView('#brain', 'sentinel', true)).toEqual({ view: 'brain', sentinel: false });
    expect(openingView('#network', 'brain', true)).toEqual({ view: 'network', sentinel: false });
  });

  it('respects a stored choice', () => {
    expect(openingView('', 'territories', true)).toEqual({ view: 'territories', sentinel: false });
    expect(openingView('', 'brain', true)).toEqual({ view: 'brain', sentinel: false });
    expect(openingView('', 'sentinel', true)).toEqual(SENTINEL);
  });

  it('puts Network in for the Sentinel or Brain without WebGL', () => {
    expect(openingView('', 'brain', false)).toEqual({ view: 'network', sentinel: false });
    expect(openingView('#sentinel', null, false)).toEqual({ view: 'network', sentinel: false });
    expect(openingView('', 'territories', false)).toEqual({ view: 'territories', sentinel: false });
  });

  it('ignores a stored value that is no choice, and a hash that is no view', () => {
    expect(openingView('', 'spider', true)).toEqual(SENTINEL);
    expect(openingView('', { view: 'brain' }, true)).toEqual(SENTINEL);
    expect(openingView('#notes', 'network', true)).toEqual({ view: 'network', sentinel: false });
  });
});

describe('rememberedChoice', () => {
  it('reads the old key’s Brain as no choice: it was written on every visit', () => {
    expect(rememberedChoice(null, 'brain')).toBeNull();
    expect(openingView('', rememberedChoice(null, 'brain'), true)).toEqual(SENTINEL);
  });

  it('keeps an old Network or Territories, which took a pick to reach', () => {
    expect(rememberedChoice(null, 'network')).toBe('network');
    expect(rememberedChoice(null, 'territories')).toBe('territories');
  });

  it('lets a pick under the new key win over the old one', () => {
    expect(rememberedChoice('sentinel', 'network')).toBe('sentinel');
    expect(rememberedChoice('brain', 'territories')).toBe('brain');
    expect(rememberedChoice('garbage', 'territories')).toBe('territories');
    expect(rememberedChoice(undefined, undefined)).toBeNull();
  });
});

describe('the small parts', () => {
  it('reads hashes and stored values', () => {
    expect(choiceFromHash('#territories')).toBe('territories');
    expect(choiceFromHash('')).toBeNull();
    expect(choiceFromHash('#')).toBeNull();
    expect(storedChoice('crawl')).toBeNull();
    expect(storedChoice(4)).toBeNull();
  });
});
