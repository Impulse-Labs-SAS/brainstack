---
name: brainstack
description: Use BrainStack as the shared second brain — search before answering, ask before writing, classify on save, follow the folder and wikilink conventions.
---

# BrainStack — Instructions for AI Assistants

You are connected to a **BrainStack** server: a shared second brain for humans and AI assistants. The same vault is read and written by multiple assistants and by humans through a web app. Your job is to use it well so the human never has to repeat themselves and the brain stays coherent over time.

You interact with BrainStack via these MCP tools:

**Read:**

- `search_brain(query, limit?, scope?)` — `scope`: `all` (default), `mine`, or `shared`
- `get_note(path, ownerId?)`
- `list_notes(folder?, tag?, facetKey?, facetValue?, status?, limit?, ownerId?)`
- `list_tree(path?, depth?, ownerId?)` — hierarchical view of the vault, folders first
- `list_links(path, ownerId?)` — backlinks for a path
- `list_outbound_links(path, ownerId?)` — what a path links to or embeds; the mirror of `list_links`
- `list_related(path, limit?)` — notes related by a shared tag or facet, ranked by rarity; **own vault only** (no `ownerId`)
- `list_facets(path?, key?, ownerId?)` — a note's frontmatter facets (`path` given), or every `(key, value)` in use (`path` omitted)
- `list_decisions(folder?, limit?, ownerId?)` — notes tagged `decisión`/`decision` or with frontmatter `status: decidido` (via facets)
- `list_shared_with_me()` — folders other people shared with you (`ownerId`, permission per row)
- `get_brainstack_guide()` — returns this document at runtime

**Write / structure (require user approval — see below):**

- `create_note(path, content, frontmatter?, ownerId?)` — returns `{ path, affectedMocs }`
- `update_note(path, content, ownerId?)`
- `create_folder(path, ownerId?)`
- `move(from, to, ownerId?)` — wikilinks pointing at the moved path(s) are rewritten automatically across the vault, including aliases, sections, and attachment embeds. Returns `{ path, affectedMocs }`
- `move_to_owner(from, to, toOwnerId, fromOwnerId?, userConfirmedOwnershipTransfer?)` — **transfers ownership** across vaults; without `userConfirmedOwnershipTransfer: true` it moves nothing and returns a cost summary. See **Shared folders**.
- `delete(path, recursive?, ownerId?)` — returns `{ deleted: [...] }` so you can confirm the blast radius. Does **not** rewrite wikilinks in note bodies.

**Sharing (require user approval — see below; hosted only — not registered in self-host):**

- `share_folder(path, email, permission?)` — grant read or write on a folder and everything under it
- `unshare(path, email)` — revoke that person's access
- `list_shares(path?)` — folders you have shared and who can read each one

## When to use BrainStack

Trigger BrainStack whenever the user's question or action involves their own knowledge, projects, decisions, or people. Examples:

- "What did we decide about pricing for Zuno?"
- "Tell me what's open in BRUTUS."
- "Remind me what Pablo said about the August retro."
- "Save this idea."
- The user references a wikilink, tag, or folder by name.

Don't use BrainStack for generic knowledge questions or for things the user didn't ask the brain about. When in doubt, ask before searching.

## Querying the brain (read)

Always verify with the brain before claiming a fact about the user's domain. Never invent content.

- `search_brain(query, scope?)` — primary tool. Full-text search with snippets and a path for every hit.
  Default `scope` is **`all`** (own notes and folders shared with the user). Use `scope="mine"` only
  when the user asked for their own vault specifically, or `scope="shared"` for shared-only.
- `get_note(path)` — when you already know the path (from a wikilink, a previous search, or a list).
  A path the user does not have in their own vault but that falls under a folder shared with them
  resolves to that folder, so a shared note reads back without an `ownerId`.
- `list_notes(folder=..., tag=..., facetKey=..., facetValue=..., status=...)` — structured navigation, faster than search when scoped. Use `facetKey` + `facetValue` together to filter by a frontmatter facet (same pattern as `tag`).
- `list_tree(path?)` — when you need to understand the vault's shape (where things live, what top-levels exist). **Always start here when deciding where to save something.**
- `list_links(path)` — backlinks to a note or attachment. Useful for "what referenced this PDF?" or "what links back here?".
- `list_outbound_links(path)` — what a note itself links to or embeds.
- `list_related(path)` — other notes sharing a tag or facet ( **affinity**, not a wikilink). Own vault only; does not take `ownerId`.
- `list_facets(path?, key?)` — a note's own facets, or (omit `path`) every value in use for browsing/autocomplete.
- `list_decisions(folder?)` — decisions only, sorted by recency. Useful when the user asks "what have we decided about X".
- `list_shared_with_me()` — folders other people shared with the user. See
  **Shared folders** below: these live in someone else's vault and every tool
  above takes an `ownerId` to reach them.

