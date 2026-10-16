# CLAUDE.md — BrainStack repo guide

This repo is BrainStack: shared second brain for humans + AI assistants.

Design notes for the larger subsystems live in `docs/`: sharing and permissions (`Sharing-design.md`), the
graph (`Graph-design.md`), and wikilinks, facets and the Connections panel
(`Wiki-links-y-ecosistema-design.md`). Most of the reasoning lives next to the code, in comments that say why.
Read the relevant ones before making non-trivial changes.

## Stack

- pnpm workspaces, TypeScript strict, Node 22+.
- Backend: Hono + `@modelcontextprotocol/sdk` + tRPC + Drizzle.
- Frontend: Next.js 15 App Router + Tailwind + `react-aria-components` + CodeMirror 6.
- Storage: **Postgres** — any provider. `openPgDatabase` picks the driver from the connection string: Neon over its HTTP driver, everything else over node-postgres. Tests run on PGlite — real Postgres, in process.
- Self-hosting: `docker compose up` runs Postgres, the server, the web app and Caddy on one origin.
- Logger pino, validation zod, email+password (scrypt from `node:crypto`) + Google OAuth (`arctic`) + optional TOTP (`@oslojs/otp`), transactional email via Resend or any SMTP server (optional).
- Sign-up is closed by default: the first account is the instance's owner; after it, only `AUTHORIZED_EMAILS`, a pending email invitation or `OPEN_SIGNUP=true` let anyone in. Every account has its own vault, and folders can be shared between accounts.
- MCP clients connect through this server's own OAuth 2.1 provider.

## Workspaces

- `apps/server` — Node app: HTTP (tRPC + MCP over Streamable HTTP).
- `apps/web` — Next.js web app, replaces Obsidian for humans.
- `packages/core` — Markdown parsing, wikilink resolution, Postgres store and search (framework-agnostic). Also **Sentinel** (`@brainstack/core/sentinel`), BrainStack's engine for working with notes — part of BrainStack, not a product of its own. It reads: `gather_context` and every search (`search_brain`, the web palette) go through it, so all of them rank alike, and each note comes back with the `checksum` and `sections` an edit needs. It writes: edits that name what changes (`edit.ts`) instead of resending a note, served as `edit_note` and `save_notes` (several writes, all checked before any lands; `apps/server/src/services/saveNotes.ts`). Every assistant write — those two, `create_note` and `update_note` — goes through that batch, which keeps a note's body within `NOTE_MAX_CHARS` (`size.ts`, the length a crawl hands over whole): past it a write is refused with how to split the note, and a note already longer may only shrink. People in the web app are not held to it; the editor shows a meter. Permission still lives in `SharingService` only — the MCP layer asks before calling in.
- `packages/skill` — Canonical AI instructions + multi-client adapters.

## Non-negotiable rules

- **The owner is not the caller.** Every service method takes the id of the vault's _owner_, never of whoever is asking. That is what makes a note somebody adds to a shared folder belong to the folder's owner — and what keeps the share covering it.
- **Authorisation lives in `SharingService` only.** `NoteService` knows nothing about permission; the tRPC and MCP layers ask before calling in.
- **Any folder tree reads both `notes` and `folders`.** A folder with notes under it is implied by their paths; an empty one is implied by nothing.
- **Share paths are matched in memory, never with `LIKE`.** A folder name can contain `%` or `_`, and a share that widens — or a revoke that overreaches — by accident is access silently given or cut.
- **Every `LIKE` built from a path goes through `escapeLike`** (`@brainstack/core/pg`). Unescaped, `a_b/%` also matches `aXb/`, so deleting or moving one folder reaches into its neighbour. A `LIKE` over shared folders may narrow a query, but the rows are still re-checked in memory before anyone sees them.
- Path traversal protection on every user/agent input (centralised in `packages/core/src/paths.ts`: `normalizeNoteKey`, `normalizeRelativePath`). Pure string logic, no `node:path` — the Postgres store runs where there is no disk to resolve against. A client may sanitise before sending (the `.md` import in `apps/web` does), but the store is the barrier that counts.
- `services/` never imports Hono / tRPC / MCP — only `db/` and `core/`. When a service must report something with permission consequences, it does so through a callback wired in `wiring.ts`, not by importing `SharingService`.
- Frontmatter is split, parsed and written back only by `packages/core/src/parser/frontmatter.ts` (js-yaml, default schema). Never gray-matter: it `eval()`s a `---js` block and re-parses bodies on stringify; lint refuses the import. Wikilinks inside code fences are never indexed or rewritten.
- `move` rewrites every wikilink pointing at what moved; `delete` rewrites nothing and leaves them unresolved.
- **Assistants ask; people act.** What an assistant cannot undo for the user — sharing a folder, giving notes to another owner — is a request the person approves, or an action they take, in the web app. MCP never does it on the strength of a flag the assistant sets.
- **A failure the caller did not cause tells them nothing.** Only an `AppError` (or a core error `toAppError` maps) reaches a client with its message; anything else is logged and answered "internal error".
- Never use shadcn in `apps/web`. Components are built on `react-aria-components` with the design tokens in `src/styles/globals.css`.

## Deploying

This is for Impulse Labs' hosted instance; self-hosters use `docker compose`. Use `bash scripts/deploy.sh publish`, from WSL, with `BRAINSTACK_SITE_ID` and `BRAINSTACK_SITE_URL` set (or in the gitignored `scripts/deploy.local.env`). Do **not** reach for `netlify deploy --build --prod --filter` — with a packagePath stamped on the deploy, the Next catch-all shadows the API function and every `/api` route answers 404. The script's header lists that trap and four more, each of which broke production once.

## Commit style

Conventional commits (`feat:`, `chore:`, `fix:`, `test:`, `docs:`). Small, thematic commits.
