import { describe, expect, it } from 'vitest';

import type { ParsedLink } from '../types.js';

import { linkCandidates, resolveLink, resolveLinks } from './wikilinks.js';

function link(partial: Partial<ParsedLink> & { rawTarget: string }): ParsedLink {
  return {
    rawTarget: partial.rawTarget,
    section: partial.section ?? null,
    alias: partial.alias ?? null,
    kind: partial.kind ?? 'wikilink',
    isEmbed: partial.isEmbed ?? false,
    position: partial.position ?? 0,
  };
}

const noteIndex = new Set([
  'Erebor/decisiones/pricing-tiered.md',
  'Erebor/Pricing.md',
  'GONDOR/Pricing.md',
  'Erebor/Competitive landscape Erebor.md',
  'Inbox/Solo.md',
]);

const attachmentIndex = new Set([
  'Attachments/2026/05/pricing-comparison.png',
  'Attachments/2026/05/competitor-analysis.pdf',
]);

describe('resolveLink', () => {
  it('resolves an explicit path wikilink', () => {
    const result = resolveLink(link({ rawTarget: 'Erebor/Pricing' }), {
      sourcePath: 'Inbox/Solo.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetPath).toBe('Erebor/Pricing.md');
    expect(result.targetType).toBe('note');
  });

  it('prefers same-folder match for ambiguous bare wikilinks', () => {
    const result = resolveLink(link({ rawTarget: 'Pricing' }), {
      sourcePath: 'GONDOR/note.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetPath).toBe('GONDOR/Pricing.md');
    expect(result.ambiguous).toBe(false);
  });

  it('falls back to descendant folder match', () => {
    const result = resolveLink(link({ rawTarget: 'pricing-tiered' }), {
      sourcePath: 'Erebor/index.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetPath).toBe('Erebor/decisiones/pricing-tiered.md');
  });

  it('marks ambiguous when multiple candidates exist globally', () => {
    const result = resolveLink(link({ rawTarget: 'Pricing' }), {
      sourcePath: 'Inbox/Solo.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetType).toBe('unresolved');
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.sort()).toEqual(['Erebor/Pricing.md', 'GONDOR/Pricing.md']);
  });

  it('resolves an embed of an attachment by exact path', () => {
    const result = resolveLink(
      link({
        rawTarget: 'Attachments/2026/05/pricing-comparison.png',
        kind: 'embed',
        isEmbed: true,
      }),
      { sourcePath: 'Erebor/decisiones/pricing-tiered.md', noteIndex, attachmentIndex },
    );
    expect(result.targetType).toBe('attachment');
  });

  it('returns unresolved for unknown wikilink', () => {
    const result = resolveLink(link({ rawTarget: 'Nope' }), {
      sourcePath: 'Inbox/Solo.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetType).toBe('unresolved');
    expect(result.ambiguous).toBe(false);
  });
});

describe('resolveLink — allowedOwners (cross-border masking)', () => {
  // Stored paths start with <userId>/.
  const hostedNoteIndex = new Set([
    'alice/proyectos/foo.md',
    'alice/privado/secreto.md',
    'bob/proyectos/foo.md',
  ]);
  const hostedAttachmentIndex = new Set<string>();
  const hostedOwnerByPath = new Map<string, string | null>([
    ['alice/proyectos/foo.md', 'alice'],
    ['alice/privado/secreto.md', 'alice'],
    ['bob/proyectos/foo.md', 'bob'],
  ]);

  it('cuando allowedOwners restringe a {alice}, los matches de bob se enmascaran', () => {
    // Bare wikilink "foo" desde una nota de alice resolvería ambiguo
    // (alice/proyectos/foo.md + bob/proyectos/foo.md). Con allowedOwners
    // = {alice}, la única candidate válida queda alice/proyectos/foo.md
    // y se promueve a resolved.
    const result = resolveLink(link({ rawTarget: 'foo' }), {
      sourcePath: 'alice/something.md',
      noteIndex: hostedNoteIndex,
      attachmentIndex: hostedAttachmentIndex,
      ownerByPath: hostedOwnerByPath,
      allowedOwners: new Set(['alice']),
    });
    expect(result.targetType).toBe('note');
    expect(result.targetPath).toBe('alice/proyectos/foo.md');
    expect(result.ambiguous).toBe(false);
  });

  it('un wikilink explícito a un path de bob desde alice queda unresolved', () => {
    const result = resolveLink(link({ rawTarget: 'bob/proyectos/foo' }), {
      sourcePath: 'alice/proyectos/x.md',
      noteIndex: hostedNoteIndex,
      attachmentIndex: hostedAttachmentIndex,
      ownerByPath: hostedOwnerByPath,
      allowedOwners: new Set(['alice']),
    });
    expect(result.targetType).toBe('unresolved');
  });

  it('sin allowedOwners el resolver opera global (sin enmascarado)', () => {
    // Source path en el root, sin folder propio que filtre por descendiente,
    // así la búsqueda global devuelve ambos foo.md.
    const result = resolveLink(link({ rawTarget: 'foo' }), {
      sourcePath: 'root.md',
      noteIndex: hostedNoteIndex,
      attachmentIndex: hostedAttachmentIndex,
    });
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.sort()).toEqual(['alice/proyectos/foo.md', 'bob/proyectos/foo.md']);
  });
});

describe('linkCandidates', () => {
  // Every shape of link the ladder knows, from notes at different depths.
  const vault = new Set([
    ...noteIndex,
    'Erebor/sub/Pricing.md',
    'Erebor/sub/deep/Notes.md',
    'Notes.md',
    'Rivendell/Plan.MD',
  ]);
  const shapes: ParsedLink[] = [
    link({ rawTarget: 'Pricing' }),
    link({ rawTarget: 'Pricing.md' }),
    link({ rawTarget: 'Erebor/Pricing' }),
    link({ rawTarget: 'Notes' }),
    link({ rawTarget: 'Solo' }),
    link({ rawTarget: 'Missing' }),
    link({ rawTarget: 'Rivendell/Plan.MD' }),
    link({ rawTarget: 'sub/Pricing.md', kind: 'markdown' }),
    link({ rawTarget: '/Notes.md', kind: 'markdown' }),
    link({ rawTarget: 'Pricing', isEmbed: true }),
    link({ rawTarget: 'pricing-comparison.png', isEmbed: true }),
  ];

  it('resolves exactly as the whole vault does, from only the paths it names', () => {
    for (const sourcePath of ['Erebor/a.md', 'Erebor/sub/b.md', 'c.md', 'GONDOR/d.md']) {
      const { paths, names } = linkCandidates(shapes, sourcePath);
      const narrowed = new Set(
        [...vault].filter(
          (p) => paths.includes(p) || names.includes(p.slice(p.lastIndexOf('/') + 1)),
        ),
      );
      const ctx = { sourcePath, attachmentIndex: new Set<string>() };
      expect(resolveLinks(shapes, { ...ctx, noteIndex: narrowed })).toEqual(
        resolveLinks(shapes, { ...ctx, noteIndex: vault }),
      );
      expect(narrowed.size).toBeLessThan(vault.size);
    }
  });
});
