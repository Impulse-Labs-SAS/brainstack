# BrainStack

> Shared second brain for humans and AI assistants. Self-hostable. MCP-native.

BrainStack keeps your notes as Markdown in Postgres. It exposes them to any MCP-compatible AI assistant: Claude Code, Claude Desktop and claude.ai, Cursor, Codex, Gemini CLI, Continue, Cline and others. People use the web app, which covers what Obsidian did: a file tree, a Markdown editor with wikilinks, full-text search, a graph, and import of the `.md` files you already have. Assistants read and write the same notes through the MCP server, and can gather everything a question refers to in a single call; the graph's Sentinel view replays what they read.

Every account has its own vault, and any folder can be shared with other people, read-only or with write access.

**Status:** pre-alpha. Built by [Impulse Labs](https://impulselabs.dev).

## Why

If you work with several AI assistants, you keep retyping the same context everywhere: design docs in the repo, in Claude Projects, in Cursor rules, in Gemini, in your head. BrainStack is the single source of truth. Your assistants pull what they need through MCP and write back when you tell them to. One brain, every AI.

## What's inside

```
apps/
  server/     Hono + tRPC + MCP server (Node 20+), with its own OAuth 2.1 provider for MCP clients
  web/        Next.js 15 web app: react-aria-components + CodeMirror 6
packages/
  core/       Markdown parsing, wikilink resolution, Postgres store and full-text search
  skill/      Canonical AI instructions + adapters for every major client
```

Storage is any Postgres. Sign-in is email and password, with optional Google sign-in and optional TOTP. MCP clients connect through OAuth or with an API key.

## Quick start (self-host)

You need Docker. The compose file runs Postgres, the server, the web app and Caddy, which serves them all on one origin with automatic TLS.

```bash
git clone https://github.com/Impulse-Labs-SAS/brainstack.git
cd brainstack
cp .env.example .env
# edit .env: at least DOMAIN, PUBLIC_ORIGIN and POSTGRES_PASSWORD
docker compose up -d
```

Then open your `PUBLIC_ORIGIN` and **create your account right away**. The first account on an instance is its owner and needs no email verification. After it, sign-up is closed.

The schema is created on first start and updated by every new version on its own. Already have a Postgres? Set `DATABASE_URL` in `.env` and BrainStack uses it instead of the bundled one.

### Email: optional for one person, needed to add others

BrainStack sends email for three things: verifying new accounts, password resets, and folder invitations. For a personal instance you can skip it. To bring anyone else in, configure one of these in `.env`, plus `AUTH_EMAIL_FROM`:

- **SMTP**, with any mail server (Gmail with an app password, Outlook, your company's relay, Resend's SMTP): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`.
- **[Resend](https://resend.com)**'s API: `RESEND_API_KEY`.

Links are only ever sent by email, never written to the log. Without email:

- only the first account can sign up with a password;
- email invitations are refused, but link invitations still work;
- a forgotten password is reset on the server:

  ```bash
  docker compose exec server node dist/cli.js reset-password you@example.com
  ```

  It prints a new password and signs the account out everywhere.

The server logs a warning at startup when email is not configured.

### Who can sign up

After the first account, sign-up is closed. People get in when one of these applies:

- you invite them to a shared folder by email;
- their address is in `AUTHORIZED_EMAILS` (comma-separated);
- `OPEN_SIGNUP=true`, which lets in anyone who can reach the server.

New accounts verify their address by email, so all three need email configured. Any account holder can invite by email, so everyone you let in can bring someone else in, into a folder they share. Keep that in mind before you add people you don't know.

## Local development

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # set DATABASE_URL to any Postgres
pnpm lint
pnpm typecheck
pnpm test        # runs on PGlite, in process; no database needed
pnpm build
# server on :3000 (HTTP + MCP; stdio MCP when MCP_STDIO=true)
pnpm --filter @brainstack/server dev
# web app on :3001
pnpm --filter @brainstack/web dev
```

To try sign-up with a second account, or password resets, point SMTP at a local mail catcher such as [Mailpit](https://mailpit.axllent.org). `apps/server/.env.example` shows how.

## Connecting an AI assistant

The web app's sidebar has **Connect AI** and **Skill** dialogs with this instance's MCP URL and copyable setup for each client. The MCP endpoint is `https://<your-domain>/api/mcp`.

### Claude Desktop, claude.ai and other clients that support OAuth

Add `https://<your-domain>/api/mcp` as a connector (in Claude: **Settings → Connectors**). The client sends you to BrainStack to sign in and approve access.

### Claude Code, Cursor and clients that take a token

Generate an API key in the web app (**Settings → API keys**), then:

```bash
claude mcp add brainstack --transport http https://<your-domain>/api/mcp \
  --header "Authorization: Bearer <api-key>"
```

### Loading the skill

Nothing to install. Every MCP connection receives a short summary of the assistant instructions (start with `gather_context`, ask before writing, how shared folders work), and the assistant fetches the full guide through the `get_brainstack_guide` tool when it is about to write. Both come from [`packages/skill/INSTRUCTIONS.md`](packages/skill/INSTRUCTIONS.md) and update with the server.

Installing the guide as a skill is optional: it puts the whole of it in front of the assistant from the first message, but an installed copy does not update itself. To build one for every major client:

```bash
pnpm --filter @brainstack/skill build
# Outputs land in packages/skill/dist/<client>/...
```

## Architecture

Start with [CLAUDE.md](CLAUDE.md). It holds the stack, the workspaces, and the non-negotiable rules. It is written for AI assistants, but it binds everyone. Design notes for the larger subsystems (sharing and permissions, the graph, wikilinks and facets) are in [`docs/`](docs/).

## License

BrainStack is copyright Impulse Labs SAS. It is free software, released under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). You can use it, modify it and self-host it, for yourself or for your company, commercially or not. If you run a modified version as a service for other people, you must offer them its source code under the same license.

## Contributing

BrainStack is open source, but not open to code contributions: all of its code is written by the Impulse Labs team, and pull requests from outside it are not accepted. Issues are open to everyone, and they are how the project moves: bugs, ideas and fixes you have in mind are all welcome there. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Built by Impulse Labs

BrainStack is built by [Impulse Labs](https://impulselabs.dev), a small team building AI-first tools. We use it ourselves every day.
