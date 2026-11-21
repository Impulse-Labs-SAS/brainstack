import { describe, expect, it } from 'vitest';

import {
  DocumentImportError,
  MAX_IMPORT_NOTES,
  planDocumentImport,
  type DocumentLookup,
} from './document.js';
import { NOTE_MAX_CHARS, noteSize } from './size.js';

const none: DocumentLookup = { existing: async () => new Set() };
const taken = (...paths: string[]): DocumentLookup => ({
  existing: async (asked) => new Set(asked.filter((p) => paths.includes(p))),
});

/** About `chars` characters of prose, in paragraphs of about 400. */
const prose = (chars: number) =>
  Array.from({ length: Math.max(1, Math.round(chars / 400)) }, () =>
    'El sistema registra cada movimiento y lo concilia con el libro mayor al cierre del día. '
      .repeat(5)
      .trim(),
  )
    .join('\n\n')
    .slice(0, chars);
const SHORT = 'Una nota corta con texto de verdad, más de cincuenta letras y números en total.';

describe('planDocumentImport', () => {
  it('makes a short document one note, titled, in the folder it was imported into', async () => {
    const plan = await planDocumentImport(
      { markdown: `# Orbit\r\n\r\n\r\n${SHORT}  `, fileName: 'Orbit.pdf', folder: 'clients/' },
      none,
    );
    expect(plan.notes).toEqual([
      {
        path: 'clients/Orbit.md',
        content: `# Orbit\n\n${SHORT}\n`,
        frontmatter: { source: 'Orbit.pdf', title: 'Orbit' },
      },
    ]);
    expect(plan.entry).toBe('clients/Orbit.md');
  });

  it('puts a document imported at the root in Documentos', async () => {
    expect(
      (await planDocumentImport({ markdown: SHORT, fileName: 'a.txt', folder: '' }, none)).entry,
    ).toBe('Documentos/a.md');
  });

  // The shape of a real report: a title with an introduction, two numbered
  // sections, a third whose short paragraph is followed by three subsections.
  // Before, the third section's heading ended up at the bottom of the second
  // part and the third part was named after its first subsection.
  it('names the parts of a sectioned document after their own sections', async () => {
    const markdown = [
      '# Acuerdo de Plan Orbit',
      prose(450),
      '## 1. Datos generales',
      prose(490),
      '## 2. Puntos acordados',
      prose(5_300),
      '## 3. Plan propuesto',
      prose(250),
      '### Etapa Atlas. Centro de datos',
      prose(1_100),
      '### Régimen de Entregas',
      prose(1_100),
      '### Cuota Mensual',
      prose(1_100),
    ].join('\n\n');
    const plan = await planDocumentImport(
      { markdown, fileName: 'Acuerdo Plan Orbit.pdf', folder: '' },
      none,
    );

    expect(plan.notes.map((n) => n.path)).toMatchInlineSnapshot(`
      [
        "Documentos/Acuerdo Plan Orbit/01 - Introducción.md",
        "Documentos/Acuerdo Plan Orbit/02 - Datos generales.md",
        "Documentos/Acuerdo Plan Orbit/03 - Plan propuesto.md",
        "Documentos/Acuerdo Plan Orbit/_Acuerdo Plan Orbit.md",
      ]
    `);
    expect(plan.notes.map((n) => n.frontmatter.title)).toEqual([
      'Acuerdo Plan Orbit — Introducción',
      'Acuerdo Plan Orbit — Datos generales',
      'Acuerdo Plan Orbit — Plan propuesto',
      'Acuerdo Plan Orbit',
    ]);
    // Section 3 travels with its subsections; section 2 is in the part it starts.
    expect(plan.notes[1]!.content).toContain('## 2. Puntos acordados');
    expect(plan.notes[2]!.content).toMatch(/^## 3\. Plan propuesto[\s\S]*### Cuota Mensual/);
    for (const note of plan.notes.slice(0, -1)) {
      expect(noteSize(note.content).chars).toBeLessThanOrEqual(NOTE_MAX_CHARS);
      expect(note.content).toContain(
        '## Refs\n\n- [[Documentos/Acuerdo Plan Orbit/_Acuerdo Plan Orbit]]',
      );
      expect(note.frontmatter.source).toBe('Acuerdo Plan Orbit.pdf');
    }
    expect(plan.notes.at(-1)!.content).toContain(
      '- [[01 - Introducción]]\n- [[02 - Datos generales]]\n- [[03 - Plan propuesto]]',
    );
  });

  it('names the parts that continue a section too long for one note', async () => {
    const markdown = [
      '## Plan',
      prose(300),
      ...['A', 'B', 'C'].flatMap((x) => [`### ${x}`, prose(3_500)]),
    ].join('\n\n');
    const plan = await planDocumentImport({ markdown, fileName: 'Atlas.docx', folder: 'x' }, none);
    expect(plan.notes.map((n) => n.path.split('/').pop())).toEqual([
      '01 - Plan.md',
      '02 - Plan (cont.).md',
      '03 - Plan (cont.).md',
      '_Atlas.md',
    ]);
  });

  it('picks the next free name when the first is taken', async () => {
    const plan = await planDocumentImport(
      { markdown: SHORT, fileName: 'Orbit.pdf', folder: 'x' },
      taken('x/Orbit.md', 'x/Orbit (2).md'),
    );
    expect(plan.entry).toBe('x/Orbit (3).md');
    expect(plan.title).toBe('Orbit (3)');
  });

  it('refuses a document with no text as EMPTY_TEXT, writing nothing', async () => {
    for (const markdown of [' \n\n ', '1\n\n2\n\n3']) {
      await expect(
        planDocumentImport({ markdown, fileName: 'scan.pdf', folder: '' }, none),
      ).rejects.toMatchObject({
        code: 'EMPTY_TEXT',
      });
    }
    await expect(
      planDocumentImport(
        { markdown: SHORT, fileName: 'scan.pdf', folder: '', fileBytes: 5_000_000 },
        none,
      ),
    ).rejects.toMatchObject({ code: 'EMPTY_TEXT' });
  });

  it('refuses a document that would become too many notes', async () => {
    const markdown = Array.from(
      { length: MAX_IMPORT_NOTES + 5 },
      (_, i) => `## S${i}\n\n${prose(5_500)}`,
    ).join('\n\n');
    const err = await planDocumentImport({ markdown, fileName: 'big.pdf', folder: '' }, none).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DocumentImportError);
    expect(err.code).toBe('TOO_LONG');
  });
});
