# BrainStack

Shared second brain for humans and AI assistants. Self-hostable. MCP-native.

> Status: pre-alpha. Built by [Impulse Labs](https://impulselabs.dev). Internal use only until M2.

## What this is

BrainStack stores your notes on disk as plain Markdown and exposes them to any MCP-compatible AI assistant (Claude Code, Claude Chat, Cursor, Codex, Gemini CLI, ...) through a single source of truth. Humans edit through a web app that replaces Obsidian; AIs read and write through the MCP server.

## Repo layout

```
apps/
  server/     # Hono + tRPC + MCP server (Node)
  web/        # Next.js + Justd web app
packages/
  core/       # Markdown parser, wikilink resolver, indexer
  skill/      # Canonical AI instructions + multi-client adapters
```

## Local development

Requires Node 20+ and pnpm 10+.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Roadmap

See `Milestone-1-tareas.md` in the design vault. Public roadmap lands at M2.
