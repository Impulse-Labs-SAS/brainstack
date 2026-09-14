# Update docs, commit, push and open the pull request

Update the documentation, verify the change, commit it, push the branch, and open a pull request
against `main` if the branch does not have one yet.

## Steps

### 1. Update the documentation

Invoke the `update-docs` skill **before** committing, so documentation changes travel with the code
they describe. It is surgical: if nothing documented changed, it changes nothing, and that is fine.

### 2. Read the state — fetch first

`git status` only knows the last sync; fetch before trusting it.

```bash
git fetch origin
git status
git diff --stat
git log --oneline -5
git branch -vv
```

### 3. Check the remote

With the current branch `<branch>`:

```bash
git log --oneline HEAD..origin/<branch>   # someone pushed to this branch
git log --oneline HEAD..origin/main       # main moved since this branch was based
```

| Result | Action |
|--------|--------|
| `HEAD..origin/<branch>` has commits | The remote branch moved. **Do not push yet.** Tell the user, integrate (`git pull --rebase` if the branch is only yours), resolve conflicts, re-run the checks. |
| `HEAD..origin/main` has commits | `main` moved. Report it. If the changes overlap with this branch, suggest updating before merge; do not rebase a shared branch without asking. |
| Both empty | Safe to push. |

On `main` itself: stop. Create a branch — nothing is pushed to `main` directly.

### 4. Verify

Run what CI runs, and do not push red:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

If the change touches `Dockerfile`, `docker-compose.yml`, `Caddyfile`, dependencies or build config,
also build the images (`docker build --target server .` and `--target web`) when Docker is available,
and say so if it is not.

### 5. Commit

Follow `/commit`: check for secrets, split into thematic commits, Conventional Commits in English,
`Co-Authored-By` trailer, stage by name.

### 6. Push

- Re-fetch if commits were created since step 3; `HEAD..origin/<branch>` must still be empty.
- `git push`, or `git push -u origin <branch>` if it has no upstream.
- **Never `--force`** without the user's explicit confirmation. If the push is rejected, go back to
  step 3.

### 7. Open the pull request, if there is none

```bash
gh pr list --head <branch> --json number,url
```

- **One exists**: the push already updated it. Report its URL.
- **None**: `gh pr create --base main`.
  - Title in the format of a commit subject.
  - Body: what changed, why, how it was tested (commands, and anything verified by hand), what only a
    real deployment can verify, and what the reviewer should look at first.
  - End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- From a fork, the pull request targets `Impulse-Labs-SAS/brainstack:main`.

### 8. Report

`git log --oneline -3`, that the push succeeded, the PR URL, whether `main` has moved, and the result
of the checks from step 4.

## Rules

- **Docs first, in the same push.**
- **Fetch first; check the remote before pushing.**
- **Checks green before pushing.**
- **Never push to `main`. Never force-push without confirmation. Never commit secrets.**
- **Never deploy** from this command. Deploying is a maintainer's decision, made separately.