Rules:

- Cite the source path of every fact you pulled from the brain (e.g. `Zuno/decisiones/pricing-tiered.md`). Paths give the user something to click on.
- If a tool returns nothing, say so. Don't fabricate a plausible-looking path or summary.
- If a query is scoped to a folder by intent ("what's in BRUTUS?"), prefer `list_notes(folder="BRUTUS")` over `search_brain`.

## Shared folders

A vault is one person's. Someone can share a folder with the user, and that
folder is **not** part of their vault: it lives in the owner's, and every tool
reaches it by naming that owner.

- `list_shared_with_me()` — what has been shared with the user, and with what
  permission. Each row carries the `ownerId` you need below.
- Every note tool takes an optional **`ownerId`**. Omit it for the user's own
  notes. Pass it to reach a shared folder — `get_note(ownerId=..., path=...)`,
  `list_tree(ownerId=..., path=...)`, `create_note(ownerId=..., ...)`.
- Paths inside a shared folder are relative to **the owner's** root, exactly as
  `list_shared_with_me` prints them. Never prefix them with anything.
- `search_brain` searches them by default (`scope="all"`). A hit whose `ownerId`
  differs from the user's is in somebody else's vault: pass that same `ownerId`
  to `get_note` — or just the path, which resolves there too.
- **Reads resolve, writes ask.** A path the user does not have that falls under a
  shared folder is read from that folder. The same path on a _write_ is refused
  until you name the owner, because a write that guessed wrong would leave a
  private copy nobody else can see. So never conclude a note is missing from one
  read: if a path came from the user, it is likely theirs to see.

Permission is per grant: `read` lets you read, `write` also lets you create and
edit inside that folder. A note you create there belongs to the folder's owner,
which is what keeps it visible to everyone the folder is shared with.

**The trap worth naming.** Writing a path without `ownerId` always means the
user's own vault. So `create_note(path="Impulse Labs/nota.md")` does _not_ write
to a shared folder called "Impulse Labs" — it makes a private folder of the same
name that nobody else can see. The server now refuses that call rather than
doing it silently, and tells you which `ownerId` to pass. If you get that error,
pass the id; do not rename the note to get around it.

When the user says "put this in <shared folder>", check `list_shared_with_me`
for the owner before writing, not after.

### Moving something into a shared folder

`move` stays inside one vault. To take a note or folder from the user's own
notes into a folder somebody shared — the usual case being something written
in the wrong place before there was write access — use **`move_to_owner`**,
with `toOwnerId` set to the folder's owner. It needs write access at both ends.

Crossing costs links, and the tool says so rather than hiding it: a wikilink
cannot name a vault, so `[[personal/idea]]` inside a note that just left the
user's vault has nothing to point at any more. The answer lists
`linksLeftDangling` (what moved, now pointing at what stayed) and
`linksNowBroken` (what stayed, now pointing at what moved). Report those to the
user — they are the part of the move that needs a human decision.

## Sharing folders

Sharing hands another person access to everything under a folder, including notes created later. It reaches a real person by email, so it is never a routine action. **`share_folder`**, **`unshare`**, and **`list_shares`** are available on hosted BrainStack only — they are not registered when the server runs in self-host mode.

- **Always ask first, and echo the exact folder and email back** before calling `share_folder`. "Share `Zuno/` with pablo@example.com — that covers every note under it, now and in the future. Confirm?"
- `permission` is `read` (default) or `write`. **`write`** lets them create and edit inside the folder (they pass your `ownerId` on writes). Re-sharing with the same person **updates** their permission rather than adding a second grant.
- Someone with a BrainStack account gets access immediately. Anyone else receives an email invitation that **expires in 7 days**.
- `unshare(path, email)` revokes access and kills pending invitations that would hand it straight back. It is a no-op when the person had no access.
- Use `list_shares()` before proposing a change, so the user sees the current state rather than your assumption of it.
- Never propose sharing a folder the user has not mentioned, and never widen an existing share to a broader folder on your own initiative.

## Saving to the brain (write) — ask first

You never write to the brain without explicit user consent. **Every** write/structure/sharing tool requires approval: `create_note`, `update_note`, `create_folder`, `move`, `move_to_owner`, `delete`, `share_folder`, `unshare`.

This holds just as much for a folder somebody shared with write permission — more so, because there the user is not the only one who will see it.

The "ask before save" pattern:

1. **Detect a moment worth saving.** Typical triggers: the user took a decision, discussed a new idea, cited a useful source, or wrapped a meaningful conversation.
2. **Decide where it goes** using the flow below.
3. **Propose concretely.** Tell the user:
   - What you'd save.
   - Where (`<folder>/<filename>.md`).
   - What frontmatter and wikilinks you'd attach.
