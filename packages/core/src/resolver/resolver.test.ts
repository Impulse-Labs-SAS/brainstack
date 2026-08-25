import { describe, expect, it } from 'vitest';

import type { ParsedLink } from '../types.js';

import { resolveLink } from './wikilinks.js';

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
  'Zuno/decisiones/pricing-tiered.md',
  'Zuno/Pricing.md',
  'BRUTUS/Pricing.md',
  'Zuno/Competitive landscape Zuno.md',
  'Inbox/Solo.md',
]);

const attachmentIndex = new Set([
  'Attachments/2026/05/pricing-comparison.png',
  'Attachments/2026/05/competitor-analysis.pdf',
]);

describe('resolveLink', () => {
  it('resolves an explicit path wikilink', () => {
    const result = resolveLink(link({ rawTarget: 'Zuno/Pricing' }), {
      sourcePath: 'Inbox/Solo.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetPath).toBe('Zuno/Pricing.md');
    expect(result.targetType).toBe('note');
  });

  it('prefers same-folder match for ambiguous bare wikilinks', () => {
    const result = resolveLink(link({ rawTarget: 'Pricing' }), {
      sourcePath: 'BRUTUS/note.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetPath).toBe('BRUTUS/Pricing.md');
    expect(result.ambiguous).toBe(false);
  });

  it('falls back to descendant folder match', () => {
    const result = resolveLink(link({ rawTarget: 'pricing-tiered' }), {
      sourcePath: 'Zuno/index.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetPath).toBe('Zuno/decisiones/pricing-tiered.md');
  });

  it('marks ambiguous when multiple candidates exist globally', () => {
    const result = resolveLink(link({ rawTarget: 'Pricing' }), {
      sourcePath: 'Inbox/Solo.md',
      noteIndex,
      attachmentIndex,
    });
    expect(result.targetType).toBe('unresolved');
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.sort()).toEqual(['BRUTUS/Pricing.md', 'Zuno/Pricing.md']);
  });

  it('resolves an embed of an attachment by exact path', () => {
    const result = resolveLink(
      link({
        rawTarget: 'Attachments/2026/05/pricing-comparison.png',
        kind: 'embed',
        isEmbed: true,
      }),
      { sourcePath: 'Zuno/decisiones/pricing-tiered.md', noteIndex, attachmentIndex },
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
  // Convención hosted: paths empiezan con <userId>/.
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
