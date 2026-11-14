# Extending BrainStack with plugins

A plugin is code a deployment passes to `createBrainStack` to add to what BrainStack does: tools for
assistants, HTTP routes, tRPC procedures, tables of its own, and listeners for what happens in the
instance. A plugin can add things but never replace them. Without plugins, BrainStack behaves exactly as
it does today, and the `docker compose` setup needs none.

Plugins are for code that lives outside this repository. A feature everyone should have belongs in
BrainStack itself.

## The contract

Everything a plugin may rely on is exported from `@brainstack/server/plugin` (`apps/server/src/extend.ts`).
Anything you reach by any other path, such as another module of `apps/server/src` or the shape of
BrainStack's own tables, can change in any release without notice.

While BrainStack is `0.x`, the contract can change too, but only in a minor release, and the release
notes say so. `apps/server/src/publicApi.test.ts` writes the whole contract out to
`publicApi.snapshot.txt`, so a change to the contract shows up in the diff of the pull request that
makes it. After a deliberate change, update the snapshot with
`pnpm --filter @brainstack/server test -- -u`.

Build the server (`pnpm --filter @brainstack/server build`) before importing `@brainstack/server/plugin`
from another package. Like `@brainstack/core`, it resolves to compiled output.

## Booting an instance with plugins

```ts
import { serve } from '@hono/node-server';
import pino from 'pino';
import { createBrainStack, loadConfig } from '@brainstack/server/plugin';

import { auditPlugin } from './audit.js';

const brain = await createBrainStack({
  config: loadConfig(),
  logger: pino(),
  plugins: [auditPlugin],
});
serve({ fetch: brain.app.fetch, port: 3000 });
```

In tests, pass `database: { db, close }` with an in-process Postgres (PGlite) instead of a
`DATABASE_URL`. BrainStack's own tests do this in `boot.test.ts` and `events.test.ts`.

## What a plugin can bring

```ts
import type { BrainStackPlugin } from '@brainstack/server/plugin';

export const auditPlugin: BrainStackPlugin = {
  name: 'audit', // lowercase, digits and dashes; unique; checked at boot
  migrations: [
    {
      name: '0001_entries',
      statements: [
        `CREATE TABLE IF NOT EXISTS audit_entries (
           id BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, actor_id TEXT, at BIGINT NOT NULL)`,
      ],
    },
  ],
  setup({ db, services, logger }) {
    /* build the plugin's own services here */
  },
  onEvent(event) {
    /* note.created, share.granted, auth.signed_in, ... */
  },
  mcpTools(server, ctx) {
    /* server.registerTool(...) */
  },
  routes(ctx) {
    /* return a Hono app */
  },
  trpc(t) {
    /* return t.router({ ... }) */
  },
};
```

Each member, in the order BrainStack runs it at boot:

| Member | When | What it gets | Where it shows up |
|---|---|---|---|
| `migrations` | After BrainStack's own migrations | Nothing | Recorded as `plugin:<name>:<migration>` in `_brainstack_migrations` |
| `setup` | Once, after the migrations | `db`, `services`, `logger` | Wherever the plugin keeps what it builds |
| `mcpTools` | Once per MCP session, after BrainStack's tools | The MCP server and the same context BrainStack's tools use | Next to BrainStack's tools. A name already taken fails the boot |
| `routes` | Once | `services`, `logger`, `requireAuth`, `optionalAuth`, `secureCookies`, `appHome`, `mountPath` | `<API prefix>/plugins/<name>/…` |
| `trpc` | Once | BrainStack's `router`, `publicProcedure`, `protectedProcedure` and `sessionProcedure` | `plugins.<name>.*` |
| `onToolCall` | After every MCP tool call | Tool, caller, arguments, outcome, duration | |
| `onEvent` | After every change lands | The event, its vault, who did it and through what | |

### Migrations

The contract is the same as for BrainStack's own migrations. They run in order, every statement is
idempotent (`IF NOT EXISTS`), and nothing runs in a transaction, because the Neon HTTP driver has
none. Never edit or rename a migration that has shipped: add a new one. Name your tables after the
plugin (`audit_…`) and leave BrainStack's tables alone, because their shape is not part of the contract.

### Routes and procedures

Everything a plugin mounts lives under its own name, so it cannot answer in place of a BrainStack
route. Every request to `/plugins/*` is rate limited per client address, and its body is capped like
BrainStack's small routes, before it reaches the plugin. Nothing is authenticated for you: a route that
needs a caller uses `requireAuth`, which accepts what `/mcp` accepts (session cookie, API key or OAuth
token) and puts the caller on `c.var.principal`.

Procedures built with `protectedProcedure` refuse anonymous callers and refuse a read-only key's
mutations. Procedures built with `sessionProcedure` refuse anything but a signed-in person. The web
app's `AppRouter` type does not include plugin procedures, so a plugin's client knows its own.

### Events

| Event | Fields |
|---|---|
| `note.created`, `note.updated` | `ownerId`, `path` |
| `note.moved` | `ownerId`, `from`, `to`, `toOwnerId` when it moved to another vault |
| `note.deleted` | `ownerId`, `paths`, `folders` |
| `folder.created` | `ownerId`, `path` |
| `share.requested` | `ownerId`, `path`, `email`, `permission` |
| `share.granted` | `ownerId`, `path`, `userId`, `permission` |
| `share.revoked` | `ownerId`, `path`, `userId` |
| `auth.signed_up` | `userId`, `method` |
| `auth.signed_in` | `userId` |
| `api_key.created` | `userId`, `keyId`, `name`, `scopes` |
| `oauth_client.connected` | `userId`, `clientId` |

Every event also carries `actorId`, `via` (`web`, `api`, `mcp`, `plugin` or `system`) and `at`.
`ownerId` is whose vault it is, and `actorId` is who did it. They differ when someone writes into a
folder that was shared with them.

Listeners run after the change has landed, and they are awaited. A listener that throws is logged,
and the change stands. A listener cannot stop or alter a change.

## What a plugin must not do

These are BrainStack's own rules (see `CLAUDE.md`), and they hold for plugins too:

- **Authorisation lives in `SharingService`.** Before reading or writing for a person, ask
  `services.sharing` (`assertCanRead`, `assertCanWrite`), or go through the MCP context, which asks
  for you. A plugin that reaches a vault any other way bypasses the permission model.
- **The owner is not the caller.** Service methods take the vault's owner id.
- **Note logic belongs to Sentinel** (`@brainstack/core/sentinel`). If a plugin needs to change how
  notes are ranked, placed or edited, that is a change to BrainStack.
- **A failure the caller did not cause tells them nothing.** Throw an `AppError` for refusals, and
  let anything else be logged.
