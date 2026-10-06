import { describe, expect, it } from 'vitest';

import {
  rewriteLinkTargets,
  _rewriteBodyForTest as rewriteBody,
  type NoteBodySource,
} from './rewrite-links.js';

/** The bodies these tests rewrite, held in memory rather than on disk. */
function sourceOf(bodies: Record<string, string>): NoteBodySource & {
  bodies: Record<string, string>;
} {
  const store = { ...bodies };
  return {
    bodies: store,
    list: async () => Object.keys(store),
    read: async (path) => store[path] ?? '',
    write: async (path, body) => {
      store[path] = body;
    },
  };
}

describe('rewriteBody — wikilink forms', () => {
  it('rewrites a plain wikilink by full path', () => {
    const { body, changed } = rewriteBody('See [[Erebor/Pricing]].', [
      { from: 'Erebor/Pricing.md', to: 'Erebor/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('See [[Erebor/decisiones/Pricing]].');
  });

  it('preserves alias on a wikilink', () => {
    const { body, changed } = rewriteBody('Check [[Erebor/Pricing|el doc]] now.', [
      { from: 'Erebor/Pricing.md', to: 'Erebor/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('Check [[Erebor/decisiones/Pricing|el doc]] now.');
  });

  it('preserves section + alias on a wikilink', () => {
    const { body, changed } = rewriteBody('Read [[Nota#Sección|texto]].', [
      { from: 'Nota.md', to: 'Archivo/Nota.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('Read [[Archivo/Nota#Sección|texto]].');
  });

  it('rewrites note embeds', () => {
    const { body, changed } = rewriteBody('![[Erebor/Pricing]]', [
      { from: 'Erebor/Pricing.md', to: 'Erebor/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('![[Erebor/decisiones/Pricing]]');
  });

  it('rewrites attachment embeds (full path with extension)', () => {
    const { body, changed } = rewriteBody(
      '![[Attachments/2026/05/img.png]]',
      [
        {
          from: 'Attachments/2026/05/img.png',
          to: 'Attachments/2026/06/img.png',
        },
      ],
    );
    expect(changed).toBe(true);
    expect(body).toBe('![[Attachments/2026/06/img.png]]');
  });

  it('rewrites bare-basename wikilinks only when the basename actually changes', () => {
    // basename did not change → leave it alone (Obsidian still resolves by stem)
    const same = rewriteBody('Refs [[Pricing]].', [
      { from: 'Erebor/Pricing.md', to: 'Erebor/decisiones/Pricing.md' },
    ]);
    expect(same.changed).toBe(false);
    expect(same.body).toBe('Refs [[Pricing]].');

    // basename changed → rewrite to new basename
    const renamed = rewriteBody('Refs [[Pricing]].', [
      { from: 'Erebor/Pricing.md', to: 'Erebor/Pricing-v2.md' },
    ]);
    expect(renamed.changed).toBe(true);
    expect(renamed.body).toBe('Refs [[Pricing-v2]].');
  });

  it('matches full path with or without the .md suffix and keeps the user style', () => {
    const noExt = rewriteBody('[[Erebor/Pricing]]', [
      { from: 'Erebor/Pricing.md', to: 'Erebor/Pricing-v2.md' },
    ]);
    expect(noExt.body).toBe('[[Erebor/Pricing-v2]]');

    const withExt = rewriteBody('[[Erebor/Pricing.md]]', [
      { from: 'Erebor/Pricing.md', to: 'Erebor/Pricing-v2.md' },
    ]);
    expect(withExt.body).toBe('[[Erebor/Pricing-v2.md]]');
  });
});

describe('rewriteBody — code mask', () => {
  it('does not rewrite wikilinks inside fenced code blocks', () => {
    const body = '```\n[[Erebor/Pricing]]\n```\nand outside [[Erebor/Pricing]].';
    const { body: out, changed } = rewriteBody(body, [
      { from: 'Erebor/Pricing.md', to: 'Erebor/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(out).toBe(
      '```\n[[Erebor/Pricing]]\n```\nand outside [[Erebor/decisiones/Pricing]].',
    );
  });

  it('does not rewrite wikilinks inside inline code spans', () => {
    const body = 'literal: `[[Erebor/Pricing]]` and real [[Erebor/Pricing]].';
    const { body: out, changed } = rewriteBody(body, [
      { from: 'Erebor/Pricing.md', to: 'Erebor/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(out).toBe(
      'literal: `[[Erebor/Pricing]]` and real [[Erebor/decisiones/Pricing]].',
    );
  });

  it('does not rewrite attachment embeds inside fences', () => {
    const body = '```md\n![[Attachments/2026/05/img.png]]\n```';
    const { body: out, changed } = rewriteBody(body, [
      {
        from: 'Attachments/2026/05/img.png',
        to: 'Attachments/2026/06/img.png',
      },
    ]);
    expect(changed).toBe(false);
    expect(out).toBe(body);
  });

  it('handles paths with spaces, accents and parentheses', () => {
    // [[Pricing Ideas]] with a bare-basename rename that includes a space
    const space = rewriteBody('Refs [[Pricing Ideas]].', [
      { from: 'Erebor/Pricing Ideas.md', to: 'Erebor/Pricing Ideas (v2).md' },
    ]);
    expect(space.body).toBe('Refs [[Pricing Ideas (v2)]].');

    // full-path with accents and a section
    const accents = rewriteBody('See [[Reuniones/Reunión Frodo#Acción]].', [
      {
        from: 'Reuniones/Reunión Frodo.md',
        to: 'Reuniones/2026/Reunión Frodo.md',
      },
    ]);
    expect(accents.body).toBe('See [[Reuniones/2026/Reunión Frodo#Acción]].');

    // alias containing accents/spaces is preserved verbatim
    const alias = rewriteBody('Link [[Folder With Spaces/Nota|el resumen]].', [
      {
        from: 'Folder With Spaces/Nota.md',
        to: 'Archivo/Folder With Spaces/Nota.md',
      },
    ]);
    expect(alias.body).toBe(
      'Link [[Archivo/Folder With Spaces/Nota|el resumen]].',
    );

    // attachment with parentheses and accents in the filename
    const att = rewriteBody('![[Attachments/2026/05/Resumen (Mayo) – Frodo.pdf]]', [
      {
        from: 'Attachments/2026/05/Resumen (Mayo) – Frodo.pdf',
        to: 'Attachments/2026/06/Resumen (Mayo) – Frodo.pdf',
      },
    ]);
    expect(att.body).toBe(
      '![[Attachments/2026/06/Resumen (Mayo) – Frodo.pdf]]',
    );
  });

  it('leaves non-matching links alone', () => {
    const { body, changed } = rewriteBody('[[Other]] and [[Erebor/Pricing]]', [
      { from: 'NotMe.md', to: 'Wherever.md' },
    ]);
    expect(changed).toBe(false);
    expect(body).toBe('[[Other]] and [[Erebor/Pricing]]');
  });
});

describe('rewriteLinkTargets across a set of notes', () => {
  it('rewrites references across multiple notes and reports filesChanged', async () => {
    const notes = sourceOf({
      'GONDOR/index.md': '# Index\n- [[Erebor/Pricing]]\n- [[Erebor/Pricing|el doc]]\n',
      'General/notes.md': 'see [[Erebor/Pricing#tier]]',
      'unrelated.md': 'nothing here',
    });

    const { filesChanged } = await rewriteLinkTargets(notes, [
      { from: 'Erebor/Pricing.md', to: 'Erebor/decisiones/Pricing.md' },
    ]);

    expect(filesChanged.sort()).toEqual(['GONDOR/index.md', 'General/notes.md']);

    expect(notes.bodies['GONDOR/index.md']).toBe(
      '# Index\n- [[Erebor/decisiones/Pricing]]\n- [[Erebor/decisiones/Pricing|el doc]]\n',
    );
    expect(notes.bodies['General/notes.md']).toBe('see [[Erebor/decisiones/Pricing#tier]]');
    expect(notes.bodies['unrelated.md']).toBe('nothing here');
  });

  it('is a no-op when no mappings match', async () => {
    const notes = sourceOf({ 'a.md': 'see [[B]]' });
    const { filesChanged } = await rewriteLinkTargets(notes, [{ from: 'C.md', to: 'D.md' }]);
    expect(filesChanged).toEqual([]);
  });
});
