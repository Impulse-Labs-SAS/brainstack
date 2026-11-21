import { describe, expect, it } from 'vitest';

import {
  documentTitle,
  partFileName,
  partName,
  partTitle,
  sameTitle,
  stripNumbering,
  titleMatcher,
} from './naming.js';
import type { Heading } from './outline.js';

const h = (level: number, text: string): Heading => ({ level, text });

describe('stripNumbering', () => {
  it('drops numbering followed by a separator and a space', () => {
    expect(stripNumbering('2. Puntos acordados')).toBe('Puntos acordados');
    expect(stripNumbering('I. Intro')).toBe('Intro');
    expect(stripNumbering('2) Algo')).toBe('Algo');
    expect(stripNumbering('3.1. Detalle')).toBe('Detalle');
  });

  it('leaves alone what only looks like numbering', () => {
    expect(stripNumbering('2026 en números')).toBe('2026 en números');
    expect(stripNumbering('Iglesia')).toBe('Iglesia');
    expect(stripNumbering('2.Sin espacio')).toBe('2.Sin espacio');
    expect(stripNumbering('1. ')).toBe('1.');
  });
});

describe('sameTitle', () => {
  it('ignores case, accents, punctuation and filler words', () => {
    expect(
      sameTitle(
        'Acuerdo de Plan de Responsabilidad Parental',
        'acuerdo plan responsabilidad parental',
      ),
    ).toBe(true);
    expect(sameTitle('Régimen de Comunicación', 'REGIMEN COMUNICACION.')).toBe(true);
    expect(sameTitle('Plan propuesto', 'Plan acordado')).toBe(false);
    expect(sameTitle('de la', 'el')).toBe(false);
  });
});

describe('titleMatcher', () => {
  it('takes a heading like the file name, or a lone opening level-1 heading, as the title', () => {
    const opening = h(1, 'Orbit — contrato marco');
    const isTitle = titleMatcher('scan_0042', [opening, h(2, 'Objeto')]);
    expect(isTitle(opening)).toBe(true);
    expect(isTitle(h(2, 'Objeto'))).toBe(false);
    expect(titleMatcher('Atlas', [h(2, 'Intro')])(h(2, 'ATLAS'))).toBe(true);
  });

  it('does not take the first of several level-1 headings', () => {
    const first = h(1, 'Uno');
    expect(titleMatcher('file', [first, h(1, 'Dos')])(first)).toBe(false);
  });
});

describe('partName', () => {
  const isTitle = (x: Heading) => x.text === 'Atlas';

  it('names a part after its highest-level heading, the first of that level', () => {
    expect(
      partName(
        { text: '', headings: [h(3, 'Detalle'), h(2, '1. Datos'), h(2, '2. Puntos')] },
        isTitle,
      ),
    ).toBe('Datos');
  });

  it('calls the part under the title, or with no heading, Introducción', () => {
    expect(partName({ text: '', headings: [h(1, 'Atlas')] }, isTitle)).toBe('Introducción');
    expect(partName({ text: '', headings: [] }, isTitle)).toBe('Introducción');
  });

  it('names a part that continues an opened section after it', () => {
    expect(
      partName(
        { text: '', headings: [h(3, 'Cuota')], continues: h(2, '3. Plan propuesto') },
        isTitle,
      ),
    ).toBe('Plan propuesto (cont.)');
  });
});

describe('file names and titles', () => {
  it('numbers parts in order, as wide as the count needs', () => {
    expect(partFileName(0, 3, 'Introducción')).toBe('01 - Introducción');
    expect(partFileName(9, 120, 'X')).toBe('010 - X');
  });

  it('gives each part a title that names the document', () => {
    expect(partTitle('Atlas', 'Introducción')).toBe('Atlas — Introducción');
  });

  it('takes the document title from the file name', () => {
    expect(documentTitle('C:\\docs\\Orbit proposal.pdf')).toBe('Orbit proposal');
    expect(documentTitle('Q3 [draft] #2 | v1: final?.pdf')).toBe('Q3 draft 2 v1 final');
  });
});
