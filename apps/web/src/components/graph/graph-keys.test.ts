import { describe, expect, it } from 'vitest';

import { browserShortcut, reachesGraph, withoutPointer } from './graph-keys';

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

describe('reachesGraph', () => {
  it('takes every key pressed on the canvas: the controller says which it uses', () => {
    for (const key of ['Escape', 'Backspace', 'Enter', ' ', '+', '-', 'x', ...ARROWS]) {
      expect(reachesGraph(key, 'canvas')).toBe(true);
    }
  });

  it('closes and goes back from anywhere in the sheet', () => {
    expect(reachesGraph('Escape', 'sheet')).toBe(true);
    expect(reachesGraph('Backspace', 'sheet')).toBe(true);
  });

  it('leaves Enter, Space and the arrows to the sheet’s buttons', () => {
    for (const key of ['Enter', ' ', '+', ...ARROWS]) {
      expect(reachesGraph(key, 'sheet')).toBe(false);
    }
  });

  it('walks, opens, goes back and closes from the sheet’s heading', () => {
    // The brackets walk a note's links in line art, whose arrows move on the map instead.
    for (const key of ['Enter', 'Escape', 'Backspace', '[', ']', ...ARROWS]) {
      expect(reachesGraph(key, 'sheet-heading')).toBe(true);
    }
    expect(reachesGraph(' ', 'sheet-heading')).toBe(false);
  });

  it('in line art leaves the arrows to the sheet, whose note they would not walk', () => {
    for (const key of ARROWS) expect(reachesGraph(key, 'sheet-heading', true)).toBe(false);
    for (const key of ['Enter', 'Escape', 'Backspace', '[', ']'])
      expect(reachesGraph(key, 'sheet-heading', true)).toBe(true);
    for (const key of ARROWS) expect(reachesGraph(key, 'canvas', true)).toBe(true);
  });

  it('takes nothing pressed elsewhere on the stage', () => {
    for (const key of ['Escape', 'Backspace', 'Enter', ...ARROWS]) {
      expect(reachesGraph(key, 'elsewhere')).toBe(false);
    }
  });
});

describe('withoutPointer', () => {
  it('is the keyboard or a screen reader, never a mouse, a pen or a finger', () => {
    expect(withoutPointer('keyboard')).toBe(true);
    expect(withoutPointer('virtual')).toBe(true);
    expect(withoutPointer('mouse')).toBe(false);
    expect(withoutPointer('pen')).toBe(false);
    expect(withoutPointer('touch')).toBe(false);
  });
});

describe('browserShortcut', () => {
  const keys = (o: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey', boolean>>) => ({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...o,
  });

  it('leaves a key held with Alt, Ctrl or Meta to the browser: Back, its zoom', () => {
    expect(browserShortcut(keys({ altKey: true }))).toBe(true);
    expect(browserShortcut(keys({ ctrlKey: true }))).toBe(true);
    expect(browserShortcut(keys({ metaKey: true }))).toBe(true);
  });

  it('takes a plain key, or one held with Shift, for the graph', () => {
    expect(browserShortcut(keys({}))).toBe(false);
  });

  it('takes a key typed with AltGr, which Windows reports as Ctrl+Alt: ] on a Spanish keyboard', () => {
    const altGr = {
      ...keys({ altKey: true, ctrlKey: true }),
      getModifierState: (m: string) => m === 'AltGraph',
    };
    expect(browserShortcut(altGr)).toBe(false);
    expect(browserShortcut({ ...altGr, getModifierState: () => false })).toBe(true);
  });
});
