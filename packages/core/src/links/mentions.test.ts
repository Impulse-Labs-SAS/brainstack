import { describe, expect, it } from 'vitest';

import { findMentions, linkMentions, mentionSnippet, mentionTerms } from './mentions.js';

const terms = (...pairs: Array<[string, string]>) => pairs.map(([target, term]) => ({ target, term }));

describe('mentionTerms', () => {
  it('takes titles and aliases, skipping short ones', () => {
    expect(
      mentionTerms([
        { target: 'zuno.md', title: 'Zuno ERP', aliases: ['Zuno', 'ERP'] },
      ]).map((t) => t.term),
    ).toEqual(['Zuno ERP', 'Zuno']);
  });

  it('drops a title two notes share, since it cannot say which one is meant', () => {
    expect(
      mentionTerms([
        { target: 'atlas/arquitectura.md', title: 'Arquitectura' },
        { target: 'nimbus/arquitectura.md', title: 'arquitectura' },
        { target: 'x.md', title: 'Seek & Destroy' },
      ]),
    ).toEqual([{ target: 'x.md', term: 'Seek & Destroy' }]);
  });

  it('ignores non-string aliases', () => {
    expect(mentionTerms([{ target: 'a.md', title: 'Atlas', aliases: [42, null] }])).toHaveLength(1);
  });
});

describe('findMentions', () => {
  it('matches regardless of case and accents, keeping the text as written', () => {
    const found = findMentions('La vision de ATLAS es clara.', terms(['v.md', 'Visión'], ['a.md', 'Atlas']));
    expect(found.map((m) => [m.target, m.text])).toEqual([
      ['v.md', 'vision'],
      ['a.md', 'ATLAS'],
    ]);
  });

  it('matches whole words only', () => {
    expect(findMentions('la zunoteca y el prezuno', terms(['z.md', 'zuno']))).toEqual([]);
    expect(findMentions('usa zuno.', terms(['z.md', 'zuno']))).toHaveLength(1);
  });

  it('never matches inside code, links or URLs', () => {
    const body = [
      '`Atlas` en código',
      '```',
      'Atlas en un bloque',
      '```',
      'ya enlazado: [[atlas|Atlas]] y [Atlas](atlas.md)',
      'https://atlas.example.com/Atlas',
    ].join('\n');
    expect(findMentions(body, terms(['a.md', 'Atlas']))).toEqual([]);
  });

  it('lets the longer term win where two overlap', () => {
    const found = findMentions('uso Seek & Destroy hoy', terms(['d.md', 'Destroy'], ['sd.md', 'Seek & Destroy']));
    expect(found.map((m) => m.target)).toEqual(['sd.md']);
  });

  it('reports offsets into the original body', () => {
    const body = 'Él usa Visión';
    const [m] = findMentions(body, terms(['v.md', 'vision']));
    expect(body.slice(m!.start, m!.end)).toBe('Visión');
  });
});

describe('linkMentions', () => {
  it('links every mention, keeping the text as the alias', () => {
    const { body, linked } = linkMentions(
      'Atlas usa Gemini. Después atlas crece.',
      'a',
      'Proyectos/Atlas/_Atlas',
      terms(['a', 'Atlas']),
    );
    expect(linked).toBe(2);
    expect(body).toBe(
      '[[Proyectos/Atlas/_Atlas|Atlas]] usa Gemini. Después [[Proyectos/Atlas/_Atlas|atlas]] crece.',
    );
  });

  it('leaves existing links and code untouched', () => {
    const input = 'ver [[x|Atlas]] y `Atlas`';
    expect(linkMentions(input, 'a', 'A', terms(['a', 'Atlas']))).toEqual({ body: input, linked: 0 });
  });

  it('does not link a term out of the middle of a longer title', () => {
    const input = 'ver la Visión — Atlas y también Atlas';
    const { body, linked } = linkMentions(
      input,
      'a',
      'Atlas/_Atlas',
      terms(['a', 'Atlas'], ['v', 'Visión — Atlas']),
    );
    expect(linked).toBe(1);
    expect(body).toBe('ver la Visión — Atlas y también [[Atlas/_Atlas|Atlas]]');
  });
});

describe('mentionSnippet', () => {
  it('gives context around the mention, collapsing whitespace', () => {
    const body = 'uno\n\ndos tres Atlas cuatro';
    const [m] = findMentions(body, terms(['a', 'Atlas']));
    expect(mentionSnippet(body, m!, 8)).toBe('…os tres Atlas cuatro');
  });
});
