# BrainStack

> Shared second brain for humans and AI assistants. Self-hostable. MCP-native.

BrainStack stores your notes on disk as plain Markdown and exposes them to any MCP-compatible AI assistant (Claude Code, Claude Chat, Claude Desktop, Cursor, Codex, Gemini CLI, Antigravity, Continue, Cline, …). Humans edit through a web app that replaces Obsidian — including importing `.md` files you already have, one or many, by picking them from the tree or dropping them onto a folder; AIs read and write through the MCP server, all backed by the same notes.

**Status:** pre-alpha. Built by [Impulse Labs](https://impulselabs.dev). Internal use only until M2.

## Why

If you work with several AI assistants, you keep retyping the same context everywhere — design docs in the repo, in Claude Projects, in Cursor rules, in Gemini, in your head. BrainStack is the single source of truth: your assistants pull what they need through MCP and write back when you tell them to. One brain, every AI.

## What's inside

```
apps/
  server/     Hono + tRPC + MCP server (Node 20+)
  web/        Next.js 15 web app with Justd UI + CodeMirror 6
packages/
  core/       Markdown parser, wikilink resolver, sqlite indexer with FTS5
  skill/      Canonical AI instructions + adapters for every major client
```

Storage: plain `.md` files in `NOTES_DIR` (source of truth) + a regenerable sqlite cache with FTS5 search. Auth: email + password (argon2id) and Google OAuth, plus Bearer API keys for MCP clients. Backups: a cron snapshots the sqlite and pushes the notes directory + snapshot to a private git repo.

## Quick start (self-host)

Requires Node 20+ and Docker.

```bash
git clone https://github.com/Impulse-Labs-SAS/brainstack.git
cd brainstack
cp .env.example .env
# edit .env — set AUTHORIZED_EMAILS, RESEND_API_KEY, DOMAIN, BACKUP_REPO
docker compose up -d
```

Then visit `https://<your-domain>`, sign up with email + password (or "Continue with Google"), verify your email, and generate API keys from **Settings → API keys** to connect Claude, Cursor, and friends.

## Local development

```bash
pnpm install
pnpm -r lint
pnpm -r typecheck
pnpm -r test
pnpm -r build
# server on :3000 (HTTP + MCP HTTP/SSE; stdio MCP when MCP_STDIO=true)
pnpm --filter @brainstack/server dev
# web app on :3001
pnpm --filter @brainstack/web dev
```

## Connecting an AI assistant

Generate an API key in the web app (**Settings → API keys**), then:

### Claude Code / Cursor (local stdio)

```bash
# Claude Code
claude mcp add brainstack --transport http https://<your-domain>/mcp \
  --header "Authorization: Bearer <api-key>"
```

### Claude Chat / Desktop (remote HTTP)

Add `https://<your-domain>/mcp` as a connector in **Settings → Connectors** and paste the API key.

### Loading the skill

BrainStack ships canonical AI instructions for every major client. Build them with:

```bash
pnpm --filter @brainstack/skill build
# Outputs land in packages/skill/dist/<client>/...
```

You can also fetch the same instructions at runtime via the `get_brainstack_guide` MCP tool — handy for clients without a dedicated skill format.

## Architecture

Design vault lives at `01-Impulse-Labs/BrainStack/` (private). Documents to read before non-trivial changes:

- `Diseño-V1.md` — vision, scope, decisions.
- `Modelo-de-datos.md` — sqlite schema + wikilink/embed conventions.
- `Arquitectura-backend.md` — capas, librerías, reglas no negociables.
- `Arquitectura-frontend.md` — tokens, estructura, anti-patrones.
- `Skill-design.md` — canonical AI instructions design.

## License

BrainStack is free software, released under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). You can use it, modify it and self-host it — for yourself or for your company, commercially or not. If you run a modified version as a service for other people, you must offer them its source code under the same license.

## Contributing

Issues are open to everyone. Code contributions start with an issue, not a pull request — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Built by Impulse Labs

BrainStack is built by [Impulse Labs](https://impulselabs.dev) — a small team building AI-first tools. We use it ourselves every day.
