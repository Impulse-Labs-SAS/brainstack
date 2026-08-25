import { describe, expect, it } from 'vitest';

import { fallsUnderRoot, parseSharedDropId, sharedDropId } from './shared-drop-id';

describe('sharedDropId / parseSharedDropId', () => {
  it('va y vuelve', () => {
    expect(parseSharedDropId(sharedDropId(0, 'Impulse Labs'))).toEqual({
      index: 0,
      folderPath: 'Impulse Labs',
    });
    expect(parseSharedDropId(sharedDropId(12, 'a/b/c'))).toEqual({
      index: 12,
      folderPath: 'a/b/c',
    });
  });

  it('sobrevive a nombres de carpeta con dos puntos', () => {
    // El motivo de partir por el *primer* colon después del índice: el resto es
    // el path, con los dos puntos que tenga.
    const id = sharedDropId(3, 'notas: 2026/reunión: lunes');
    expect(parseSharedDropId(id)).toEqual({
      index: 3,
      folderPath: 'notas: 2026/reunión: lunes',
    });
  });

  it('ignora los ids del árbol propio, que son paths pelados', () => {
    expect(parseSharedDropId('Brutus/sub')).toBeNull();
    expect(parseSharedDropId('__root__')).toBeNull();
  });

  it('rechaza las formas que se le parecen pero no lo son', () => {
    expect(parseSharedDropId('shared:')).toBeNull();
    expect(parseSharedDropId('shared:abc:x')).toBeNull();
    expect(parseSharedDropId('shared: 1:x')).toBeNull();
    expect(parseSharedDropId('shared:-1:x')).toBeNull();
    // Sin path no hay destino.
    expect(parseSharedDropId('shared:0:')).toBeNull();
  });

  it('una carpeta propia con ese nombre parsea, y por eso el caller valida', () => {
    // Este es el caso que obliga a `fallsUnderRoot`: la forma es legítima, el
    // destino no.
    const parsed = parseSharedDropId('shared:0:cualquier cosa');
    expect(parsed).toEqual({ index: 0, folderPath: 'cualquier cosa' });
    expect(fallsUnderRoot('cualquier cosa', 'Impulse Labs')).toBe(false);
  });
});

describe('fallsUnderRoot', () => {
  it('acepta la raíz misma y lo que cuelga', () => {
    expect(fallsUnderRoot('Impulse Labs', 'Impulse Labs')).toBe(true);
    expect(fallsUnderRoot('Impulse Labs/Brutus', 'Impulse Labs')).toBe(true);
  });

  it('no se pasa a un hermano que empieza igual', () => {
    expect(fallsUnderRoot('Impulse Labs Personal', 'Impulse Labs')).toBe(false);
    expect(fallsUnderRoot('otra', 'Impulse Labs')).toBe(false);
  });
});
