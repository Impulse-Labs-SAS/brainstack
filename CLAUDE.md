# CLAUDE.md — BrainStack repo guide

This repo is BrainStack: shared second brain for humans + AI assistants.

Design notes for the larger subsystems live in `docs/`: sharing and permissions (`Sharing-design.md`), the
graph (`Graph-design.md`), and wikilinks, facets and the Connections panel
(`Wiki-links-y-ecosistema-design.md`). Most of the reasoning lives next to the code, in comments that say why.
Read the relevant ones before making non-trivial changes.

## Stack

- pnpm workspaces, TypeScript strict, Node 20+.
- Backend: Hono + `@modelcontextprotocol/sdk` + tRPC + Drizzle.
- Frontend: Next.js 15 App Router + Tailwind + `react-aria-components` + CodeMirror 6.
- Storage: **Postgres** — any provider. `openPgDatabase` picks the driver from the connection string: Neon over its HTTP driver, everything else over node-postgres. Tests run on PGlite — real Postgres, in process.
- Self-hosting: `docker compose up` runs Postgres, the server, the web app and Caddy on one origin.
- Logger pino, validation zod, email+password (scrypt from `node:crypto`) + Google OAuth (`arctic`) + optional TOTP (`@oslojs/otp`), transactional email via Resend or any SMTP server (optional).
- Sign-up is closed by default: the first account is the instance's owner; after it, only `AUTHORIZED_EMAILS`, a pending email invitation or `OPEN_SIGNUP=true` let anyone in. Every account has its own vault, and folders can be shared between accounts.
- MCP clients connect through this server's own OAuth 2.1 provider.

## Workspaces

- `apps/server` — Node app: HTTP (tRPC + MCP) and stdio MCP.
- `apps/web` — Next.js web app, replaces Obsidian for humans.
- `packages/core` — Markdown parsing, wikilink resolution, Postgres store and search (framework-agnostic). Also **Sentinel** (`@brainstack/core/sentinel`), the context engine behind `gather_context`: it reads through a `ContextSource` and knows nothing about vaults, so it can serve another system or move to its own package.
- `packages/skill` — Canonical AI instructions + multi-client adapters.

## Non-negotiable rules

- **The owner is not the caller.** Every service method takes the id of the vault's *owner*, never of whoever is asking. That is what makes a note somebody adds to a shared folder belong to the folder's owner — and what keeps the share covering it.
- **Authorisation lives in `SharingService` only.** `NoteService` knows nothing about permission; the tRPC and MCP layers ask before calling in.
- **Any folder tree reads both `notes` and `folders`.** A folder with notes under it is implied by their paths; an empty one is implied by nothing.
- **Share paths are matched in memory, never with `LIKE`.** A folder name can contain `%` or `_`, and a share that widens — or a revoke that overreaches — by accident is access silently given or cut.
- **Every `LIKE` built from a path goes through `escapeLike`** (`@brainstack/core/pg`). Unescaped, `a_b/%` also matches `aXb/`, so deleting or moving one folder reaches into its neighbour. A `LIKE` over shared folders may narrow a query, but the rows are still re-checked in memory before anyone sees them.
- Path traversal protection on every user/agent input (centralised in `packages/core/src/paths.ts`: `normalizeNoteKey`, `normalizeRelativePath`). Pure string logic, no `node:path` — the Postgres store runs where there is no disk to resolve against. A client may sanitise before sending (the `.md` import in `apps/web` does), but the store is the barrier that counts.
- `services/` never imports Hono / tRPC / MCP — only `db/` and `core/`. When a service must report something with permission consequences, it does so through a callback wired in `wiring.ts`, not by importing `SharingService`.
- Markdown body parsed via gray-matter + remark + own plugins. Wikilinks inside code fences are never indexed or rewritten.
- `move` rewrites every wikilink pointing at what moved; `delete` rewrites nothing and leaves them unresolved.
- Never use shadcn in `apps/web`. Components are built on `react-aria-components` with the design tokens in `src/styles/globals.css`.

## Deploying

This is for Impulse Labs' hosted instance; self-hosters use `docker compose`. Use `bash scripts/deploy.sh publish`, from WSL, with `BRAINSTACK_SITE_ID` and `BRAINSTACK_SITE_URL` set (or in the gitignored `scripts/deploy.local.env`). Do **not** reach for `netlify deploy --build --prod --filter` — with a packagePath stamped on the deploy, the Next catch-all shadows the API function and every `/api` route answers 404. The script's header lists that trap and four more, each of which broke production once.

## Commit style

Conventional commits (`feat:`, `chore:`, `fix:`, `test:`, `docs:`). Small, thematic commits.
