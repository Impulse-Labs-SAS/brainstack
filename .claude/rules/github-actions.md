# GitHub Actions Invariants

The repository is public, so its workflows run on pull requests from people with no access to it.
Write every workflow assuming the event that triggered it was crafted by a stranger.

## Never interpolate `${{ }}` inside a `run:` block

The runner pastes the value into the script **before the shell starts**, so it becomes code, not data,
and no quoting can contain it. A branch name can carry `$(...)`; a PR title can carry anything.

```yaml
# DON'T
- run: echo "branch=${{ github.head_ref }}"

# DO
- env:
    HEAD_REF: ${{ github.head_ref }}
  run: echo "branch=$HEAD_REF"
```

The rule is mechanical on purpose: pass **every** expression through `env:` and reference `"$VAR"`.
Do not decide per expression which context fields a stranger controls.

## Fork pull requests get no secrets — keep it that way

- `pull_request` from a fork runs with a read-only token and no secrets. That is the safe default.
- **Never use `pull_request_target` or `workflow_run` to check out and build a fork's code.** Those
  events run with the base repository's secrets and a write token; checking out the PR head there
  hands both to whoever opened it.
- A job that needs secrets (deploy, publish) runs only on `push` to `main` and is guarded with
  `if: github.repository == 'Impulse-Labs-SAS/brainstack'`, so it does not run — and fail, or worse,
  half-run — in every fork that enables Actions.

## A missing secret is an empty string, not an error

`${{ secrets.FOO }}` for a secret that does not exist becomes `""`. No error, no annotation, a green
job. Whenever a value matters, assert it before using it:

```yaml
- env:
    TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
  run: |
    set -euo pipefail
    # `if`, not `[ ... ] && ...`: under `set -e` that form fails when the condition is false.
    if [ -z "$TOKEN" ]; then
      echo "::error::NETLIFY_AUTH_TOKEN is empty or missing"
      exit 1
    fi
```

## Workflow-level keys see fewer contexts than steps do

`concurrency` and other keys evaluated before a job starts accept only `github` and `vars` — not
`inputs`, even under `workflow_dispatch`. Using it there fails the whole file with a
`startup_failure`: no jobs, no annotation, and the run named after the file path instead of the
workflow's `name:`. Use `github.event.inputs.<name>` instead.

## An expression in a shell comment is still an expression

Substitution runs over the whole script text, comments included. Describe the syntax in comments
(“an Actions expression”); do not spell it, or the file stops parsing.

## A check that cannot run looks exactly like a check that passes

- A `paths:` filter must cover every file type the job validates, not only its own workflow file.
- A deploy whose first step fails leaves production on the old version while everything else looks
  normal. After merging to `main`, glance at the deploy run.

## Before pushing a workflow change

- `actionlint .github/workflows/*.yml` if available — it catches all the parse errors above in under a
  second. Otherwise, at least parse the YAML.
- Every secret and path the workflow references exists.
- Say in the PR what can only be verified by the first real run.