4. **Wait for an explicit yes / no / "tweak this first".**
5. **Execute** the matching MCP tool.
6. **Confirm where it landed.** "Saved to `Zuno/decisiones/pricing-tiered.md`, tagged `decisión`, links to [[Pablo]]."

The only exception: if the user already said "save this to `<path>`" with a destination, skip the proposal and execute. **Never write without asking** for any move, delete, rename, or anything touching more than one note at a time.

`delete` does **not** rewrite wikilinks — every link in note bodies pointing at a deleted path becomes unresolved, and index rows in `links` that targeted that path flip to `unresolved`. Before proposing a delete, run `list_links(path)` and tell the user what will break. Folders need `recursive: true` unless already empty; name the blast radius in the proposal, not after the fact.

## Where does this new note go?

There is no inbox or quick-capture bucket. Every saved note gets classified at save time. The flow is **always**:

1. **Call `list_tree`** (no arguments or scoped to a likely top-level) **and `list_shared_with_me`** to see what exists right now. Do not assume folder structure from memory or from earlier in the conversation — the vault may have changed. `list_tree` with no arguments shows the user's own vault only: a shared folder is not in it, and reporting "the vault has one note" after looking at nothing else is how a note that exists gets declared missing.

2. **Does the note clearly belong inside an existing top-level folder?**
   - **Yes** → propose `<top-level>/<subfolder-by-type>/<filename>.md`. Type subfolders are typically `decisiones/`, `ideas/`, `reuniones/`, `referencias/`. If the right type subfolder already exists, use it. If it doesn't but at least 3 sibling notes would fit, propose creating it. Otherwise put the note at the root of the top-level.
   - **No** → ask the user with 2–3 concrete alternatives. Format:
     > "Where should this live? Some options:
     >
     > 1. `<existing-top-level>/<new-or-existing-subfolder>/` (recommended — fits with X)
     > 2. `<another-existing-top-level>/`
     > 3. A new top-level `<proposed-name>/` (architectural change)
     >
     > Default: option 1."

3. **Never default silently to a generic bucket.** A note without a clear home is a question for the user, not a TODO for later.

Creating a new top-level is a deliberate architectural change. Don't do it unilaterally — make it option 3 with a name suggestion and a one-line rationale.

## MOC maintenance (the `_<Folder>.md` index notes)

Every content folder has an index note named `_<FolderName>.md` (underscore so it sorts first). The MOC has:

- H1 with the folder name.
- 1–2 lines describing the folder.
- A `## Notas` section linking each note inside.
- A `## Subcarpetas` section linking each sub-MOC.

**`create_note` and `move` return `affectedMocs`: the list of `_<Folder>.md` files in the relevant parent folders that already exist on disk.** Use that list directly — don't recompute paths and don't stat folders. Empty array means nothing to update.

Always:

1. When you create a note, add a wikilink to it in the parent MOC's `## Notas`. The MOC path is in `affectedMocs[0]` if one exists; if `affectedMocs` is empty, the parent has no MOC yet — either skip (early-vault state) or propose creating one.
2. When you create a subfolder, create its MOC and link it from the parent MOC's `## Subcarpetas`.
3. When you `move` a note, the wikilink rewrite is handled by the server. The MOCs themselves aren't touched — `affectedMocs` lists the candidates (source-parent MOC and dest-parent MOC). Read each, remove the moved note from the old one's `## Notas`, add it to the new one's. Propose this update as part of the move.
4. When you `delete` a note, remove its wikilink from the parent MOC's `## Notas` in the same operation. Nothing does this for you.
5. Add a `## Refs` section at the bottom of every new note linking back to its MOC.

The note-create step and its parent-MOC link are part of one save operation — no extra permission required. MOC edits triggered by a move or a delete are part of that plan and need the same approval as the operation itself.

## Wikilink discipline

Before you write `[[X]]` in a new note, resolve `X`:

1. Look it up with `search_brain("X")` or try `get_note("X")`.
2. If a single match exists → use the exact path.
3. If multiple matches exist → ask the user which one they meant.
4. If no match exists → either (a) propose creating the target note, or (b) leave the link wishful and tell the user it's currently unresolved.

Never silently create wikilinks to notes that don't exist. The user must know there's a dangling reference.

Supported forms include `[[Note#Section]]` — the section is indexed and should resolve in the web app; use the full path from search when linking across folders.

When exploring how a note sits in the vault:

- `list_links(path)` — who links **to** this path (backlinks).
- `list_outbound_links(path)` — what this path links to or embeds (outbound).
- `list_related(path)` — notes that share a tag or facet (**not** the same as a wikilink). The full graph at `/graph` and explicit link tools only reflect rows in the `links` table.

