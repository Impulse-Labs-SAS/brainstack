// Password hashing is the one place where a silent "yes" is a breach, so the
// negative cases matter more than the positive one.

import { describe, expect, it } from 'vitest';

import { DECOY_HASH, hashPassword, verifyPassword } from './password.js';

describe('hashPassword', () => {
  it('acepta la contraseña correcta', async () => {
    const stored = await hashPassword('correcta-y-larga-1');
    expect(await verifyPassword(stored, 'correcta-y-larga-1')).toBe(true);
  });

  it('rechaza la incorrecta, incluso por un carácter', async () => {
    const stored = await hashPassword('correcta-y-larga-1');
    expect(await verifyPassword(stored, 'correcta-y-larga-2')).toBe(false);
    expect(await verifyPassword(stored, 'correcta-y-larga-')).toBe(false);
    expect(await verifyPassword(stored, '')).toBe(false);
  });

  it('la misma contraseña da hashes distintos: la sal es nueva cada vez', async () => {
    const a = await hashPassword('la misma de siempre');
    const b = await hashPassword('la misma de siempre');
    expect(a).not.toBe(b);
    // Y las dos verifican, que es lo que la sal no puede romper.
    expect(await verifyPassword(a, 'la misma de siempre')).toBe(true);
    expect(await verifyPassword(b, 'la misma de siempre')).toBe(true);
  });

  it('guarda los parámetros junto al hash, para poder subir el costo después', async () => {
    const stored = await hashPassword('cualquiera-que-sirva');
    const [algo, n, r, p, salt, hash] = stored.split('$');
    expect(algo).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(16_384);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(hash!, 'base64')).toHaveLength(32);
  });
});

describe('verifyPassword no explota con lo que no entiende', () => {
  /**
   * Todo esto llega desde la base. Una fila corrupta, o un hash de argon2 de
   * antes de este módulo, tiene que ser un "no" — nunca una excepción en el
   * camino del login, y nunca un "sí".
   */
  const basura = [
    '',
    'no-es-un-hash',
    'scrypt$',
    'scrypt$1$2$3',
    'scrypt$16384$8$1$solo-cuatro-partes',
    'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
    '$argon2id$v=19$m=19456,t=2,p=1$ZGVjb3lkZWNveWRlY295ZGU$lZbZx0WgPa1xQp4qF2tQE3W3uX7YBgmkOdGqQyMS7C0',
  ];

  for (const value of basura) {
    it(`devuelve false para ${JSON.stringify(value.slice(0, 32))}`, async () => {
      await expect(verifyPassword(value, 'cualquier-cosa')).resolves.toBe(false);
    });
  }

  it('no acepta un costo capaz de colgar el proceso', async () => {
    const salt = Buffer.alloc(16, 1).toString('base64');
    const hash = Buffer.alloc(32, 2).toString('base64');
    const absurdo = `scrypt$1073741824$1024$16$${salt}$${hash}`;
    // Rechazado por los límites, no intentado: si se intentara, este test no
    // terminaría.
    await expect(verifyPassword(absurdo, 'x')).resolves.toBe(false);
  });
});

describe('DECOY_HASH', () => {
  it('tiene forma válida y no lo abre ninguna contraseña', async () => {
    expect(DECOY_HASH.split('$')).toHaveLength(6);
    expect(await verifyPassword(DECOY_HASH, '')).toBe(false);
    expect(await verifyPassword(DECOY_HASH, 'admin')).toBe(false);
    expect(await verifyPassword(DECOY_HASH, 'password123')).toBe(false);
  });

  it('cuesta lo mismo que un hash real: es para lo que existe', async () => {
    const real = await hashPassword('una cualquiera');

    const t0 = process.hrtime.bigint();
    await verifyPassword(DECOY_HASH, 'intento');
    const decoyMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    await verifyPassword(real, 'intento');
    const realMs = Number(process.hrtime.bigint() - t1) / 1e6;

    // Holgado a propósito: la máquina de CI tiene sus tiempos. Lo que se
    // descarta acá es un decoy que rechace al instante, que delataría en cada
    // login si la cuenta existe.
    const ratio = decoyMs / Math.max(realMs, 0.001);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });
});
