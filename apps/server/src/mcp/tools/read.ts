// Tools that read a vault: search, notes, links, facets, the tree, gather_context and place_note.

import { z } from 'zod';

import { field } from '../../config/limits.js';
import { listBacklinksSafely } from '../../lib/backlinks.js';
import { AppError, describeError, toAppError } from '../../lib/errors.js';

import {
  gatherContext,
  placeNoteInVault,
  searchBrain,
  MAX_DEPTH,
  MAX_MAX_CHARS,
  MAX_TERMS,
  MAX_TEXT_CHARS,
} from '../../services/gatherContext.js';
import { MAX_TREE_DEPTH } from '../../services/NoteService.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JSON_TEXT, MAX_NOTES_READ, MAX_NOTES_READ_CHARS } from '../shared.js';
import type { McpToolContext } from '../context.js';

export function registerReadTools(server: McpServer, ctx: McpToolContext): void {
  const {
    notes,
    search,
    sharing,
    crossOwner,
    crawls,
    logger,
    principal,
    toMcpError,
    requireUserId,
    readOwner,
    ownership,
    sizeNotice,
    OWNER_ARG,
  } = ctx;

  server.registerTool(
    'search_brain',
    {
      title: 'Search the brain',
      description:
        "Full-text search over notes in BrainStack, ranked the way gather_context ranks them: a note the query names by title first, then the matches, those outside the named note's folder lower. `scope` decides what is searched: `all` (default) the user's own notes and the folders shared with them, `mine` only their own, `shared` only the shared ones. Returns up to `limit` hits (default 10, at most 50), each with a `snippet`, a `reason`, and the `ownerId` of the vault it lives in.",
      inputSchema: {
        query: field().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        scope: z.enum(['mine', 'shared', 'all']).optional(),
      },
    },
    async ({ query, limit, scope }) => {
      try {
        const userId = requireUserId();
        // Everything the caller may read, unless they narrow it. Defaulting to
        // `mine` meant a client that never passed a scope could not see a
        // shared folder at all, and answered "no existe" for notes sitting in
        // one — the failure looked like missing data rather than a narrow
        // search.
        const effectiveScope = scope ?? 'all';
        const sharedScopes =
          effectiveScope !== 'mine'
            ? (await sharing.listSharedRoots(userId)).map((r) => ({
                ownerId: r.ownerId,
                folderPath: r.folderPath,
              }))
            : [];
        // The same engine as gather_context, so the two never disagree about
        // which note comes first.
        const hits = await searchBrain(
          { notes, search },
          userId,
          { query, limit, scope: effectiveScope },
          sharedScopes,
        );
        logger.debug({ query, hits: hits.length, scope: effectiveScope }, 'search_brain');
        return JSON_TEXT(hits);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Read a note',
      description: 'Read a single note from the brain by its path (relative to NOTES_DIR).',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        const note = await notes.get(owner, path);
        // Whose words these are comes before the words: a shared note can be
        // written by anyone with access to the folder, and reads back with the
        // same weight as the user's own unless the assistant is told first.
        return JSON_TEXT({ ...ownership(owner), ...note, ...sizeNotice(note.body) });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'get_notes',
    {
      title: 'Read several notes',
      description: `Read up to ${MAX_NOTES_READ} notes in one call — the ones gather_context listed in \`leftOut\` or cut short, for example — instead of one get_note each. Each entry takes a \`path\` and, for a folder shared with the user, its \`ownerId\`. A note that cannot be read comes back with an \`error\` in its place; the others are read regardless. Bodies share a budget of ${MAX_NOTES_READ_CHARS} characters: a note cut to fit says \`truncated: true\` — open it alone with get_note.`,
      inputSchema: {
        notes: z
          .array(z.object({ path: field().min(1), ownerId: OWNER_ARG }))
          .min(1)
          .max(MAX_NOTES_READ),
      },
    },
    async ({ notes: wanted }) => {
      try {
        const read = await Promise.all(
          wanted.map(async ({ path, ownerId }) => {
            try {
              const owner = await readOwner(path, ownerId);
              const note = await notes.get(owner, path);
              return { ...ownership(owner), ...note, ...sizeNotice(note.body) };
            } catch (err) {
              if (!toAppError(err)) logger.error({ err }, 'get_notes read failed');
              return { path, ...(ownerId ? { ownerId } : {}), error: describeError(err) };
            }
          }),
        );
        let room = MAX_NOTES_READ_CHARS;
        return JSON_TEXT(
          read.map((note) => {
            if (!('body' in note)) return note;
            if (note.body.length <= room) {
              room -= note.body.length;
              return note;
            }
            const body = note.body.slice(0, room);
            room = 0;
            return { ...note, body, truncated: true };
          }),
        );
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List notes in BrainStack. Filter by folder prefix, tag, a frontmatter facet (facetKey + facetValue — see list_facets), or frontmatter status. Sorted by mtime desc.',
      inputSchema: {
        folder: field().optional(),
        tag: field().optional(),
        facetKey: field().optional(),
        facetValue: field().optional(),
        status: field().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ ownerId, facetKey, facetValue, ...args }) => {
      try {
        const owner = await readOwner(args.folder, ownerId);
        const facet = facetKey && facetValue ? { key: facetKey, value: facetValue } : undefined;
        const rows = await notes.list(owner, { ...args, ...(facet ? { facet } : {}) });
        return JSON_TEXT(
          owner === requireUserId() ? rows : rows.map((r) => ({ ownerId: owner, ...r })),
        );
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_tree',
    {
      title: 'List the vault tree',
      description:
        'Return a hierarchical view of the vault. Scope to a subfolder with `path`. ' +
        'Cap depth with `depth` (default 4). Folders are listed before files; both alphabetical.',
      inputSchema: {
        path: field().optional(),
        depth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, depth, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        const tree = await notes.listTree(owner, path, depth);
        return JSON_TEXT(owner === requireUserId() ? tree : { ownerId: owner, ...tree });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_decisions',
    {
      title: 'List decisions',
      description:
        'List every note flagged as a decision (tag `decisión`/`decision` or frontmatter `status: decidido`). ' +
        'Optional folder scope.',
      inputSchema: {
        folder: field().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ ownerId, ...args }) => {
      try {
        const owner = await readOwner(args.folder, ownerId);
        const rows = await notes.listDecisions(owner, args);
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_links',
    {
      title: 'List backlinks',
      description: 'List every note that links to or embeds the given path (note or attachment).',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        // Not `notes.listLinks` directly: that call is owner-scoped, not
        // permission-aware, and would name a backlink's source even when it
        // sits in a folder this caller was never granted.
        const rows = await listBacklinksSafely(requireUserId(), owner, path, {
          notes,
          crossOwner,
        });
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_outbound_links',
    {
      title: 'List outbound links',
      description:
        'List every note or attachment the given path links to or embeds — the mirror of list_links.',
      inputSchema: { path: field().min(1), ownerId: OWNER_ARG },
    },
    async ({ path, ownerId }) => {
      try {
        const owner = await readOwner(path, ownerId);
        const userId = requireUserId();
        // Same masking `linksForOwner` already applies to a shared note: an
        // unreadable target comes back unresolved rather than naming a path
        // outside the grant.
        const rows =
          userId === owner
            ? await notes.listOutboundLinks(owner, path)
            : await crossOwner.linksForOwner(userId, owner, path);
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_related',
    {
      title: 'List related notes',
      description:
        'Notes related to the given path by a shared tag or frontmatter facet (e.g. both using `technologies: nextjs`), ranked by how rare the shared signal is — sharing an uncommon tag outranks sharing a technology half the vault uses. Own vault only; does not take `ownerId`.',
      inputSchema: { path: field().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ path, limit }) => {
      try {
        const userId = requireUserId();
        const rows = await notes.listRelated(userId, path, { limit });
        return JSON_TEXT(rows);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_unlinked_mentions',
    {
      title: 'List unlinked mentions',
      description:
        "Where a note is named without a wikilink, both ways: `incoming` lists other notes whose text says this note's title or an alias; `outgoing` lists notes whose title this note's text says. Each row has the other note's path, the text as written, how many times, and a snippet. Read-only: to link them, propose the edit to the user and write it with `update_note` once they approve, replacing the text with `[[path|text as written]]`. Own vault only; does not take `ownerId`.",
      inputSchema: { path: field().min(1) },
    },
    async ({ path }) => {
      try {
        const userId = requireUserId();
        return JSON_TEXT(await notes.unlinkedMentions(userId, path));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'gather_context',
    {
      title: 'Gather context for a question or a prompt',
      description:
        "Start here for any question or task about the user's notes: one call instead of search_brain, list_notes and get_note one by one. Pass the user's message as `text` (and, if you like, the vague phrases in it as `terms`). Returns `notes`, ranked: the notes the text names by title, alias or [[link]]; the best full-text hits for the question itself and for each term; and the notes those link to or from (`depth` hops, default 1) — decisions weigh extra. Each note comes with `reason`, `isDecision`, its `checksum` and its body in `excerpt`, whole when it fits `maxChars`; a `truncated` one also lists its `sections` (every heading of the whole note), and one marked `tooLong` is past the size an assistant may write — propose splitting it into linked notes before adding to it, never condensing it. That is enough to change a note with edit_note or apply_changes without opening it — pass the `checksum` as `expectedChecksum`. Open a note with get_note (several with get_notes) only when `truncated` is true and you need the rest. `leftOut` names the strongest notes that did not fit (path, title, reason, no body): open one with get_note if the answer needs it. Returns `unresolved`: terms that matched nothing, and titles several notes share (with `candidates`) — never guess those, ask the user. Reads the user's own vault and the folders other people shared with them: a note in a shared folder comes with its `ownerId` — pass it to get_note with the same `path`. Writes no note; the call is kept in the user's own crawl history, which they can replay in the web app.",
      inputSchema: {
        text: z.string().min(1).max(MAX_TEXT_CHARS),
        terms: z.array(z.string().min(1).max(200)).max(MAX_TERMS).optional(),
        depth: z.number().int().min(0).max(MAX_DEPTH).optional(),
        maxChars: z.number().int().min(500).max(MAX_MAX_CHARS).optional(),
      },
    },
    async (input) => {
      try {
        const userId = requireUserId();
        const sharedScopes = (await sharing.listSharedRoots(userId)).map((r) => ({
          ownerId: r.ownerId,
          folderPath: r.folderPath,
        }));
        const result = await gatherContext({ notes, search }, userId, input, sharedScopes);
        await crawls.record(userId, {
          source: 'assistant',
          clientRef: principal?.clientRef ?? null,
          text: input.text,
          result,
        });
        return JSON_TEXT(result);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'place_note',
    {
      title: 'Find where a new note goes',
      description:
        "Before creating a note: where it belongs, whether one like it already exists, and what it should link to — one call instead of list_tree, search_brain and opening indexes by hand. Pass the `title` it would have and its `text` (or a summary). Returns `duplicates` (notes already called that: propose adding to one of them instead), `folder` (the folder the most related notes live in, with `reason` and its `index` note when it has one — link the new note from it in the same apply_changes) and up to two `alternatives`, and `links` (the notes the text names, then the most related; a wikilink cannot cross into another owner's vault). A folder or note in a folder shared with the user comes with its `ownerId`, and a shared folder says whether the user may write there (`writable`). Writes nothing: put the proposal to the user, as for any write. Kept in the user's crawl history like gather_context.",
      inputSchema: {
        title: field().min(1),
        text: z.string().max(MAX_TEXT_CHARS).optional(),
      },
    },
    async ({ title, text }) => {
      try {
        const userId = requireUserId();
        const sharedScopes = (await sharing.listSharedRoots(userId)).map((r) => ({
          ownerId: r.ownerId,
          folderPath: r.folderPath,
        }));
        const { crawl, ...proposal } = await placeNoteInVault(
          { notes, search },
          userId,
          { title, ...(text ? { text } : {}) },
          sharedScopes,
        );
        await crawls.record(userId, {
          source: 'assistant',
          clientRef: principal?.clientRef ?? null,
          text: `Where does “${title}” go?`,
          result: crawl,
        });
        // A folder shared for reading only is still where related notes are,
        // but not somewhere the user can save: say so before they are asked.
        const writable = async <T extends { folder: string; ownerId?: string }>(f: T) =>
          f.ownerId ? { ...f, writable: await sharing.canWrite(userId, f.ownerId, f.folder) } : f;
        return JSON_TEXT({
          ...proposal,
          folder: proposal.folder ? await writable(proposal.folder) : null,
          alternatives: await Promise.all(proposal.alternatives.map(writable)),
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'list_facets',
    {
      title: 'List facets',
      description:
        "Structured frontmatter metadata other than tags — e.g. `technologies: [nextjs]` or `status: decidido`. Pass `path` for one note's facets (with `ownerId` for a note in a shared folder); omit it (optionally with `key`) to browse every (key, value) pair in use in your own vault, with counts. Browsing never takes another owner's `ownerId`.",
      inputSchema: {
        path: field().optional(),
        key: field().optional(),
        ownerId: OWNER_ARG,
      },
    },
    async ({ path, key, ownerId }) => {
      try {
        if (path) {
          const owner = await readOwner(path, ownerId);
          return JSON_TEXT(await notes.listFacetsForNote(owner, path));
        }
        // Browsing aggregates a whole vault, and a grant covers one folder of
        // it, so only your own vault can be browsed.
        const userId = requireUserId();
        if (ownerId !== undefined && ownerId !== userId) {
          throw new AppError(
            'browsing facets covers your own vault only; pass `path` to read the facets of one note in a shared folder',
            'FORBIDDEN',
            403,
          );
        }
        return JSON_TEXT(await notes.listFacets(userId, key));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );
}
