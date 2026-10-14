import { describe, expect, it } from 'vitest';

import { reachesGraph, withoutPointer } from './graph-keys';

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
    for (const key of ['Enter', 'Escape', 'Backspace', ...ARROWS]) {
      expect(reachesGraph(key, 'sheet-heading')).toBe(true);
    }
    expect(reachesGraph(' ', 'sheet-heading')).toBe(false);
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
