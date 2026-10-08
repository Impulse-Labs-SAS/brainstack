# No Real Vault Content in the Repository

This repository is public. The vaults BrainStack is tested against are not: they hold people's
products, clients, prices and plans. Nothing read from one is committed here, in any form.

## Never commit, from a real vault

- Product, project, client or people names.
- Note titles, paths, folder names, excerpts or paraphrases of what a note says.
- The questions someone asked it, and the scores or ranks it returned.

That covers code, tests, comments, docs, commit messages, branch names, PR titles and bodies, issue
titles and bodies, and every comment or review reply. A PR or issue body can be edited later, but its
edit history stays public; a pushed commit stays reachable by its SHA after a force-push.

The same goes for what a real vault _says about itself_: "tested against a copy of real notes",
"in production, question X scored 0.6", "the index of product Y". Describe the case, not the vault.

## When a real case is the bug report

Reproduce its **shape** with invented names: how many notes, which link to which, how long they
are, which words they share. That is what the ranking sees. "An index named by the question, twenty
areas under it, one note linked from three results" is the test; the real titles never are.

Use placeholders that are plainly made up (`Orbit`, `Ledger`, `Atlas`, `Erebor`), and describe the
case in the PR the same way: "a question that spans two projects", not the question itself.

## Never publish a mapping

When real names are replaced, do not write down what replaced what — no "X → Y" table in a PR, no
"renamed X to Y" in a commit message. A mapping is a decoder: it publishes every name it was meant to
remove. Say how many names and files changed, and nothing else about them.

## If it already happened

Treat it like a committed secret (see `env-example-safety.md`): replace it with invented content in
the current tree, tell a maintainer, and leave the history rewrite to them.
