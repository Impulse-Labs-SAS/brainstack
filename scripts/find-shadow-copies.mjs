// Finds the private copies of shared folders that the addressing bug created.
//
// Before `ownerId` existed, a write always resolved against the caller's own
// vault. So "impulse-labs/nota.md", typed by somebody who had been given a
// folder called `impulse-labs`, did not reach that folder: it made one of the
// same name under the writer, and the note went there. It reported success, so
// nobody noticed until the owner asked where the note was.
//
// The write path is fixed. This finds what the broken one left behind.
//
//   DATABASE_URL=... node scripts/find-shadow-copies.mjs
//
// Read-only. It prints what it found and changes nothing — deciding what to do
// with a shadow copy needs a person, because two of the outcomes are opposite:
//
//   - Empty, or holding only folders: the write was refused or abandoned.
//     Nothing was lost. Safe to delete.
//   - Holding notes: somebody wrote real content believing it was going to the
//     shared folder. That content exists nowhere else. It has to be moved
//     across before anything is deleted, and moving it is a judgement call —
//     the shared folder may already have a note by the same name, written by
//     somebody who could see it.
//
// So: run this, read it, then act. There is no --fix flag on purpose.

import { neon } from '@neondatabase/serverless';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const sql = neon(connectionString);

/** True when `path` is `folder` or sits inside it. Mirrors `pathFallsUnder`. */
function fallsUnder(path, folder) {
  if (folder === '') return true;
  if (path === folder) return true;
  return path.startsWith(`${folder}/`);
}

/** Drop the owner segment a stored path carries in hosted. */
function stripOwner(storedPath, ownerId) {
  const prefix = `${ownerId}/`;
  return storedPath.startsWith(prefix) ? storedPath.slice(prefix.length) : storedPath;
}

async function main() {
  const shares = await sql`
    SELECT s.folder_path,
           s.owner_id,
           s.shared_with_user_id,
           s.permission,
           owner.email  AS owner_email,
           viewer.email AS viewer_email
      FROM folder_shares s
      JOIN users owner  ON owner.id  = s.owner_id
      JOIN users viewer ON viewer.id = s.shared_with_user_id
     ORDER BY s.folder_path
  `;

  if (shares.length === 0) {
    console.log('No hay carpetas compartidas. Nada que revisar.');
    return;
  }

  console.log(`Revisando ${shares.length} share(s).\n`);

  let found = 0;

  for (const share of shares) {
    // The copy would live in the *recipient's* vault, under the same name as
    // the folder they were given.
    const viewerId = share.shared_with_user_id;
    const shadowPrefix = `${viewerId}/${share.folder_path}`;

    const notes = await sql`
      SELECT path, title, updated_at
        FROM notes
       WHERE path = ${shadowPrefix} OR path LIKE ${`${shadowPrefix}/%`}
       ORDER BY path
    `;
    const folders = await sql`
      SELECT path
        FROM folders
       WHERE path = ${shadowPrefix} OR path LIKE ${`${shadowPrefix}/%`}
       ORDER BY path
    `;

    if (notes.length === 0 && folders.length === 0) continue;

    found += 1;
    const verdict = notes.length > 0 ? 'TIENE CONTENIDO' : 'vacía';

    console.log('─'.repeat(72));
    console.log(`Copia sombra: ${share.folder_path}  [${verdict}]`);
    console.log(`  dueño real   : ${share.owner_email} (${share.owner_id})`);
    console.log(`  copia de     : ${share.viewer_email} (${viewerId})`);
    console.log(`  permiso      : ${share.permission}`);
    console.log(`  paths        : ${folders.length} carpeta(s), ${notes.length} nota(s)`);

    if (notes.length > 0) {
      console.log('\n  Notas que solo existen en la copia:');
      for (const note of notes) {
        const logical = stripOwner(note.path, viewerId);

        // Does the shared folder already hold a note at the same place? If it
        // does, moving is not a move — somebody has to compare the two.
        const [clash] = await sql`
          SELECT path FROM notes WHERE path = ${`${share.owner_id}/${logical}`} LIMIT 1
        `;

        const when = new Date(Number(note.updated_at)).toISOString().slice(0, 10);
        const flag = clash ? '  ⚠ ya existe en la carpeta compartida' : '';
        console.log(`    ${logical}  (${note.title || 'sin título'}, ${when})${flag}`);
      }
      console.log(
        '\n  → Mover a la carpeta compartida antes de borrar nada.\n' +
          `    Con permiso de escritura: create_note(ownerId="${share.owner_id}", ...)`,
      );
    } else {
      console.log('\n  → Sin notas. Se puede borrar sin perder nada.');
    }
    console.log();
  }

  console.log('─'.repeat(72));
  if (found === 0) {
    console.log('Ninguna copia sombra. El bug no dejó rastro en esta base.');
  } else {
    console.log(`${found} copia(s) sombra. Nada fue modificado — revisá y decidí.`);
  }

  // A sanity check the reader should not have to do by hand: a folder shared
  // with somebody whose own vault has a folder of that name is exactly the
  // collision the guard now refuses, so it will keep being refused until one
  // of the two is renamed or removed.
  if (found > 0) {
    console.log(
      '\nMientras existan, escribir esos paths sin ownerId sigue dando FORBIDDEN.\n' +
        'Es deliberado: el nombre es ambiguo hasta que la copia deje de existir.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
