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
    const { body, changed } = rewriteBody('See [[Zuno/Pricing]].', [
      { from: 'Zuno/Pricing.md', to: 'Zuno/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('See [[Zuno/decisiones/Pricing]].');
  });

  it('preserves alias on a wikilink', () => {
    const { body, changed } = rewriteBody('Check [[Zuno/Pricing|el doc]] now.', [
      { from: 'Zuno/Pricing.md', to: 'Zuno/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('Check [[Zuno/decisiones/Pricing|el doc]] now.');
  });

  it('preserves section + alias on a wikilink', () => {
    const { body, changed } = rewriteBody('Read [[Nota#Sección|texto]].', [
      { from: 'Nota.md', to: 'Archivo/Nota.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('Read [[Archivo/Nota#Sección|texto]].');
  });

  it('rewrites note embeds', () => {
    const { body, changed } = rewriteBody('![[Zuno/Pricing]]', [
      { from: 'Zuno/Pricing.md', to: 'Zuno/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('![[Zuno/decisiones/Pricing]]');
  });

  it('rewrites attachment embeds (full path with extension)', () => {
    const { body, changed } = rewriteBody('![[Attachments/2026/05/img.png]]', [
      {
        from: 'Attachments/2026/05/img.png',
        to: 'Attachments/2026/06/img.png',
      },
    ]);
    expect(changed).toBe(true);
    expect(body).toBe('![[Attachments/2026/06/img.png]]');
  });

  it('rewrites bare-basename wikilinks only when the basename actually changes', () => {
    // basename did not change → leave it alone (Obsidian still resolves by stem)
    const same = rewriteBody('Refs [[Pricing]].', [
      { from: 'Zuno/Pricing.md', to: 'Zuno/decisiones/Pricing.md' },
    ]);
    expect(same.changed).toBe(false);
    expect(same.body).toBe('Refs [[Pricing]].');

    // basename changed → rewrite to new basename
    const renamed = rewriteBody('Refs [[Pricing]].', [
      { from: 'Zuno/Pricing.md', to: 'Zuno/Pricing-v2.md' },
    ]);
    expect(renamed.changed).toBe(true);
    expect(renamed.body).toBe('Refs [[Pricing-v2]].');
  });

  it('matches full path with or without the .md suffix and keeps the user style', () => {
    const noExt = rewriteBody('[[Zuno/Pricing]]', [
      { from: 'Zuno/Pricing.md', to: 'Zuno/Pricing-v2.md' },
    ]);
    expect(noExt.body).toBe('[[Zuno/Pricing-v2]]');

    const withExt = rewriteBody('[[Zuno/Pricing.md]]', [
      { from: 'Zuno/Pricing.md', to: 'Zuno/Pricing-v2.md' },
    ]);
    expect(withExt.body).toBe('[[Zuno/Pricing-v2.md]]');
  });
});

describe('rewriteBody — code mask', () => {
  it('does not rewrite wikilinks inside fenced code blocks', () => {
    const body = '```\n[[Zuno/Pricing]]\n```\nand outside [[Zuno/Pricing]].';
    const { body: out, changed } = rewriteBody(body, [
      { from: 'Zuno/Pricing.md', to: 'Zuno/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(out).toBe('```\n[[Zuno/Pricing]]\n```\nand outside [[Zuno/decisiones/Pricing]].');
  });

  it('does not rewrite wikilinks inside inline code spans', () => {
    const body = 'literal: `[[Zuno/Pricing]]` and real [[Zuno/Pricing]].';
    const { body: out, changed } = rewriteBody(body, [
      { from: 'Zuno/Pricing.md', to: 'Zuno/decisiones/Pricing.md' },
    ]);
    expect(changed).toBe(true);
    expect(out).toBe('literal: `[[Zuno/Pricing]]` and real [[Zuno/decisiones/Pricing]].');
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
      { from: 'Zuno/Pricing Ideas.md', to: 'Zuno/Pricing Ideas (v2).md' },
    ]);
    expect(space.body).toBe('Refs [[Pricing Ideas (v2)]].');

    // full-path with accents and a section
    const accents = rewriteBody('See [[Reuniones/Reunión Pablo#Acción]].', [
      {
        from: 'Reuniones/Reunión Pablo.md',
        to: 'Reuniones/2026/Reunión Pablo.md',
      },
    ]);
    expect(accents.body).toBe('See [[Reuniones/2026/Reunión Pablo#Acción]].');

    // alias containing accents/spaces is preserved verbatim
    const alias = rewriteBody('Link [[Folder With Spaces/Nota|el resumen]].', [
      {
        from: 'Folder With Spaces/Nota.md',
        to: 'Archivo/Folder With Spaces/Nota.md',
      },
    ]);
    expect(alias.body).toBe('Link [[Archivo/Folder With Spaces/Nota|el resumen]].');

    // attachment with parentheses and accents in the filename
    const att = rewriteBody('![[Attachments/2026/05/Resumen (Mayo) – Pablo.pdf]]', [
      {
        from: 'Attachments/2026/05/Resumen (Mayo) – Pablo.pdf',
        to: 'Attachments/2026/06/Resumen (Mayo) – Pablo.pdf',
      },
    ]);
    expect(att.body).toBe('![[Attachments/2026/06/Resumen (Mayo) – Pablo.pdf]]');
  });

  it('leaves non-matching links alone', () => {
    const { body, changed } = rewriteBody('[[Other]] and [[Zuno/Pricing]]', [
      { from: 'NotMe.md', to: 'Wherever.md' },
    ]);
    expect(changed).toBe(false);
    expect(body).toBe('[[Other]] and [[Zuno/Pricing]]');
  });
});

describe('rewriteLinkTargets across a set of notes', () => {
  it('rewrites references across multiple notes and reports filesChanged', async () => {
    const notes = sourceOf({
      'BRUTUS/index.md': '# Index\n- [[Zuno/Pricing]]\n- [[Zuno/Pricing|el doc]]\n',
      'General/notes.md': 'see [[Zuno/Pricing#tier]]',
      'unrelated.md': 'nothing here',
    });

    const { filesChanged } = await rewriteLinkTargets(notes, [
      { from: 'Zuno/Pricing.md', to: 'Zuno/decisiones/Pricing.md' },
    ]);

    expect(filesChanged.sort()).toEqual(['BRUTUS/index.md', 'General/notes.md']);

    expect(notes.bodies['BRUTUS/index.md']).toBe(
      '# Index\n- [[Zuno/decisiones/Pricing]]\n- [[Zuno/decisiones/Pricing|el doc]]\n',
    );
    expect(notes.bodies['General/notes.md']).toBe('see [[Zuno/decisiones/Pricing#tier]]');
    expect(notes.bodies['unrelated.md']).toBe('nothing here');
  });

  it('is a no-op when no mappings match', async () => {
    const notes = sourceOf({ 'a.md': 'see [[B]]' });
    const { filesChanged } = await rewriteLinkTargets(notes, [{ from: 'C.md', to: 'D.md' }]);
    expect(filesChanged).toEqual([]);
  });
});