When you `move` a note or folder, the server rewrites every `[[X]]`, `[[X|alias]]`, `![[X]]`, and `![[Attachments/.../file.pdf]]` that pointed at the moved path(s). Wikilinks inside fenced code blocks or inline code are intentionally left untouched. You don't need to rewrite anything yourself. `delete` gives you none of this — see **Saving to the brain**.

## Attachments

Binaries (PDFs, images, audio) live under `Attachments/YYYY/MM/` and are referenced from notes with `![[Attachments/2026/05/diagram.png]]`.

**Uploading binaries is a web-app action** — drag the file onto the file tree in the web app, then embed the resulting path in the note body. There is no upload tool over MCP.

`list_links(path)` works on attachments too, so you can answer "what references this PDF?" without reading the bytes. `move` rewrites attachment embeds that pointed at what moved; `delete` does not rewrite links in note bodies.

## Frontmatter conventions

Every new note gets minimal frontmatter:

```yaml
---
created: YYYY-MM-DD # always, ISO format
tags: [...] # array, hierarchical with /
status: ... # optional: idea | en-progreso | decidido | archivado
owner: ... # optional
title: ... # optional, overrides H1 / filename for the title
---
```

Rules:

- `created` is always present.
- `tags` is always an array, never a single string. Hierarchical tags use `/`: `proyecto/zuno`, `tipo/decisión`.
- For decisions: tag it `decisión` AND set `status: decidido`. `list_decisions` matches either, but using both is the convention and surfaces the note in every view.
- Don't invent decorative fields. If `status` adds no information, leave it out.

## Tag conventions

- Lowercase, hyphen-joined: `pricing-tiered`, not `PricingTiered`.
- Hierarchical when useful: `proyecto/zuno`, `tipo/decisión`, `persona/pablo`.
- Reuse existing tags before inventing new ones. `list_notes(tag="…")`, `list_notes(facetKey=…, facetValue=…)`, and `search_brain` can show what's in use.
- ~5 tags max per note. More is noise.

## Facets — structured frontmatter beyond tags

Any frontmatter field other than `tags` becomes a queryable **facet**, automatically — there is nothing to register first. An array gives one facet value per element; a scalar gives one. Use this for structured, typed metadata that a plain tag would flatten:

```yaml
---
tags: [proyecto/zuno]
technologies: [nextjs, drizzle]
resources:
  - { value: 'RFC 9111', url: 'https://...' }
status: decidido
---
```

- Reuse existing facet keys and values before inventing new ones — `list_facets(key="technologies")` shows what's in use, same idea as checking existing tags.
- Prefer a facet over a tag when the metadata has a name _and_ a value that's naturally worth filtering on separately (`technologies: nextjs` rather than a tag `tech/nextjs`) — both work, but a facet keeps `nextjs` queryable as a value under the `technologies` key rather than a string to parse.
- `list_related(path)` uses both tags and facets to find related notes — a note doesn't need explicit wikilinks to show up there, just a shared tag or facet value.

## Markdown syntax (Obsidian-flavored)

- Wikilinks: `[[Note]]`, `[[Note#Section]]`, `[[Note|display text]]`.
- Embeds: `![[Note]]`, `![[Attachments/2026/05/img.png]]`, `![[doc.pdf]]`.
- Callouts: `> [!note] Title` / `> [!warning]` / `> [!decision] Title`.
- Code fences using triple backticks. Anything inside a code fence is ignored by the indexer and by the wikilink rewriter — don't rely on it for tags or wikilinks.

## Folder structure

BrainStack follows a PARA + Johnny-Decimal-lite layout:

- Top-level semantic folders (defined by the user) such as `Zuno/`, `BRUTUS/`, `General/`.
- Subfolders inside each top-level group items by type: `decisiones/`, `ideas/`, `reuniones/`, `referencias/`.
- `Attachments/` — all binaries, organised by date (`Attachments/YYYY/MM/`).
- `Templates/` — note templates, optional.
- `06-Archivo/` (or equivalent) — inactive material, preserves hierarchy.

Create a new subfolder only when **both** are true: (1) at least three existing notes already fit, and (2) the folder name is reusable and clear. Otherwise put the note at the root of its top-level.

## Anti-patterns

- Don't invent paths, notes, or links you haven't verified.
- Don't write to the brain silently.
- Don't restructure folders or move multiple notes without explicit permission.
- Don't delete without showing the backlinks it will break (`list_links`).
- Don't share a folder without the user naming both the folder and the person.
- Don't pile up tags or frontmatter "just in case".
- Don't default to a generic bucket when classification is uncertain — ask.
- Don't use English vs Spanish inconsistently within the same brain — match the user's language for content; metadata (tags, status) can stay in either as long as you're consistent with what's already in use.

## When in doubt

Ask. Saving to the wrong place costs more than asking one extra question.
