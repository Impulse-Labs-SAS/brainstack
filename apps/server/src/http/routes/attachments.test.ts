// Tests del endpoint HTTP de attachments. Construye un harness mínimo:
// Hono root con un middleware que injecta el principal sin pasar por
// session/api-key (no estamos testeando auth acá), y monta el router. El
// FS es un tmpdir real para validar streaming, Range y traversal.

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SharingService } from '../../services/SharingService.js';
import type { AuthBindings } from '../middleware/auth.js';
import {
  createAttachmentsRouter,
  mimeFromPath,
  parseRange,
} from './attachments.js';

interface Harness {
  bs: BrainStackDatabase;
  root: string;
  app: Hono<AuthBindings>;
  fetch(path: string, init?: RequestInit, userId?: string): Promise<Response>;
}

function seedUser(bs: BrainStackDatabase, id: string, email: string): void {
  bs.sqlite
    .prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, email, Date.now(), Date.now());
}

async function buildHarness(deployment: 'self-host' | 'hosted'): Promise<Harness> {
  const root = await fsp.mkdtemp(join(tmpdir(), 'bs-att-'));
  const bs = openDatabase(':memory:');
  seedUser(bs, 'alice', 'alice@x.com');
  seedUser(bs, 'bob', 'bob@x.com');
  const sharing = new SharingService({ db: bs, deployment });

  const app = new Hono<AuthBindings>();

  // Tiny auth shim: lee X-Test-User y arma un principal mínimo.
  app.use('*', async (c, next) => {
    const u = c.req.header('x-test-user');
    if (u) {
      c.set('principal', {
        kind: 'user',
        user: { id: u, email: `${u}@x.com` } as { id: string; email: string } & Record<string, unknown> as never,
      });
    }
    await next();
  });

  app.route(
    '/api/attachments',
    createAttachmentsRouter({
      vaultCfg: { deployment, notesDirAbs: root },
      sharing,
    }),
  );

  return {
    bs,
    root,
    app,
    fetch: (p, init, userId) => {
      const headers = new Headers(init?.headers ?? {});
      if (userId) headers.set('x-test-user', userId);
      return Promise.resolve(
        app.fetch(new Request(`http://test${p}`, { ...init, headers })),
      );
    },
  };
}

async function writeFile(root: string, rel: string, content: Buffer | string): Promise<void> {
  const abs = join(root, rel);
  await fsp.mkdir(join(abs, '..'), { recursive: true });
  await fsp.writeFile(abs, content);
}

let h: Harness;

describe('GET /api/attachments/* — self-host', () => {
  beforeEach(async () => {
    h = await buildHarness('self-host');
  });
  afterEach(async () => {
    h.bs.close();
    await fsp.rm(h.root, { recursive: true, force: true });
  });

  it('200 con mime correcto y Content-Length', async () => {
    const bytes = Buffer.from('hello world');
    await writeFile(h.root, 'Attachments/2026/05/hello.txt', bytes);
    const res = await h.fetch('/api/attachments/Attachments/2026/05/hello.txt', undefined, 'alice');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('hello world');
  });

  it('206 con Range pidiendo un slice', async () => {
    const bytes = Buffer.from('0123456789ABCDEF');
    await writeFile(h.root, 'Attachments/big.bin', bytes);
    const res = await h.fetch(
      '/api/attachments/Attachments/big.bin',
      { headers: { range: 'bytes=4-9' } },
      'alice',
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 4-9/16');
    expect(res.headers.get('content-length')).toBe('6');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe('456789');
  });

  it('416 con Range fuera de límite', async () => {
    await writeFile(h.root, 'Attachments/tiny.bin', Buffer.from('abc'));
    const res = await h.fetch(
      '/api/attachments/Attachments/tiny.bin',
      { headers: { range: 'bytes=99-200' } },
      'alice',
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */3');
  });

  it('404 si el archivo no existe', async () => {
    const res = await h.fetch('/api/attachments/Attachments/missing.png', undefined, 'alice');
    expect(res.status).toBe(404);
  });

  it('400 si el path no cae bajo Attachments/', async () => {
    await writeFile(h.root, 'Notes/x.md', 'x');
    const res = await h.fetch('/api/attachments/Notes/x.md', undefined, 'alice');
    expect(res.status).toBe(400);
  });

  it('401 si no hay principal', async () => {
    await writeFile(h.root, 'Attachments/x.txt', 'x');
    const res = await h.fetch('/api/attachments/Attachments/x.txt');
    expect(res.status).toBe(401);
  });

  it('?download=1 setea Content-Disposition: attachment', async () => {
    await writeFile(h.root, 'Attachments/file.pdf', Buffer.from('%PDF-1.4'));
    const res = await h.fetch(
      '/api/attachments/Attachments/file.pdf?download=1',
      undefined,
      'alice',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('file.pdf');
  });
});

describe('GET /api/attachments/* — hosted (cross-owner)', () => {
  beforeEach(async () => {
    h = await buildHarness('hosted');
  });
  afterEach(async () => {
    h.bs.close();
    await fsp.rm(h.root, { recursive: true, force: true });
  });

  it('bob no ve attachments de alice (404, vault scope)', async () => {
    await writeFile(h.root, 'alice/Attachments/secret.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // alice OK
    const ok = await h.fetch('/api/attachments/Attachments/secret.png', undefined, 'alice');
    expect(ok.status).toBe(200);
    // bob: queda fuera de su vault, debería ser 404
    const blocked = await h.fetch('/api/attachments/Attachments/secret.png', undefined, 'bob');
    expect(blocked.status).toBe(404);
  });
});

describe('helpers de attachments', () => {
  it('mimeFromPath', () => {
    expect(mimeFromPath('foo.PNG')).toBe('image/png');
    expect(mimeFromPath('a/b/c.pdf')).toBe('application/pdf');
    expect(mimeFromPath('weird')).toBe('application/octet-stream');
    expect(mimeFromPath('x.unknown')).toBe('application/octet-stream');
  });

  it('parseRange', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=200-300', 100)).toBe('invalid');
    expect(parseRange('garbage', 100)).toBe('invalid');
    expect(parseRange('bytes=5-3', 100)).toBe('invalid');
  });
});
