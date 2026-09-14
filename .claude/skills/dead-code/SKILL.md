---
name: dead-code
description: "Find and remove dead code in BrainStack's TypeScript workspaces: unused imports, variables, exports, files and dependencies. Use after refactors, before a pull request, or when unused code is suspected."
---

# Dead Code — BrainStack

Analyse the scope the user names (a workspace, a directory, a module). With no scope, analyse every
workspace. **Use Grep and Bash directly** — this is mechanical search, and it is faster and more
precise without delegating to agents.

## Step 1 — The compiler and the linter

They catch most of it, reliably: `tsconfig.base.json` sets `noUnusedLocals` and
`noUnusedParameters`, and ESLint flags unused variables.

```bash
pnpm typecheck
pnpm lint
```

Fix everything they report before looking further.

## Step 2 — Exports nobody imports

For each exported symbol in scope, look for an importer anywhere in the monorepo:

```bash
git grep -nE "^export (async )?(function|const|class|type|interface|enum) " -- 'packages/core/src' 'apps/server/src' 'apps/web/src' \
  | grep -v '\.test\.ts' \
  | while IFS=: read -r file line content; do
      symbol=$(echo "$content" | sed -E 's/^export (async )?(function|const|class|type|interface|enum) ([A-Za-z0-9_]+).*/\3/')
      if ! git grep -qw "$symbol" -- . ":!$file"; then echo "UNUSED EXPORT: $file:$line $symbol"; fi
    done
```

Barrels (`packages/core/src/index.ts`, `packages/core/src/pg/index.ts`) re-export on purpose: a symbol
is dead only if nothing imports it **through** the barrel either.

## Step 3 — Dependencies nobody imports

For each dependency in a workspace's `package.json`, check the workspace imports it:

```bash
cd apps/server && node -e "for (const d of Object.keys(require('./package.json').dependencies ?? {})) console.log(d)" \
  | while read -r dep; do git grep -q "from '$dep" -- src || echo "UNUSED DEP: $dep"; done
```

Before removing one, check it is not loaded another way: a peer dependency of another package, a CLI
used in `scripts`, a type-only package, something bundled into the Netlify function.

## Never dead, whatever grep says

These are called from outside the TypeScript import graph:

- **Next.js entry points**: `page.tsx`, `layout.tsx`, `route.ts`, `middleware.ts`, `next.config.mjs`.
- **tRPC procedures**: called by the web app through the `AppRouter` type, by name.
- **MCP tools**: called by users' AI assistants, which live outside this repository. Removing a tool
  is a breaking change for every connected client — it is never cleanup.
- **HTTP routes** under `/api`: clients outside the repo may use them. Remove one only after checking
  the web app, `packages/skill`, the docs and `scripts/`, and say so in the PR.
- **Migrations** in `packages/core/src/pg/migrations.ts`: applied history, never deleted.
- **`netlify/functions/*`**, `scripts/*`, `packages/skill/adapters/*`: entry points of their own.

## Cleanup order

1. Imports and variables (no behaviour at stake).
2. Unused private functions.
3. Unused exports.
4. Whole files and dependencies.
5. `pnpm typecheck && pnpm lint && pnpm test` — all green.

**Ask before deleting** whole files, exported APIs, routes or dependencies. Imports and locals can go.

## Report

```
## Dead code
- Removed: <file:line symbol> — <why it was dead>
- Kept, looked dead: <symbol> — <who calls it>
Verification: typecheck ✓ lint ✓ test ✓
```
