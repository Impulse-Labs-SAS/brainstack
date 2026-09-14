---
name: update-docs
description: "Update BrainStack's documentation to match the changes made in this session: README, CLAUDE.md, .env.example files, packages/skill/INSTRUCTIONS.md, docs/ and .claude/rules. Surgical — documents only what actually changed."
---

# Update Docs — BrainStack

Bring the documentation in line with what this session changed. **Document only what exists in the
code. Do not invent, do not speculate, do not rewrite sections that did not change.**

## Step 1 — What changed

```bash
git status
git diff --stat
git diff --name-only origin/main...HEAD
git log --oneline origin/main..HEAD
```

Also read the conversation for the reason behind the changes. If nothing documented is affected (a
refactor with no behaviour change, a test), say so and stop — no change is a valid outcome.

## Step 2 — Map changes to documents

| If the change touches… | Update |
|---|---|
| An env var read in `apps/server/src/config/env.ts` | `.env.example` (self-host) and/or `apps/server/.env.example` (dev); `docker-compose.yml` if the container needs it |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile`, how to install or upgrade | `README.md` → Quick start |
| An MCP tool — added, renamed, arguments, behaviour (`apps/server/src/mcp/`) | `packages/skill/INSTRUCTIONS.md`: it is what every user's assistant reads through `get_brainstack_guide`, and a tool it does not describe is a tool assistants misuse |
| Connecting an assistant, OAuth, API keys | `README.md` → Connecting an AI assistant |
| Stack, workspaces, a new non-negotiable rule | `CLAUDE.md` |
| A permanent invariant learned the hard way | A rule in `.claude/rules/` — new file or a section in an existing one |
| Contribution process, local setup | `CONTRIBUTING.md` |
| A design decision with trade-offs | `docs/` |

## Step 3 — Edit

- **Read the file before editing it.** Use Edit, not a full rewrite. Match its tone, density and format.
- **English** — `.claude/rules/language-policy.md`.
- **Verify every fact against the code** before writing it: env var names and defaults, routes
  (every HTTP route sits under `/api`), tool names, commands.
- **No internal information**: no hostnames, account names, personal paths, private links. This is a
  public repository — `.claude/rules/env-example-safety.md`.
- A rule in `.claude/rules/` states the invariant, the failure it prevents, and how to check it — not
  the story of the session.

## Step 4 — Check consistency

- Every variable in `env.ts` is documented in the template for its audience, with the same name.
- `README.md`, `.env.example` and `docker-compose.yml` agree on how to start BrainStack.
- Every MCP tool registered in `apps/server/src/mcp/` that assistants should use is described in
  `INSTRUCTIONS.md`, with its current name.
- No document references a file, command or route that no longer exists.

## Step 5 — Report

```
## Documentation updated
- <file> — <what changed>
Consistency: OK | <what does not match>
```

Or: `No documentation affected by these changes.`
