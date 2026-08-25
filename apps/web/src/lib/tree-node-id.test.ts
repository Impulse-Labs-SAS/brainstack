import { describe, expect, it } from 'vitest';

import { isInside, nodeId, parseNodeId, sameNode } from './tree-node-id';

describe('nodeId / parseNodeId', () => {
  it('va y vuelve', () => {
    const ref = { ownerId: 'u_pablo', path: '01 Impulse Labs/Brutus' };
    expect(parseNodeId(nodeId(ref))).toEqual(ref);
  });

  it('sobrevive nombres con espacios, barras y dos puntos', () => {
    const ref = { ownerId: 'u_1', path: 'notas: 2026/reunión lunes/a:b' };
    expect(parseNodeId(nodeId(ref))).toEqual(ref);
  });

  it('distingue el mismo path en dos bóvedas', () => {
    const mio = { ownerId: 'u_yo', path: 'impulse-labs' };
    const suyo = { ownerId: 'u_pablo', path: 'impulse-labs' };
    expect(nodeId(mio)).not.toBe(nodeId(suyo));
    expect(sameNode(mio, suyo)).toBe(false);
  });

  it('la raíz de una bóveda es un path vacío, no un id roto', () => {
    expect(parseNodeId(nodeId({ ownerId: 'u_yo', path: '' }))).toEqual({
      ownerId: 'u_yo',
      path: '',
    });
  });
});

describe('isInside', () => {
  it('cubre el nodo mismo y lo que cuelga', () => {
    const a = { ownerId: 'u', path: 'x/y' };
    expect(isInside(a, { ownerId: 'u', path: 'x' })).toBe(true);
    expect(isInside(a, { ownerId: 'u', path: 'x/y' })).toBe(true);
    expect(isInside(a, { ownerId: 'u', path: '' })).toBe(true);
  });

  it('no se pasa a un hermano que empieza igual', () => {
    expect(isInside({ ownerId: 'u', path: 'xy' }, { ownerId: 'u', path: 'x' })).toBe(false);
  });

  it('nunca cruza de bóveda', () => {
    // Lo que impide que arrastrar sobre una carpeta ajena se lea como
    // "moverla dentro de sí misma".
    expect(isInside({ ownerId: 'a', path: 'x/y' }, { ownerId: 'b', path: 'x' })).toBe(false);
  });
});
