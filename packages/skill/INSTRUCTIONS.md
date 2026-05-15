---
name: brainstack
description: Use BrainStack as the shared second brain — search before answering, ask before writing, follow the folder and wikilink conventions.
---

# BrainStack — Instructions for AI Assistants

You are connected to a **BrainStack** server: a shared second brain for humans and AI assistants. The same brain is read and written by multiple assistants and by humans through a web app. Your job is to use it well so the human never has to repeat themselves and the brain stays coherent over time.

You interact with BrainStack via these MCP tools:

- `search_brain(query, limit?)`
- `get_note(path)`
- `list_notes(folder?, tag?, status?, limit?)`
- `list_links(path)` — backlinks for a path
- `add_to_inbox(content, title?)`
- `create_note(path, content, frontmatter?)`
- `update_note(path, content)`
- `get_brainstack_guide()` — returns this document at runtime

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

- `search_brain(query)` — primary tool. Full-text search with snippets and a path for every hit.
- `get_note(path)` — when you already know the path (from a wikilink, a previous search, or a list).
- `list_notes(folder=..., tag=..., status=...)` — structured navigation, faster than search when scoped.
- `list_links(path)` — backlinks to a note or attachment. Useful for "what referenced this PDF?" or "what links back here?".

Rules:

- Cite the source path of every fact you pulled from the brain (e.g. `Zuno/decisiones/pricing-tiered.md`). Paths give the user something to click on.
- If a tool returns nothing, say so. Don't fabricate a plausible-looking path or summary.
- If a query is scoped to a folder by intent ("what's in BRUTUS?"), prefer `list_notes(folder="BRUTUS")` over `search_brain`.

## Saving to the brain (write) — ask first

You never write to the brain without explicit user consent. `create_note`, `update_note`, and `add_to_inbox` are write actions; they require approval.

The "ask before save" pattern:

1. **Detect a moment worth saving.** Typical triggers: the user took a decision, discussed a new idea, cited a useful source, or wrapped a meaningful conversation.
2. **Propose concretely.** Tell the user:
   - What you'd save.
   - Where (`<folder>/<filename>.md` or "Inbox").
   - What frontmatter and wikilinks you'd attach.
3. **Wait for an explicit yes / no / "tweak this first".**
4. **Execute** the matching MCP tool.
5. **Confirm where it landed.** "Saved to `Zuno/decisiones/pricing-tiered.md`, tagged `decisión`, links to [[Pablo]]."

Exceptions where you may write without re-asking:

- The user already said "save this" explicitly.
- The user declared "quick capture mode" — everything goes to `Inbox/` without re-asking.
- Updating the parent MOC after creating a note is part of the same save operation (see "MOC maintenance" below).

**Never write without asking** for: any delete/move/rename; any action touching more than one note at a time; any reorganisation of folders.

## Folder structure

BrainStack follows a PARA + Johnny-Decimal-lite layout:

- `Inbox/` — uncategorised capture. Default destination when in doubt.
- Top-level semantic folders (defined by the user) such as `Zuno/`, `BRUTUS/`, `General/`.
- Subfolders inside each top-level group items by type: `decisiones/`, `ideas/`, `reuniones/`, `referencias/`.
- `Attachments/` — all binaries, organised by date (`Attachments/YYYY/MM/`).
- `Templates/` — note templates, optional.
- `06-Archivo/` (or equivalent) — inactive material, preserves hierarchy.

Where does this new note go?

```
Did the user state a destination? → Use it. Don't debate.
Otherwise: does the note clearly belong in an existing top-level?
   yes → propose <top-level>/<subfolder-by-type>/. Example: a Zuno decision goes to Zuno/decisiones/.
   no  → default to Inbox/. Classify later beats paralysing now.
```

Create a new subfolder only when **both** are true: (1) at least three existing notes already fit, and (2) the folder name is reusable and clear. Otherwise put the note at the root of its top-level.

Creating a new top-level is a deliberate architectural change. Don't do it unilaterally — propose Inbox vs. new top-level and let the user choose. Default to Inbox.

## MOC maintenance (the `_<Folder>.md` index notes)

Every content folder has an index note named `_<FolderName>.md` (underscore so it sorts first). The MOC has:

- H1 with the folder name.
- 1–2 lines describing the folder.
- A `## Notas` section linking each note inside.
- A `## Subcarpetas` section linking each sub-MOC.

Always:

1. When you create a note, add a wikilink to it in the parent MOC's `## Notas`.
2. When you create a subfolder, create its MOC and link it from the parent MOC's `## Subcarpetas`.
3. When you move a note, remove it from the old MOC and add it to the new one.
4. Add a `## Refs` section at the bottom of every new note linking back to its MOC.

These steps are part of "creating a note" — no extra permission required.

## Wikilink discipline

Before you write `[[X]]` in a new note, resolve `X`:

1. Look it up with `search_brain("X")` or try `get_note("X")`.
2. If a single match exists → use the exact path.
3. If multiple matches exist → ask the user which one they meant.
4. If no match exists → either (a) propose creating the target note, or (b) leave the link wishful and tell the user it's currently unresolved.

Never silently create wikilinks to notes that don't exist. The user must know there's a dangling reference.

## Frontmatter conventions

Every new note gets minimal frontmatter:

```yaml
---
created: YYYY-MM-DD       # always, ISO format
tags: [...]               # array, hierarchical with /
status: ...               # optional: idea | en-progreso | decidido | archivado
owner: ...                # optional
title: ...                # optional, overrides H1 / filename for the title
---
```

Rules:

- `created` is always present.
- `tags` is always an array, never a single string. Hierarchical tags use `/`: `proyecto/zuno`, `tipo/decisión`.
- Don't invent decorative fields. If `status` adds no information, leave it out.

## Tag conventions

- Lowercase, hyphen-joined: `pricing-tiered`, not `PricingTiered`.
- Hierarchical when useful: `proyecto/zuno`, `tipo/decisión`, `persona/pablo`.
- Reuse existing tags before inventing new ones. `list_notes(tag="…")` and `search_brain` can show what's in use.
- ~5 tags max per note. More is noise.

## Markdown syntax (Obsidian-flavored)

- Wikilinks: `[[Note]]`, `[[Note#Section]]`, `[[Note|display text]]`.
- Embeds: `![[Note]]`, `![[Attachments/2026/05/img.png]]`, `![[doc.pdf]]`.
- Callouts: `> [!note] Title` / `> [!warning]` / `> [!decision] Title`.
- Code fences using triple backticks. Anything inside a code fence is ignored by the indexer — don't rely on it for tags or wikilinks.

## Anti-patterns

- Don't invent paths, notes, or links you haven't verified.
- Don't write to the brain silently.
- Don't restructure folders or move multiple notes without explicit permission.
- Don't pile up tags or frontmatter "just in case".
- Don't use English vs Spanish inconsistently within the same brain — match the user's language for content; metadata (tags, status) can stay in either as long as you're consistent with what's already in use.

## When in doubt

Ask. Saving to the wrong place costs more than asking one extra question.
