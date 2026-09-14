# CLAUDE.md — BrainStack repo guide

This repo is BrainStack: shared second brain for humans + AI assistants.

The system's own knowledge base lives **inside BrainStack**, under `impulse-labs/brainstack/` — start at
`_brainstack.md`. It covers architecture, the data model, the API and MCP surfaces, the frontend, the design
system, sharing, deployment, and the incidents worth not repeating. Read it before making non-trivial changes.
The older design vault is at `<local-checkout>/projects-memory/01-Impulse-Labs/BrainStack/`.

## Stack

- pnpm workspaces, TypeScript strict, Node 20+.
- Backend: Hono + `@modelcontextprotocol/sdk` + tRPC + Drizzle.
- Frontend: Next.js 15 App Router + Tailwind + `react-aria-components` + CodeMirror 6.
- Storage: **Postgres** — any provider. `openPgDatabase` picks the driver from the connection string: Neon over its HTTP driver, everything else over node-postgres. Tests run on PGlite — real Postgres, in process.
- Self-hosting: `docker compose up` runs Postgres, the server, the web app and Caddy on one origin.
- Logger pino, validation zod, email+password (`@node-rs/argon2`) + Google OAuth (`arctic`) + optional TOTP (`@oslojs/otp`), transactional email via Resend.
- MCP clients connect through this server's own OAuth 2.1 provider.

## Workspaces

- `apps/server` — Node app: HTTP (tRPC + MCP) and stdio MCP.
- `apps/web` — Next.js web app, replaces Obsidian for humans.
- `packages/core` — Markdown parsing, wikilink resolution, Postgres store and search (framework-agnostic).
- `packages/skill` — Canonical AI instructions + multi-client adapters.

## Non-negotiable rules

- **The owner is not the caller.** Every service method takes the id of the vault's *owner*, never of whoever is asking. That is what makes a note somebody adds to a shared folder belong to the folder's owner — and what keeps the share covering it.
- **Authorisation lives in `SharingService` only.** `NoteService` knows nothing about permission; the tRPC and MCP layers ask before calling in.
- **Any folder tree reads both `notes` and `folders`.** A folder with notes under it is implied by their paths; an empty one is implied by nothing.
- **Share paths are matched in memory, never with `LIKE`.** A folder name can contain `%` or `_`, and a share that widens — or a revoke that overreaches — by accident is access silently given or cut.
- Path traversal protection on every user/agent input (centralised in `packages/core/src/paths.ts`: `normalizeNoteKey`, `normalizeRelativePath`). Pure string logic, no `node:path` — the Postgres store runs where there is no disk to resolve against. A client may sanitise before sending (the `.md` import in `apps/web` does), but the store is the barrier that counts.
- `services/` never imports Hono / tRPC / MCP — only `db/` and `core/`. When a service must report something with permission consequences, it does so through a callback wired in `wiring.ts`, not by importing `SharingService`.
- Markdown body parsed via gray-matter + remark + own plugins. Wikilinks inside code fences are never indexed or rewritten.
- `move` rewrites every wikilink pointing at what moved; `delete` rewrites nothing and leaves them unresolved.
- Never use shadcn in `apps/web`. Components are built on `react-aria-components` with the design tokens in `src/styles/globals.css`.

## Deploying

Use `bash scripts/deploy.sh publish`, from WSL. Do **not** reach for `netlify deploy --build --prod --filter` — with a packagePath stamped on the deploy, the Next catch-all shadows the API function and every `/api` route answers 404. The script's header lists that trap and four more, each of which broke production once.

## Commit style

Conventional commits (`feat:`, `chore:`, `fix:`, `test:`, `docs:`). Small, thematic commits.
