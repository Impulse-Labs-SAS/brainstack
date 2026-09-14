---
name: clean-code
description: "Concrete clean-code heuristics for BrainStack (TypeScript: Hono, tRPC, Drizzle, Next.js, React). Actionable thresholds, not platitudes. Use when writing new code, reviewing a diff before a pull request, or refactoring a file that already feels heavy."
---

# Clean Code — BrainStack

Code is read far more often than it is written — and in an open source project, most of its readers
are people you will never meet, arriving without context. Optimise for them.

## How to use this skill

1. Pick the scope: a diff (default: uncommitted changes), a file, a module.
2. Run through the checks below that apply.
3. For each finding: name it, cite `file:line`, and propose the concrete fix. Do not rewrite blindly.
4. **Do not over-engineer** (see Anti-patterns). Cleaning is removing, not adding layers.

The architecture rules in `CLAUDE.md` come first. Everything here applies inside them.

## Universal

Thresholds are triggers to look again, not laws.

- **Function over ~40 lines, or more than 3 levels of nesting** → extract named functions; flatten with
  early returns.
- **More than 3–4 positional parameters** → one options object. A long positional list is how a
  swapped argument compiles and breaks at runtime.
- **Boolean positional arguments** (`list(path, true, false)`) → options object with named fields.
- **Names say what, not how.** No `data`, `tmp`, `helper`, `manager`, `utils2`.
- **Repeated magic strings or numbers** → a named constant. Paths agreed between layers live in one
  place (`apps/server/src/config/api.ts` is the model).
- **Comments explain why**, never what. The codebase's comments describe the failure a line prevents;
  keep that standard.
- **Duplication**: two similar blocks may be coincidence; three is a pattern — extract then.
- **Dead code** is deleted, not commented out. For a sweep, use the `dead-code` skill.

## Server (`apps/server`, `packages/core`)

- **Await every async call** — `.claude/rules/await-the-store.md`. A service or store call without
  `await` returns `{}`, skips its `catch`, and can crash the process.
- **Services** (`services/`) never import Hono, tRPC or the MCP SDK. Something with permission
  consequences is reported through a callback wired in `wiring.ts`, not by importing
  `SharingService`.
- **Routes, tRPC procedures and MCP tools are thin**: validate input with zod, resolve the owner, ask
  `SharingService`, call a service, map the result. Business rules in a route are a finding.
- **Authorisation lives in `SharingService` only.** A permission check written anywhere else is a
  finding even when it is correct — the next change will not update it.
- **Errors**: throw `AppError` with a code and status; never return `null` or `-1` to mean failure,
  never swallow an error in an empty `catch`.
- **User input reaching a path** goes through `normalizeNoteKey` / `normalizeRelativePath`.
- **SQL**: Drizzle's query builder by default. Raw `sql` fragments only for what the builder cannot
  express, always parameterised — never string concatenation. Nothing that only one Postgres provider
  accepts.
- **Tests** run against real Postgres (PGlite), not mocks of the database. One behaviour per test;
  the test name states the behaviour. A route test asserts status and body.

## Web (`apps/web`)

- **Components over ~150 lines**, or doing fetching + state + layout + logic at once → split. Data and
  state in a hook, presentation in the component.
- **Components come from `react-aria-components` and the tokens in `src/styles/globals.css`.** Never
  shadcn; no hard-coded colours where a token exists.
- **Data goes through tRPC + TanStack Query** (`src/lib/trpc.ts`), not ad-hoc `fetch`, except the auth
  endpoints that are plain REST.
- **No `any`**, and `as` only with a comment explaining why the type system cannot know.
- **`useEffect` does one thing, with correct dependencies.** An effect that syncs state which could be
  derived during render is deleted, not fixed.
- **Loading and error states are rendered.** A query whose consumer never looks at its pending or
  error state shows stale or empty data with no explanation.
- **Accessibility is not optional**: interactive elements are real buttons/links with accessible
  names; react-aria gives keyboard support only when it is used as intended.

## Anti-patterns — what not to do when "cleaning"

- **Abstractions for a second case that does not exist.** YAGNI.
- **Scope creep**: a cleanup touching 40 files inside a feature branch → its own branch and PR.
- **Dogmatic DRY**: merging two things that look alike today but change for different reasons
  creates coupling.
- **Refactoring without tests**: write the test that pins the behaviour first.

## Mechanical checks come before judgement

A change that does not pass these is not clean — it is broken:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Related

- `dead-code` skill — sweeping unused code.
- `/code-review` and `/simplify` — review a specific diff; this skill is the judgement they apply.
- `.claude/agents/code-reviewer.md` — the project checklist for reviews.
