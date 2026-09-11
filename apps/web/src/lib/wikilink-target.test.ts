import { describe, expect, it } from 'vitest';

import { splitWikilinkTarget } from './wikilink-target';

describe('splitWikilinkTarget', () => {
  it('returns the target alone when there is no alias or section', () => {
    expect(splitWikilinkTarget('Nota')).toEqual({ target: 'Nota', alias: null, section: null });
  });

  it('splits off an alias', () => {
    expect(splitWikilinkTarget('Nota|Mostrar así')).toEqual({
      target: 'Nota',
      alias: 'Mostrar así',
      section: null,
    });
  });

  it('splits off a section', () => {
    expect(splitWikilinkTarget('Nota#Sección')).toEqual({
      target: 'Nota',
      alias: null,
      section: 'Sección',
    });
  });

  it('splits alias first, then section, matching the server parser', () => {
    expect(splitWikilinkTarget('Nota#Sección|Alias')).toEqual({
      target: 'Nota',
      alias: 'Alias',
      section: 'Sección',
    });
  });

  it('trims whitespace around each part', () => {
    expect(splitWikilinkTarget('  Nota # Sección | Alias  ')).toEqual({
      target: 'Nota',
      alias: 'Alias',
      section: 'Sección',
    });
  });
});
