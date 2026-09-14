# Commit the pending changes

Review the pending changes and commit them following the project's conventions
(`.claude/skills/git-workflow/SKILL.md`). Local only — do not push.

## Steps

### 1. Read the state

```bash
git status
git diff --stat
git diff
git log --oneline -5
```

### 2. Check nothing sensitive is in it

- No `.env`, `apps/server/.env` or any other file with real values.
- No real hostnames, keys, tokens or account identifiers in the diff — including comments, test
  fixtures and example files (`.claude/rules/env-example-safety.md`).
- No throwaway files: screenshots, logs, scratch scripts.

If something is there, stop and tell the user.

### 3. Split into commits

Small and thematic: one concern per commit. If the changes cover clearly separate concerns (a feature
and a bug found along the way, a refactor and a behaviour change), make one commit each and say how you
split them. When the split is not obvious, ask.

### 4. Write each commit

- Conventional Commits, in English: `type(scope): imperative summary` — types and scopes in the
  git-workflow skill.
- A body whenever the change is not self-explanatory: what was wrong, why, what it does now.
- End with the `Co-Authored-By` trailer for the model writing the commit, as given by the session.
- Stage files **by name**. Never `git add -A` or `git add .`.

### 5. Confirm

Show `git log --oneline -5` and `git status`.

## Rules

- **Never push** from this command.
- **Never commit secrets.**
- **Never `--no-verify`**: if a hook fails, fix the cause.
