---
paths:
  - "apps/server/src/**/*.ts"
  - "netlify/**/*.mts"
  - "packages/core/src/**/*.ts"
---

# Await the Store

Every service method that touches the database is `async`. A call to one that is not awaited is a bug,
whatever it looks like at the call site.

## What an unawaited call does

Nothing fails loudly, which is what makes it expensive:

- **Returned values serialize as `{}`.** `c.json({ key: service.create(...) })` sends an empty object
  with a 200.
- **Errors skip the `catch`.** A `try` around an unawaited call catches nothing; the rejection is
  unhandled, and an unhandled rejection **terminates the Node process** — one request takes the
  server down.
- **The response can go out before the write.** On a serverless runtime nothing is guaranteed to run
  after the response is sent, so a logout may leave the session valid.

All three shipped at once in `http/routes/auth.ts` when the store moved from synchronous sqlite to
async Postgres: the call sites compiled unchanged, because a route handler that returns a
`Promise<Response>` accepts a body containing a `Promise` just as well as one containing a value.

## The rule

- `await` every call into a service, the store, or anything returning a `Promise`.
- A handler that calls the store is `async`. A synchronous handler that calls a service is the smell.
- Fire-and-forget is never implicit. If something genuinely must not block the response, it is written
  as `void task().catch((err) => logger.error({ err }, '...'))`, with a comment saying why it may
  be lost.
- When a function changes from sync to async, grep every caller in the same change — the compiler will
  not find them for you.

## Tests catch it when they assert the response

A route test that checks `res.status` and the body fails on all three symptoms above. A service test
does not: the service is correct; the caller is not.
