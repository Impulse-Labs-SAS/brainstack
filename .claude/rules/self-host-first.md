# Self-Host First

BrainStack is meant to be run by people we will never talk to, on infrastructure we will never see.
Every change is judged against that person, not against the maintainers' own deployment.

## Required of every change

- **`docker compose up` keeps working.** A feature that only works on the maintainers' hosting
  (Netlify, Neon) is not finished. If it needs a new service or env var, it lands in
  `docker-compose.yml` and `.env.example` in the same change.
- **No required third-party account.** Anything outside the compose file — email delivery (Resend),
  Google sign-in, a managed database — is optional, and BrainStack runs without it. Being optional
  means the code checks for the config and degrades explicitly, not that it crashes on first use.
- **Any Postgres.** Storage is Postgres, reached through `openPgDatabase`, which picks the driver
  from the connection string. Do not import a vendor driver anywhere else, and do not use SQL that
  only one provider accepts.
- **Secure by default, open by configuration.** A self-hoster who copies `.env.example` and changes
  nothing must not end up with a publicly exploitable instance. A development convenience that
  weakens security (returning reset links in a response, open sign-up) is an explicit opt-in, never
  inferred from a value someone may have left at its default — not `NODE_ENV`, and not the scheme of
  `PUBLIC_ORIGIN` either.
- **Failures are visible.** A missing optional dependency is logged once at boot with what it
  disables. A fallback that silently degrades is a bug report nobody can write.
- **The schema migrates itself.** Nobody running BrainStack should need to run a command after
  upgrading. Migrations are idempotent (`IF NOT EXISTS`) and run on startup.

## Sanity check before proposing anything

1. Would this work for someone who cloned the repo today and ran `docker compose up`?
2. Does it add an account, key or service they must obtain? If so, can BrainStack run without it?
3. If it fails, does the person running it find out, and from where?

If any answer is wrong, revise the proposal before delivering it.
