# Branching — verify the base before the first edit

Every branch descends from `origin/main`, the only integration branch. Work reaches `main` through a
pull request, never a direct push.

## Check the base when you enter a branch, not when you create one

A rule that fires on `git checkout -b` never fires in a session that is handed a branch that already
exists — which is how Claude Code on the web works: the environment clones the repository and cuts
the session branch before the first turn. So the check belongs to the start of the work:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD && echo ok || echo "BEHIND main"
```

Run it **before the first edit of the session**. If the branch is behind, bring it up to date before
touching anything:

```bash
git rebase origin/main          # the branch is yours and not yet shared
git merge origin/main           # the branch is already pushed and others may have it
```

Updating first is cheap. Updating after a session of work means resolving conflicts against code that
moved underneath you, and re-reading every change to tell your work from the base's.

**A stale base is silent.** The code compiles, the tests pass, the work looks finished — and it may
reimplement something `main` already has, or edit a file that was split in the meantime.

## Related

- `.claude/skills/git-workflow/SKILL.md` — branch names, commits, pull requests.
