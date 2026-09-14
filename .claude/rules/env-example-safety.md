# `.env.example` and Committed Secrets

This repository is public. Every committed file — and every version of it in history — is readable by
anyone, forever: forks, mirrors and caches keep what a later commit removes.

There are two templates, for two audiences:

| File | For | Read by |
|------|-----|---------|
| `.env.example` | Self-hosting with `docker compose` | compose (`env_file`), copied to `.env` |
| `apps/server/.env.example` | Development without Docker | the dev server, copied to `apps/server/.env` |

## Hard rules

1. **No real credentials, anywhere in the repo.** Database passwords, connection strings with a
   password in them, API keys (Resend, Google OAuth), tokens, private keys, deploy tokens.
2. **No real infrastructure identifiers.** Real database hostnames (`ep-...neon.tech`), hosting site
   IDs, account or team names, internal URLs. Use placeholders: `your-db-host`, `brain.example.com`.
3. **Empty beats plausible.** A required secret is left empty (`POSTGRES_PASSWORD=`) so that a
   careless `cp .env.example .env` fails loudly at startup instead of running with a guessable value.
   Never ship a default password that works.
4. **Every variable the code reads is documented** in the template for its audience, with a comment
   saying what it does, whether it is required, and what happens when it is empty. The source of
   truth is `apps/server/src/config/env.ts`.

## Allowed

- Compose-internal hostnames and ports (`postgres:5432`), which exist only on the compose network.
- Local-only defaults that are obviously local (`http://localhost:3000`).
- Enum and boolean flags (`BRAINSTACK_DEPLOYMENT=self-host`).

## When a secret was committed

1. **Assume it is compromised**, even if the commit was reverted a minute later.
2. **Rotate it at the source** first. Rewriting history does not un-leak anything.
3. Replace it with a placeholder and commit.
4. Tell a maintainer. Whether history is rewritten is their call; rotation is not optional.

## Before committing a change to either template

- [ ] Every value is empty, a placeholder, a compose-internal name, or an obvious localhost default.
- [ ] No real hostnames, IDs or keys, in values or in comments.
- [ ] New variables in `env.ts` appear in the right template, and in `docker-compose.yml` if the
      container needs them.
