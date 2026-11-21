import { describe, expect, it } from 'vitest';

import { noteSize } from '../size.js';

import { parseOutline, type Heading } from './outline.js';
import { cut, partition } from './partition.js';

/** About `chars` characters of prose, in paragraphs of about 400. */
const prose = (chars: number) =>
  Array.from({ length: Math.max(1, Math.round(chars / 400)) }, () =>
    'orbit ledger '.repeat(31).trim(),
  ).join('\n\n');
const noTitle = () => false;
const titled = (title: string) => (h: Heading) => h.text === title;
const names = (parts: ReturnType<typeof partition>) =>
  parts.map((p) => p.headings.map((h) => h.text));

describe('parseOutline', () => {
  it('nests headings by level and keeps fenced lines as text', () => {
    const [pre, a] = parseOutline(
      'Before.\n\n# A\n\nText.\n\n```\n# not\n```\n\n## B\n\n### C\n\n## D',
    );
    expect(pre!.heading).toBeUndefined();
    expect(a!.heading!.text).toBe('A');
    expect(a!.head).toContain('# not');
    expect(a!.children.map((c) => c.heading!.text)).toEqual(['B', 'D']);
    expect(a!.children[0]!.children[0]!.heading!.text).toBe('C');
  });
});

describe('partition', () => {
  it('packs whole sections and never splits a section from its subsections', () => {
    const text = [
      '## One',
      prose(2_000),
      '## Two',
      prose(400),
      '### Two A',
      prose(2_000),
      '### Two B',
      prose(2_000),
    ].join('\n\n');
    const parts = partition(parseOutline(text), 5_000, noTitle);
    expect(names(parts)).toEqual([['One'], ['Two', 'Two A', 'Two B']]);
  });

  it('keeps the introduction apart from the section after it', () => {
    const text = ['# Atlas', prose(400), '## One', prose(400), '## Two', prose(400)].join('\n\n');
    const parts = partition(parseOutline(text), 1_200, titled('Atlas'));
    expect(names(parts)).toEqual([['Atlas'], ['One', 'Two']]);
  });

  it('takes a bare title along with the first section', () => {
    const text = ['# Atlas', '## One', prose(800), '## Two', prose(800)].join('\n\n');
    const parts = partition(parseOutline(text), 1_000, titled('Atlas'));
    expect(names(parts)).toEqual([['Atlas', 'One'], ['Two']]);
  });

  it('opens a section too long for one note and marks the parts that continue it', () => {
    const text = [
      '## Plan',
      prose(400),
      '### A',
      prose(2_400),
      '### B',
      prose(2_400),
      '### C',
      prose(2_400),
      '## After',
      prose(400),
    ].join('\n\n');
    const parts = partition(parseOutline(text), 3_200, noTitle);
    expect(names(parts)).toEqual([['Plan', 'A'], ['B'], ['C'], ['After']]);
    expect(parts.map((p) => p.continues?.text)).toEqual([undefined, 'Plan', 'Plan', undefined]);
  });

  it('keeps every part within the budget and loses nothing', () => {
    const text = ['## Wall', 'x'.repeat(13_000), '## Long', prose(9_000)].join('\n\n');
    const parts = partition(parseOutline(text), 4_000, noTitle);
    for (const p of parts) expect(noteSize(p.text).chars).toBeLessThanOrEqual(4_000);
    expect(parts.map((p) => p.text.match(/x/g)?.length ?? 0).reduce((a, b) => a + b, 0)).toBe(
      13_000,
    );
    expect(parts.filter((p) => p.continues?.text === 'Wall')).toHaveLength(3);
  });
});

describe('cut', () => {
  it('cuts at paragraphs before lines, and at the length last', () => {
    expect(cut('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc']);
    expect(cut('aaaa\nbbbb\ncccc', 10)).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(cut('abcdefghij', 4)).toEqual(['abc', 'def', 'ghi', 'j']);
    expect(cut(`## Wall\n\n${'x'.repeat(200)}`, 100)).toEqual([
      `## Wall\n\n${'x'.repeat(90)}`,
      'x'.repeat(90),
      'x'.repeat(20),
    ]);
  });
});
