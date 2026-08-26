// Finds grants whose folder no longer exists.
//
// A share names a folder by path. Deleting that folder, or moving it into
// somebody else's vault, used to leave the row untouched — so the grant
// outlived the thing it was about. What that looked like: the person it was
// shared with kept a root in their tree that was permanently empty, because
// nothing could ever be under a folder that is gone.
//
// The move across vaults is where it showed. Fede moved a folder Pablo had
// shared with him into one of his own, which empties the source; Pablo's
// `Brutus` disappeared from Pablo's vault and stayed in Fede's tree.
//
//   DATABASE_URL=... node scripts/find-orphan-shares.mjs
//   DATABASE_URL=... node scripts/find-orphan-shares.mjs --fix
//
// Dry-run by default. Unlike find-shadow-copies.mjs there is a --fix here,
// because there is no judgement to make: a grant on a folder that does not
// exist grants nothing, and deleting it destroys no content. Live invites for
// those paths are revoked too — an invite is a way back in, and one pointing
// at a path that is gone would quietly cover a *new* folder if the owner ever
// reused the name.
//
// The code paths that created these are fixed: a folder that leaves the vault
// takes its grants with it (SharingService.revokeUnder), and one that is merely
// renamed carries them along (reparentUnder). This is only for the rows left
// behind before that.
//
// Read the dry run before passing --fix. A grant orphaned by a *rename* names a
// folder that still exists somewhere under another name, and there is no way
// from here to know which — deleting it is right, but whoever owned it will
// want to share the new path again.

import { neon } from '@neondatabase/serverless';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const fix = process.argv.includes('--fix');
const sql = neon(connectionString);

/** True when `path` is `folder` or sits inside it. Mirrors `pathFallsUnder`. */
function fallsUnder(path, folder) {
  if (folder === '') return true;
  if (path === folder) return true;
  return path.startsWith(`${folder}/`);
}

const shares = await sql`
  SELECT fs.id,
         fs.folder_path,
         fs.owner_id,
         fs.permission,
         owner.email AS owner_email,
         recipient.email AS recipient_email
    FROM folder_shares fs
    JOIN users owner ON owner.id = fs.owner_id
    JOIN users recipient ON recipient.id = fs.shared_with_user_id
   ORDER BY owner.email, fs.folder_path
`;

if (shares.length === 0) {
  console.log('No shares at all. Nothing to check.');
  process.exit(0);
}

// Every path in the system, matched in memory rather than with a LIKE per
// share: a folder name may contain LIKE's pattern characters, and a share
// deleted by accident is access silently cut to a folder that is still there.
const [folderRows, noteRows] = await Promise.all([
  sql`SELECT path FROM folders`,
  sql`SELECT path FROM notes`,
]);

const folderPaths = new Set(folderRows.map((r) => r.path));
const notePaths = noteRows.map((r) => r.path);

/** A folder exists if it has a row, or if any note sits under it. */
function folderExists(physical) {
  if (folderPaths.has(physical)) return true;
  return notePaths.some((p) => p.startsWith(`${physical}/`));
}

const orphans = shares.filter((s) => !folderExists(`${s.owner_id}/${s.folder_path}`));

console.log(
  `${shares.length} share(s) total, ${orphans.length} pointing at a folder that is gone.`,
);

if (orphans.length === 0) process.exit(0);

console.log('');
for (const o of orphans) {
  console.log(
    `  ${o.owner_email} shared "${o.folder_path}" (${o.permission}) with ${o.recipient_email}`,
  );
}
console.log('');

if (!fix) {
  console.log('Dry run. Re-run with --fix to delete these grants and revoke their invites.');
  process.exit(0);
}

const ids = orphans.map((o) => o.id);
await sql`DELETE FROM folder_shares WHERE id = ANY(${ids})`;

// The invites for those same paths, so nobody can accept their way back into a
// folder that no longer exists.
const invites = await sql`
  SELECT id, owner_id, folder_path FROM folder_share_invites WHERE revoked_at IS NULL
`;
const doomedInvites = invites
  .filter((i) =>
    orphans.some((o) => o.owner_id === i.owner_id && fallsUnder(i.folder_path, o.folder_path)),
  )
  .map((i) => i.id);

if (doomedInvites.length > 0) {
  await sql`UPDATE folder_share_invites SET revoked_at = ${Date.now()} WHERE id = ANY(${doomedInvites})`;
}

console.log(`Deleted ${ids.length} grant(s), revoked ${doomedInvites.length} live invite(s).`);
