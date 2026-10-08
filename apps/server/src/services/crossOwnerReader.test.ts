import { PgNoteStore, pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CrossOwnerReader } from './CrossOwnerReader.js';
import { SharingService } from './SharingService.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users } = pgSchema;

let database: TestDatabase;
let store: PgNoteStore;
let sharing: SharingService;
let reader: CrossOwnerReader;

async function seedUser(id: string, email: string): Promise<void> {
  await database.db.insert(users).values({ id, email, createdAt: Date.now(), updatedAt: 0 });
}

/** Writes at the stored path, owner prefix and all. */
async function seedNote(ownerId: string, logicalPath: string, body: string): Promise<void> {
  await store.upsert(`${ownerId}/${logicalPath}`, body, ownerId);
}

async function grant(folderPath: string): Promise<void> {
  await sharing.grant({
    ownerId: 'owner',
    sharedWithUserId: 'viewer',
    folderPath,
    grantedBy: 'owner',
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  store = new PgNoteStore(database.db);
  sharing = new SharingService({ db: database.db });
  reader = new CrossOwnerReader({ sharing, db: database.db });
  await seedUser('owner', 'o@x.com');
  await seedUser('viewer', 'v@x.com');
});

describe('CrossOwnerReader', () => {
  it('getNote refuses without a grant', async () => {
    await seedNote('owner', 'proyectos/x.md', '# X');
    await expect(reader.getNote('viewer', 'owner', 'proyectos/x.md')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('getNote returns the note when a grant covers the path', async () => {
    await seedNote('owner', 'proyectos/x.md', '# X\n\ncuerpo');
    await grant('proyectos');

    const note = await reader.getNote('viewer', 'owner', 'proyectos/x.md');
    // The path comes back relative to the owner's root, without their id.
    expect(note.path).toBe('proyectos/x.md');
    expect(note.body).toContain('cuerpo');
  });

  it('getNote reports a missing note as not found, once access is granted', async () => {
    await grant('proyectos');
    await expect(reader.getNote('viewer', 'owner', 'proyectos/nope.md')).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('listTree needs a scope, and refuses the root', async () => {
    await grant('proyectos');
    await expect(reader.listTree('viewer', 'owner', '')).rejects.toThrow();
    await expect(reader.listTree('viewer', 'owner', 'otra')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('listTree only shows what is inside the shared folder', async () => {
    await seedNote('owner', 'proyectos/a.md', '# A');
    await seedNote('owner', 'proyectos/sub/b.md', '# B');
    await seedNote('owner', 'privado/secreto.md', '# S');
    await grant('proyectos');

    const tree = await reader.listTree('viewer', 'owner', 'proyectos');
    const names = (tree.children ?? []).map((c) => c.name).sort();

    expect(names).toEqual(['a.md', 'sub']);
    // A grant on one folder must not reveal the shape of the rest.
    expect(JSON.stringify(tree)).not.toContain('privado');
  });

  it('masks link targets the viewer cannot reach', async () => {
    // Targets first: links resolve when a note is written, so a link to a note
    // that does not exist yet stays unresolved until the source is rewritten.
    await seedNote('owner', 'proyectos/b.md', '# B');
    await seedNote('owner', 'privado/secreto.md', '# S');
    await seedNote('owner', 'proyectos/a.md', '# A\n\n[[proyectos/b]] y [[privado/secreto]]');
    await grant('proyectos');

    const links = await reader.linksForOwner('viewer', 'owner', 'proyectos/a.md');
    const reachable = links.filter((l) => l.targetType !== 'unresolved');

    expect(reachable.map((l) => l.targetPath)).toEqual(['proyectos/b.md']);
    // The link to the private note survives as a link, but unnamed.
    expect(JSON.stringify(links)).not.toContain('secreto');
  });

  it('backlinksForOwner omits sources the viewer cannot reach, rather than masking them', async () => {
    // proyectos/ is shared with the viewer; privado/ is not. A note inside
    // privado/ links into the shared folder — its existence must not leak.
    await seedNote('owner', 'proyectos/b.md', '# B');
    await seedNote('owner', 'privado/secreto.md', '# S\n\n[[proyectos/b]]');
    await seedNote('owner', 'proyectos/a.md', '# A\n\n[[proyectos/b]]');
    await grant('proyectos');

    const backlinks = await reader.backlinksForOwner('viewer', 'owner', 'proyectos/b.md');

    expect(backlinks.map((l) => l.sourcePath)).toEqual(['proyectos/a.md']);
    // Unlike a masked outbound target, an unreadable backlink source is
    // dropped entirely — there is no placeholder row naming "a hidden note".
    expect(JSON.stringify(backlinks)).not.toContain('secreto');
    expect(JSON.stringify(backlinks)).not.toContain('privado');
  });
});

/*
 * Una carpeta vacía no la implica ninguna nota, así que si el árbol del dueño
 * solo mira `notes`, nunca aparece. Crear una carpeta dentro de una carpeta
 * compartida decía "creada" y después no se veía.
 */
describe('listTree — carpetas vacías', () => {
  beforeEach(async () => {
    await grant('proyectos');
  });

  it('muestra una carpeta vacía creada dentro de lo compartido', async () => {
    await seedNote('owner', 'proyectos/nota.md', 'algo');
    await database.db
      .insert(pgSchema.folders)
      .values({ path: 'owner/proyectos/nueva', ownerId: 'owner', createdAt: Date.now() });

    const tree = await reader.listTree('viewer', 'owner', 'proyectos');

    expect(JSON.stringify(tree)).toContain('nueva');
  });

  it('las carpetas vacías anidadas también', async () => {
    await seedNote('owner', 'proyectos/nota.md', 'algo');
    await database.db.insert(pgSchema.folders).values([
      { path: 'owner/proyectos/a', ownerId: 'owner', createdAt: Date.now() },
      { path: 'owner/proyectos/a/b', ownerId: 'owner', createdAt: Date.now() },
    ]);

    const names = JSON.stringify(await reader.listTree('viewer', 'owner', 'proyectos'));
    expect(names).toContain('"a"');
    expect(names).toContain('"b"');
  });

  it('no se lleva carpetas de fuera de lo compartido', async () => {
    await seedNote('owner', 'proyectos/nota.md', 'algo');
    await database.db
      .insert(pgSchema.folders)
      .values({ path: 'owner/privado', ownerId: 'owner', createdAt: Date.now() });

    const tree = await reader.listTree('viewer', 'owner', 'proyectos');

    expect(JSON.stringify(tree)).not.toContain('privado');
  });
});
