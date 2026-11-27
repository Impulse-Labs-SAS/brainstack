import { describe, expect, it } from 'vitest';

import {
  addedHandleMentions,
  findHandleMentions,
  MENTION_SNIPPET_CHARS,
  normalizeUsername,
  suggestUsername,
} from './handles.js';

describe('normalizeUsername', () => {
  it('drops the @, trims and lowercases', () => {
    expect(normalizeUsername('  @Ana ')).toBe('ana');
    expect(normalizeUsername('juan.perez')).toBe('juan.perez');
    expect(normalizeUsername('dev_ops-2')).toBe('dev_ops-2');
  });

  it('refuses what could not be found again after an @', () => {
    for (const bad of [
      'a',
      '',
      '@',
      '.ana',
      'ana.',
      'ana-',
      'an a',
      'añá',
      'x'.repeat(31),
      'a@b',
    ]) {
      expect(normalizeUsername(bad), bad).toBeNull();
    }
  });
});

describe('suggestUsername', () => {
  it('makes one from an email', () => {
    expect(suggestUsername('Pablo.Gómez@example.com')).toBe('pablo.gomez');
    expect(suggestUsername('_ana+notes@example.com')).toBe('ananotes');
    expect(suggestUsername('ana maria')).toBe('ana.maria');
  });

  it('gives up when nothing usable is left', () => {
    expect(suggestUsername('+@example.com')).toBeNull();
  });
});

describe('findHandleMentions', () => {
  it('finds each person once, with the line they were named on', () => {
    const body = '# Plan\n\n@ana, mirá esto.\nY @Bruno también.\nOtra vez @ana.';
    expect(findHandleMentions(body)).toEqual([
      { username: 'ana', snippet: '@ana, mirá esto.' },
      { username: 'bruno', snippet: 'Y @Bruno también.' },
    ]);
  });

  it('trims punctuation that ends a sentence', () => {
    expect(findHandleMentions('Gracias @juan.perez.').map((m) => m.username)).toEqual([
      'juan.perez',
    ]);
  });

  it('ignores emails, URL paths and code', () => {
    const body = [
      'Escribile a ana@example.com',
      'Mirá https://social.example/@bruno',
      'Usá `@decorator` acá',
      '```ts',
      '@Injectable()',
      '```',
      '(@carla)',
    ].join('\n');
    expect(findHandleMentions(body).map((m) => m.username)).toEqual(['carla']);
  });

  it('cuts a long line around the mention', () => {
    const line = `${'a '.repeat(300)}@ana ${'b '.repeat(300)}`;
    const [mention] = findHandleMentions(line);
    expect(mention!.snippet).toContain('@ana');
    expect(mention!.snippet.length).toBeLessThanOrEqual(MENTION_SNIPPET_CHARS);
  });
});

describe('addedHandleMentions', () => {
  it('is everyone in a new note', () => {
    expect(addedHandleMentions(null, '@ana y @bruno').map((m) => m.username)).toEqual([
      'ana',
      'bruno',
    ]);
  });

  it('is only the people a save added', () => {
    const before = 'Hola @ana.';
    const after = 'Hola @ana, y @ana de nuevo. Sumo a @bruno.';
    expect(addedHandleMentions(before, after).map((m) => m.username)).toEqual(['bruno']);
  });

  it('is nobody when a mention was only removed', () => {
    expect(addedHandleMentions('@ana @bruno', '@ana')).toEqual([]);
  });
});
