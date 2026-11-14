// Events: what the services report, with who did it and through what.
//
// The services say what changed and in whose vault (`services/events.ts`).
// Who did it is the request's business: a request runs inside `requestScope`,
// and an event emitted anywhere beneath it — a tRPC procedure, an MCP tool,
// the batch they share — is stamped with that request's caller. Nothing has to
// pass the caller down through every service call to get there.
//
// Only built when some plugin listens. Without one, no service is handed an
// `emit` and no request runs in a scope.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Context, MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

import type { AuthBindings, Principal } from './http/middleware/auth.js';
import type { EmitEvent, EventInput } from './services/events.js';

/** Through what an event was caused. */
export type EventVia = 'web' | 'api' | 'mcp' | 'plugin' | 'system';

/** One event, as a plugin's `onEvent` hears it. */
export type BrainStackEvent = EventInput & {
  /**
   * Who did it: the signed-in caller, the account a sign-up created, or null
   * for what nobody asked for (boot, a command, an unauthenticated request).
   * Not the owner: a note added to a shared folder is the owner's, written by
   * someone else.
   */
  actorId: string | null;
  via: EventVia;
  at: number;
};

export type EventListener = (event: BrainStackEvent) => void | Promise<void>;

interface RequestFacts {
  c: Context<AuthBindings>;
}

const scope = new AsyncLocalStorage<RequestFacts>();

/** Runs the rest of the request where events can see who is calling. */
export const requestScope: MiddlewareHandler<AuthBindings> = (c, next) =>
  scope.run({ c }, () => next());

/** What a request says about its caller, read when the event happens. */
function callerOf(facts: RequestFacts | undefined): { actorId: string | null; via: EventVia } {
  if (!facts) return { actorId: null, via: 'system' };
  const principal = facts.c.get('principal') as Principal | undefined;
  const path = facts.c.req.path;
  const via: EventVia = /\/mcp(\/|$)/.test(path)
    ? 'mcp'
    : /\/plugins\//.test(path)
      ? 'plugin'
      : principal?.kind === 'apiKey'
        ? 'api'
        : 'web';
  return { actorId: principal?.user.id ?? null, via };
}

/**
 * The `emit` services are handed: stamps each event and hands it to every
 * listener in turn, after the write that caused it. A listener that throws is
 * logged; the write and its answer stand.
 */
export function buildEventBus(
  listeners: readonly { name: string; listen: EventListener }[],
  logger: Logger,
): EmitEvent {
  return async (input) => {
    const caller = callerOf(scope.getStore());
    const event = {
      ...input,
      actorId: input.actorId !== undefined ? input.actorId : caller.actorId,
      via: caller.via,
      at: Date.now(),
    } as BrainStackEvent;
    for (const { name, listen } of listeners) {
      try {
        await listen(event);
      } catch (err) {
        logger.error({ err, plugin: name, event: event.type }, 'onEvent failed');
      }
    }
  };
}
