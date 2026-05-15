# CLAUDE.md — BrainStack repo guide

This repo is BrainStack: shared second brain for humans + AI assistants. Design vault lives at `<local-checkout>/projects-memory/01-Impulse-Labs/BrainStack/` — read it before making non-trivial changes.

## Stack

- pnpm workspaces, TypeScript strict, Node 20+.
- Backend: Hono + `@modelcontextprotocol/sdk` + tRPC + Drizzle + better-sqlite3.
- Frontend: Next.js 14+ App Router + Tailwind + **Justd** (NOT shadcn) + CodeMirror 6.
- Storage: filesystem `.md` (source of truth) + sqlite FTS5 (regenerable cache).
- Logger pino, validation zod, magic-link auth via Resend.

## Workspaces

- `apps/server` — Node app: HTTP (tRPC + MCP), stdio MCP, watcher, cron.
- `apps/web` — Next.js web app, replaces Obsidian for humans.
- `packages/core` — Markdown parsing, wikilink resolution, indexer (framework-agnostic).
- `packages/skill` — Canonical AI instructions + multi-client adapters.

## Non-negotiable rules

- Filesystem is the source of truth. sqlite is a regenerable cache.
- Path traversal protection on every user/agent input (centralised in `apps/server/src/lib/paths.ts`).
- Atomic writes: write to `<path>.tmp`, then rename.
- WAL mode on sqlite.
- Watcher must be idempotent (dedupe by checksum or mtime).
- `services/` never imports Hono / tRPC / MCP — only `db/`, `fs/`, `core/`.
- Markdown body parsed via gray-matter + remark + own plugins.
- Use Justd in `apps/web` — never shadcn.

## Commit style

Conventional commits (`feat:`, `chore:`, `fix:`, `test:`, `docs:`). Small, thematic commits.
