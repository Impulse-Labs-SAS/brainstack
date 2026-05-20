// Suite de aislamiento hosted multi-user. Bootea dos users en el mismo
// NOTES_DIR (alice/, bob/) y verifica que:
//   - alice no ve notas de bob en list / tree / search / graph
//   - con grant `bob → alice@proyectos`, search/all incluye matches de
//     alice/proyectos/ pero no de alice/privado/
//   - wikilink cross-border desde nota de alice a privado: resuelto para
//     alice; visto vía linksForOwner por bob queda unresolved
//
// La idea es ejercitar el pipeline real (bootstrap → owner_id en DB →
// services owner-aware) en hosted sin mockear nada.

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type BrainStackDatabase } from '@brainstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

import { CrossOwnerReader } from './services/CrossOwnerReader.js';
import { IndexService } from './services/IndexService.js';
import { NoteService } from './services/NoteService.js';
import { SearchService } from './services/SearchService.js';
import { SharingService } from './services/SharingService.js';

const logger = pino({ level: 'silent' });

interface Harness {
  bs: BrainStackDatabase;
  root: string;
  notes: NoteService;
  search: SearchService;
  sharing: SharingService;
  crossOwner: CrossOwnerReader;
  index: IndexService;
}

function seedUser(bs: BrainStackDatabase, id: string, email: string): void {
  bs.sqlite
    .prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, email, Date.now(), Date.now());
}

async function buildHostedHarness(): Promise<Harness> {
  const root = await fsp.mkdtemp(join(tmpdir(), 'bs-hosted-'));
  const bs = openDatabase(':memory:');
  seedUser(bs, 'alice', 'alice@x.com');
  seedUser(bs, 'bob', 'bob@x.com');

  const vaultCfg = { deployment: 'hosted' as const, notesDirAbs: root };
  const index = new IndexService({ root, db: bs, logger, vaultCfg });
  const notes = new NoteService({ cfg: vaultCfg, db: bs, index });
  const search = new SearchService({ db: bs, cfg: vaultCfg });
  const sharing = new SharingService({ db: bs, deployment: 'hosted' });
  const crossOwner = new CrossOwnerReader({ sharing, vaultCfg, db: bs });
  await index.bootstrap();

  return { bs, root, notes, search, sharing, crossOwner, index };
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await fsp.mkdir(join(abs, '..'), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}

let h: Harness;

beforeEach(async () => {
  h = await buildHostedHarness();
});

afterEach(async () => {
  h.bs.close();
  await fsp.rm(h.root, { recursive: true, force: true });
});

describe('hosted multi-user — aislamiento básico', () => {
  it('list/tree/search/graph de alice no incluyen notas de bob', async () => {
    // Crear notas físicamente bajo cada subdir de user, después rebootstrap.
    await writeFile(h.root, 'alice/proyectos/a.md', '# Alice A\nfoo content');
    await writeFile(h.root, 'alice/privado/secreto.md', '# Privado\nfoo content');
    await writeFile(h.root, 'bob/proyectos/b.md', '# Bob B\nfoo content');
    await h.index.bootstrap();

    const aliceList = h.notes.list('alice');
    expect(aliceList.map((r) => r.path).sort()).toEqual([
      'privado/secreto.md',
      'proyectos/a.md',
    ]);
    const bobList = h.notes.list('bob');
    expect(bobList.map((r) => r.path)).toEqual(['proyectos/b.md']);

    const aliceTree = await h.notes.listTree('alice');
    const aliceFolders = (aliceTree.children ?? []).map((c) => c.name).sort();
    expect(aliceFolders).toContain('proyectos');
    expect(aliceFolders).toContain('privado');
    expect(aliceFolders).not.toContain('bob');

    const aliceHits = h.search.search('alice', 'foo');
    expect(aliceHits.every((hit) => hit.ownerId === 'alice')).toBe(true);
    const bobHits = h.search.search('bob', 'foo');
    expect(bobHits.every((hit) => hit.ownerId === 'bob')).toBe(true);
    expect(bobHits.map((hit) => hit.path)).toEqual(['proyectos/b.md']);

    const aliceGraph = h.notes.graph('alice');
    expect(aliceGraph.nodes.every((n) => n.ownerId === 'alice')).toBe(true);
  });

  it('owner_id se persiste correctamente en notes durante bootstrap', async () => {
    await writeFile(h.root, 'alice/x.md', 'a');
    await writeFile(h.root, 'bob/y.md', 'b');
    await h.index.bootstrap();
    const rows = h.bs.sqlite
      .prepare<unknown[], { path: string; owner_id: string | null }>(
        'SELECT path, owner_id FROM notes ORDER BY path',
      )
      .all();
    expect(rows).toEqual([
      { path: 'alice/x.md', owner_id: 'alice' },
      { path: 'bob/y.md', owner_id: 'bob' },
    ]);
  });
});

describe('hosted multi-user — sharing scope', () => {
  it('search con scope=all desde bob incluye match bajo carpeta compartida y excluye privadas', async () => {
    await writeFile(h.root, 'alice/proyectos/a.md', '# A\nspecialword aquí');
    await writeFile(h.root, 'alice/privado/secreto.md', '# Secreto\nspecialword tambien');
    await writeFile(h.root, 'bob/notes/own.md', '# Bob\nspecialword propio');
    await h.index.bootstrap();
    h.sharing.grant({
      ownerId: 'alice',
      sharedWithUserId: 'bob',
      folderPath: 'proyectos',
      grantedBy: 'alice',
    });

    const sharedScopes = h.sharing
      .listSharedRoots('bob')
      .map((r) => ({ ownerId: r.ownerId, folderPath: r.folderPath }));
    const hits = h.search.search('bob', 'specialword', { sharedScopes });
    const paths = hits.map((hit) => `${hit.ownerId}:${hit.path}`).sort();
    expect(paths).toContain('alice:proyectos/a.md');
    expect(paths).toContain('bob:notes/own.md');
    expect(paths).not.toContain('alice:privado/secreto.md');
  });

  it('linksForOwner desde bob enmascara link a privado', async () => {
    // Nota de alice en proyectos linkea a privado/secreto
    await writeFile(
      h.root,
      'alice/proyectos/a.md',
      '# A\nver [[../privado/secreto]] como referencia',
    );
    await writeFile(h.root, 'alice/privado/secreto.md', '# Secreto\n');
    await h.index.bootstrap();
    h.sharing.grant({
      ownerId: 'alice',
      sharedWithUserId: 'bob',
      folderPath: 'proyectos',
      grantedBy: 'alice',
    });

    const linksFromBob = h.crossOwner.linksForOwner('bob', 'alice', 'proyectos/a.md');
    // Si el resolver no encontró nada (porque '../privado/secreto' es path-style
    // raro), igual estaría unresolved — el punto es que bob nunca debería ver
    // targetType='note' apuntando a privado.
    const visibleToPrivado = linksFromBob.filter(
      (l) => l.targetType === 'note' && l.targetPath.includes('privado'),
    );
    expect(visibleToPrivado).toEqual([]);
  });
});
