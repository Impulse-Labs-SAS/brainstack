---
name: git-workflow
description: "Git conventions for BrainStack: branch names, Conventional Commits, pull requests, releases. Use when committing, creating a branch, or preparing a pull request."
---

# Git Workflow — BrainStack

## Branches

`main` is the only integration branch. Every change reaches it through a pull request.

```
<type>/<short-kebab-description>
```

| Prefix | For | Example |
|--------|-----|---------|
| `feat/` | New functionality | `feat/markdown-import` |
| `fix/` | Bug fix | `fix/mcp-shared-reads` |
| `refactor/` | Restructuring without behaviour change | `refactor/note-store-paths` |
| `docs/` | Documentation only | `docs/self-host-guide` |
| `test/` | Tests only | `test/sharing-revoke` |
| `chore/` | Tooling, dependencies, config | `chore/agpl-license` |
| `ci/` | Workflows | `ci/docker-images` |

`claude/*` branches are created by Claude Code sessions automatically. Before the first edit on any
branch, check it is based on current `main` — see `.claude/rules/branching.md`.

**Only the Impulse Labs team writes code here.** Pull requests from outside the team are closed with a
pointer to `CONTRIBUTING.md`, never merged: the copyright of the whole codebase stays with Impulse
Labs SAS. An idea or a fix proposed in an issue is reimplemented by the team, never copied from it.

## Commits — Conventional Commits, in English

```
<type>(<optional scope>): <imperative summary, lower case, no period>

<body: why the change was needed, what was wrong, what it does now>
```

**Types:** `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `style`, `chore`, `ci`.

**Scopes** name the area, and are what `git log` in this repo uses: `web`, `server`, `mcp`, `core`,
`notes`, `sharing`, `invite`, `auth`, `skill`, `deploy`, `docker`. Omit the scope when a change spans
several areas.

```
feat(web): import .md files into the tree
fix(mcp): answer a read from the shared folder the path names
chore(deploy): assert the MCP endpoint reaches the function before publishing
```

- **Small and thematic.** One concern per commit. A feature, the bug found while building it, and a
  formatting sweep are three commits.
- **The body explains why.** The diff already says what. Describe the failure, the cause, and why
  this fix — the reader in a year has only the log.
- **Never commit secrets** — see `.claude/rules/env-example-safety.md`. Stage files by name; never
  `git add -A` or `git add .` without reading `git status` first.
- **Breaking changes:** `feat!:` plus a `BREAKING CHANGE:` footer describing what a self-hoster has to
  do when upgrading.

### Attribution (Claude Code)

Commits written with Claude Code end with a `Co-Authored-By` trailer naming **the model writing the
commit**:

```
Co-Authored-By: Claude <model> <noreply@anthropic.com>
```

Do not hardcode a model version in this file — it changes and this file would contradict the session.
The source of truth, in order: the exact trailer given in the session's system prompt; otherwise the
active model's name as the session reports it.

Pull request bodies written with Claude Code end with:
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`

## Pull requests

- **Base: `main`.**
- **Title:** same format as a commit subject.
- **Body:** what changed, why, how it was tested (commands run, and anything verified by hand), and
  what a reviewer should look at first. Note anything only a real deployment can verify.
- **Ready when** it does one thing, a behaviour change comes with a test (a bug fix with a test that
  failed before the fix), and `pnpm format` has been run.
- **CI green before merge:** lint, typecheck, test, build, and the Docker images.
- **Closes the issue:** the body says `Closes #N`, so merging closes it.
- **Same label as its issue** (`bug`, `enhancement`, `documentation`): release notes are grouped by it
  (`.github/release.yml`).
- **Squash and merge**: each pull request lands on `main` as one commit, which is also the line the
  release notes show. Older history uses merge commits.
- Never force-push a branch someone else has checked out without saying so first. Never push to `main`.

## Releases

Semantic versioning, tagged on `main`: `vMAJOR.MINOR.PATCH`.

- **MAJOR** — a self-hoster must do something beyond pulling the new images.
- **MINOR** — new functionality; upgrading is pull and restart.
- **PATCH** — fixes only.

A release does not deploy anything: every merge to `main` already reached production. It tells
self-hosters there is a version worth upgrading to, so cut one when something worth announcing has
landed, not per merge. The version number already says how early it is: `0.x` releases are published
as normal releases, not pre-releases, so the latest one shows on the repository's front page.

Releases are cut from the web, which creates the tag on publish:

1. **Releases → Draft a new release**.
2. **Tag:** the new version → *Create new tag on publish*. **Target:** `main`.
3. **Previous tag:** the last release → **Generate release notes**, then add two or three lines on top
   with what matters (and, for a MAJOR, what a self-hoster has to do).
4. Leave **Set as a pre-release** unticked → **Publish release**.

## Useful commands

```bash
git fetch origin && git switch -c feat/my-change origin/main
git push -u origin feat/my-change
gh pr create --base main
gh pr list --state merged --limit 8 --json number,headRefName,baseRefName
```
