// Tools that change a vault. Every write goes through Sentinel's batch (`ctx.save`), one change or many.

import { NOTE_MAX_CHARS, type NoteEdit } from '@brainstack/core/sentinel';
import { z } from 'zod';

import { field, frontmatterField, noteContent } from '../../config/limits.js';
import { AppError, toAppError } from '../../lib/errors.js';

import { MAX_CHANGES, type Change } from '../../services/applyChanges.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EDITS, JSON_TEXT, TEXT } from '../shared.js';
import type { McpToolContext } from '../context.js';

export function registerWriteTools(server: McpServer, ctx: McpToolContext): void {
  const {
    notes,
    sharing,
    toMcpError,
    requireUserId,
    ownerOf,
    requireWriteAccess,
    assertWrite,
    save,
    writeOne,
    OWNER_ARG,
  } = ctx;

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description: `Create a new note at the given path. Fails if a note already exists, or if its body is longer than ${NOTE_MAX_CHARS} characters (TOO_LONG): split a longer one into several notes. Returns the final path plus \`affectedMocs\`: the existing \`_<Folder>.md\` index note for the parent folder, if any, which you should consider updating to link the new note.`,
      inputSchema: {
        path: field().min(1),
        content: noteContent(),
        frontmatter: frontmatterField().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, content, frontmatter, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        const { done, failed } = await writeOne({
          action: 'create',
          owner: ownerOf(ownerId),
          path,
          content,
          ...(frontmatter ? { frontmatter } : {}),
        });
        if (failed) return failed;
        return JSON_TEXT({
          path: done.path,
          affectedMocs: done.affectedMocs ?? [],
          checksum: done.checksum,
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update a note',
      description: `Replace the whole contents of an existing note — for a rewrite. To change part of a note, use edit_note, which sends only what changes. Fails if the note does not exist. Pass the \`checksum\` get_note returned as \`expectedChecksum\` so the write is refused, instead of overwriting, if someone changed the note since you read it. The body may not grow past ${NOTE_MAX_CHARS} characters (TOO_LONG); a note already past it may only shrink.`,
      inputSchema: {
        path: field().min(1),
        content: noteContent(),
        ownerId: OWNER_ARG,
        expectedChecksum: field()
          .optional()
          .describe(
            'The checksum get_note returned; the update fails with CHANGED if the note moved on.',
          ),
      },
    },
    async ({ path, content, ownerId, expectedChecksum }) => {
      try {
        await assertWrite(path, ownerId);
        const { done, failed } = await writeOne({
          action: 'replace',
          owner: ownerOf(ownerId),
          path,
          content,
          ...(expectedChecksum ? { expectedChecksum } : {}),
        });
        if (failed) return failed;
        return TEXT(`Updated ${done.path} (checksum ${done.checksum})`);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'edit_note',
    {
      title: 'Edit part of a note',
      description:
        'Change an existing note by saying what changes, without sending it back whole — prefer this to update_note for any change that is not a full rewrite. `edits` apply in order: `replace` swaps one exact passage (it must appear exactly once; an empty `replace` deletes it), `append` adds text at the end of the note or of a `section` (a heading such as "Notas", in any case and with or without accents; the start of a heading names it too, when only one heading begins with it), `prepend` adds it at the start or right under a section\'s heading, `set_frontmatter` merges keys (null removes one). Text is inserted as whole lines; for a paragraph of its own, start an appended text with an empty line and end a prepended one with one. `replace` works on the body only. If an anchor is missing or ambiguous nothing is written and the error says which. Pass the `checksum` from gather_context or get_note as `expectedChecksum`; without one the edit still lands only on the version it was applied to. You do not need to open the note first when gather_context already showed you the passage or listed the section.' +
        ` The body may not grow past ${NOTE_MAX_CHARS} characters (TOO_LONG): split the note instead. A note already past it may only shrink.`,
      inputSchema: {
        path: field().min(1),
        edits: EDITS,
        ownerId: OWNER_ARG,
        expectedChecksum: field()
          .optional()
          .describe('The checksum you read; the edit fails with CHANGED if the note moved on.'),
      },
    },
    async ({ path, edits, ownerId, expectedChecksum }) => {
      try {
        await assertWrite(path, ownerId);
        const { done, failed } = await writeOne({
          action: 'edit',
          owner: ownerOf(ownerId),
          path,
          edits: edits as NoteEdit[],
          ...(expectedChecksum ? { expectedChecksum } : {}),
        });
        if (failed) return failed;
        return JSON_TEXT({ path: done.path, checksum: done.checksum });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  /**
   * apply_changes, and save_notes, its name until it learnt to move notes and
   * create folders. The old name stays for one release so a client that still
   * lists it keeps working; both run the same code and answer the same way.
   */
  const CHANGE_FIELDS = {
    ownerId: OWNER_ARG,
  };
  const CHANGES = z
    .array(
      z.discriminatedUnion('action', [
        z.object({
          action: z.literal('create'),
          path: field().min(1),
          content: noteContent(),
          frontmatter: frontmatterField().optional(),
          ...CHANGE_FIELDS,
        }),
        z.object({
          action: z.literal('edit'),
          path: field().min(1),
          edits: EDITS,
          expectedChecksum: field().optional(),
          ...CHANGE_FIELDS,
        }),
        z.object({
          action: z.literal('replace'),
          path: field().min(1),
          content: noteContent(),
          expectedChecksum: field().optional(),
          ...CHANGE_FIELDS,
        }),
        z.object({
          action: z.literal('delete'),
          path: field().min(1),
          recursive: z.boolean().optional(),
          ...CHANGE_FIELDS,
        }),
        z.object({
          action: z.literal('create_folder'),
          path: field().min(1),
          ...CHANGE_FIELDS,
        }),
        z.object({
          action: z.literal('move'),
          from: field().min(1),
          to: field().min(1),
          ...CHANGE_FIELDS,
        }),
      ]),
    )
    .min(1)
    .max(MAX_CHANGES);
  type ChangeInput = z.infer<typeof CHANGES>[number];

  const APPLY_DESCRIPTION = `Apply a plan of changes in one call — use it whenever a plan has more than one step: reorganising (create folders, move or rename notes and folders), creating notes and linking them from their index, adjusting the notes that mention them, removing one. Each change has an \`action\`: \`create\` (path, content, frontmatter?), \`edit\` (path, edits — the same edits as edit_note, expectedChecksum?), \`replace\` (path, content, expectedChecksum? — a full rewrite), \`delete\` (path, recursive?), \`create_folder\` (path) or \`move\` (from, to — a note, attachment or folder, inside one vault). Each takes an optional \`ownerId\` for a folder shared with the user. Changes run in order and each sees what the ones before it left: after moving \`a/\` to \`b/\`, edit \`b/...\`. Moving a folder rewrites every wikilink to what it held and renames its index note with it (\`a/_a.md\` becomes \`b/_b.md\`). Everything is checked before anything is written: paths, permission, that what you change or move exists, that every destination is free, every edit's anchor, every checksum. If any check fails nothing is written and \`results\` says which change failed and why. If one still fails while writing (someone saved that note a moment ago) the ones before it stay, the rest are \`skipped\`, and \`saved\` is false. A note may be written (create, edit, replace, delete) by one change only; moving it does not count. The answer carries the state the plan left, so there is no need to read again: each note's final \`path\` and \`checksum\`, each move's \`moved\` notes and \`linksRewritten\`, \`touched\` (notes a move rewrote that no change named, with their new checksum) and a one-line \`summary\`. At most ${MAX_CHANGES} changes. No note's body may grow past ${NOTE_MAX_CHARS} characters (TOO_LONG): a longer note is split into several, linked from a short summary note — which is itself one apply_changes. Moving notes into another person's vault is not a change: that is move_to_owner. Needs the user's approval like any other write: put the whole plan to them once.`;

  const runChanges = async (changes: ChangeInput[]) => {
    try {
      requireWriteAccess();
      const userId = requireUserId();
      // Permission for every change before any note is looked at, with the
      // shared roots fetched once rather than once per change.
      const roots = await sharing.listSharedRoots(userId);
      await Promise.all(
        changes.map(async (c, i) => {
          const paths = c.action === 'move' ? [c.from, c.to] : [c.path];
          try {
            for (const p of paths) {
              await sharing.assertCanWrite(userId, ownerOf(c.ownerId), p);
              if (c.ownerId === undefined) {
                await sharing.assertNotShadowingShare(userId, p, roots);
              }
            }
          } catch (err) {
            const known = toAppError(err);
            if (!known) throw err;
            throw new AppError(
              `change ${i + 1} (${paths[0]}): ${known.message}`,
              known.code,
              known.status,
            );
          }
        }),
      );
      const planned = changes.map((c): Change => {
        const owner = ownerOf(c.ownerId);
        if (c.action === 'move') return { action: 'move', path: c.from, to: c.to, owner };
        const { ownerId: _ownerId, ...rest } = c;
        return { ...rest, owner } as Change;
      });
      return JSON_TEXT(await save(planned));
    } catch (err) {
      return toMcpError(err);
    }
  };

  server.registerTool(
    'apply_changes',
    {
      title: 'Apply several changes at once',
      description: APPLY_DESCRIPTION,
      inputSchema: { changes: CHANGES },
    },
    async ({ changes }) => runChanges(changes),
  );

  server.registerTool(
    'save_notes',
    {
      title: 'Save several changes at once (deprecated)',
      description: `Deprecated: use apply_changes, which takes the same changes as \`changes\`. This name stays for one release and then goes. ${APPLY_DESCRIPTION}`,
      inputSchema: { writes: CHANGES },
    },
    async ({ writes }) => runChanges(writes),
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Create a folder',
      description:
        'Create a folder (and any missing parents) under the vault root. Idempotent: a no-op if the folder already exists.',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        const { done, failed } = await writeOne({
          action: 'create_folder',
          owner: ownerOf(ownerId),
          path,
        });
        if (failed) return failed;
        return TEXT(`Created folder ${done.path}`);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'move',
    {
      title: 'Move or rename a note, attachment, or folder',
      description:
        'Move/rename a path. Wikilinks pointing at the moved path(s) — including aliases, sections, and attachment embeds — are rewritten across the vault. Folders are moved with all their contents, and a renamed folder renames its index note with it (`a/_a.md` becomes `b/_b.md`). Returns the final path, `moved` (each note that changed path, with its checksum), `linksRewritten` (the notes whose links were rewritten) and `affectedMocs`: existing `_<Folder>.md` index notes that you should consider updating. To move several things, or move and then edit, send one apply_changes.',
      inputSchema: { from: field().min(1), to: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ from, to, ownerId }) => {
      try {
        // One owner for both ends: a move stays inside a single vault.
        await assertWrite(from, ownerId);
        await assertWrite(to, ownerId);
        const { done, failed } = await writeOne({
          action: 'move',
          owner: ownerOf(ownerId),
          path: from,
          to,
        });
        if (failed) return failed;
        return JSON_TEXT({
          path: done.path,
          affectedMocs: done.affectedMocs ?? [],
          moved: done.moved ?? [],
          linksRewritten: done.linksRewritten ?? [],
          ...(done.checksum ? { checksum: done.checksum } : {}),
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'move_to_owner',
    {
      title: 'Move a note or folder into another vault',
      description:
        'TRANSFERS OWNERSHIP. Move a note or folder from one person’s vault into another’s — out of a folder somebody shared with you, for example into your own notes. It never takes notes out of the user’s own vault: giving them away is done by the user in the web app (dragging them onto the shared folder in the file tree), and this tool refuses it. This is not a copy and not a reorganisation: the notes leave the source vault and belong to the destination owner afterwards. Whoever owned them stops owning them, and keeps access only if the destination is shared with them — possibly at a narrower permission than they had, or not at all. ALWAYS tell the user this before calling, name who stops being the owner, and get their agreement; a request to tidy up or to move something into another folder does not by itself mean they intend to take ownership of somebody else’s notes. Requires write access at both ends. Wikilinks crossing the new boundary cannot be rewritten (a wikilink cannot name a vault), so the answer lists what was left dangling in each direction rather than repairing it silently. Calling this without `userConfirmedOwnershipTransfer` moves nothing and answers with what the transfer would cost, which is what you put to the user. Use `move` for anything staying inside one vault, which changes no ownership.',
      inputSchema: {
        from: field().min(1),
        fromOwnerId: OWNER_ARG,
        to: field().min(1),
        toOwnerId: z
          .string()
          .min(1)
          .describe('Owner of the destination vault. Required, and must differ from the source.'),
        userConfirmedOwnershipTransfer: z
          .boolean()
          .optional()
          .describe(
            'Set to true ONLY after the user has been told this transfers ownership and has ' +
              'agreed. Leave it out on the first call: the tool then moves nothing and answers ' +
              'with exactly what the transfer would cost, for you to put to the user. Setting ' +
              'it without having asked is a false statement about a conversation that did not ' +
              'happen.',
          ),
      },
    },
    async ({ from, fromOwnerId, to, toOwnerId, userConfirmedOwnershipTransfer }) => {
      try {
        const previousOwner = ownerOf(fromOwnerId);
        // Giving the caller's own notes away cannot be undone by them, and the
        // flag below is only the assistant's word that they agreed. That
        // direction is the person's own action, in the web app, where they
        // confirm it themselves — the same reason share_folder only asks.
        if (previousOwner === requireUserId() && toOwnerId !== previousOwner) {
          throw new AppError(
            'Moving your own notes into someone else’s vault makes them the owner, and only you ' +
              'can do that: drag the note or folder onto the shared folder in the BrainStack web ' +
              'app. Tell the user so; this tool does not do it.',
            'FORBIDDEN',
            403,
          );
        }
        // Taking something out of a vault is a write on that vault.
        await assertWrite(from, fromOwnerId);
        await assertWrite(to, toOwnerId);

        // What the previous owner is left with, which depends on the grants
        // rather than on the notes — so it can be answered before moving.
        const stillWritable = await sharing.canWrite(previousOwner, toOwnerId, to);
        const stillReadable =
          stillWritable || (await sharing.canRead(previousOwner, toOwnerId, to));
        const previousOwnerAccess = stillWritable ? 'write' : stillReadable ? 'read' : 'none';

        // The gate. A description asking the model to warn the user is an
        // instruction, and an instruction can be skipped; by the time the
        // answer explains what the transfer cost, it has already happened.
        // Withholding the move until a flag says the conversation took place
        // is the same warning made structural: the first call cannot move
        // anything, and it hands back the specifics to put to the user.
        if (!userConfirmedOwnershipTransfer) {
          const affected = await notes.list(previousOwner, { folder: from });
          return JSON_TEXT({
            moved: false,
            reason: 'needs the user to agree to a change of ownership',
            wouldTransfer: {
              path: from,
              notes: affected.length,
              fromOwnerId: previousOwner,
              toOwnerId,
              previousOwnerAccessAfterwards: previousOwnerAccess,
            },
            askTheUser:
              `Moving "${from}" into ${toOwnerId}'s vault makes ${toOwnerId} the owner of ` +
              `${affected.length} note(s). ${previousOwner} stops owning them and ` +
              `${
                stillWritable
                  ? 'keeps read and write access through the shared destination.'
                  : stillReadable
                    ? 'is left with read access only, where owning them allowed writing.'
                    : 'is left with no access at all: the destination is not shared back.'
              } They cannot undo this themselves: once they stop owning the notes they ` +
              `cannot move them back, and whether they keep seeing them is from then on the ` +
              `new owner's decision — revoking the share would leave them with nothing. Put ` +
              `this to the user and call again with userConfirmedOwnershipTransfer: true only ` +
              `if they agree.`,
          });
        }
        const result = await notes.moveAcrossVaults({
          fromOwnerId: previousOwner,
          fromPath: from,
          toOwnerId,
          toPath: to,
          viewerId: requireUserId(),
          viewerScopes: (await sharing.listSharedRoots(requireUserId())).map((r) => ({
            ownerId: r.ownerId,
            folderPath: r.folderPath,
          })),
        });

        return JSON_TEXT({
          moved: true,
          ...result,
          ownership: {
            previousOwnerId: previousOwner,
            newOwnerId: toOwnerId,
            previousOwnerAccess,
            tellTheUser: `These notes now belong to ${toOwnerId}; ${previousOwner} no longer owns them and ${
              stillWritable
                ? 'can still read and write them through the shared destination.'
                : stillReadable
                  ? 'can now only read them through the shared destination, where owning them ' +
                    'allowed writing.'
                  : 'can no longer see them at all, because the destination is not shared back ' +
                    'with them. Say this plainly rather than reporting the move as a success.'
            }`,
          },
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete a note, attachment, or folder',
      description:
        'Delete a path. Folders require `recursive: true` unless empty. Does NOT rewrite wikilinks — links pointing here become unresolved.',
      inputSchema: {
        path: field().min(1),
        recursive: z.boolean().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, recursive, ownerId }) => {
      try {
        await assertWrite(path, ownerId);
        // What is gone, so the assistant can report the blast radius. This
        // used to answer `undefined`, which the client rejected as an invalid
        // result after the delete had already happened.
        return JSON_TEXT(await notes.remove(ownerOf(ownerId), path, { recursive }));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );
}
