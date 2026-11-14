// What a plugin can add to a BrainStack server.
//
// A plugin is optional code a deployment passes to `createBrainStack`: without
// one, BrainStack behaves exactly as it does with none. It adds; it does not
// replace. A plugin cannot take over a tool BrainStack registers, and its
// tools reach a vault only through the same context BrainStack's own tools
// use, so the permission checks in `SharingService` hold for them too.
//
// What a plugin can bring: tables of its own (migrations), set-up that runs
// once at boot with BrainStack's services and database (where it builds its
// own services), MCP tools, a hook after every tool call, HTTP routes and tRPC
// procedures.
//
// A plugin's routes and procedures live under its own name — `/plugins/<name>`
// and `plugins.<name>.*` — so nothing a plugin mounts can answer in place of a
// route BrainStack serves.

import type { PgDb, PgMigration } from '@brainstack/core/pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnyTRPCRouter } from '@trpc/server';
import type { Hono, MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

import type { BrainStackEvent } from './events.js';
import type { AuthBindings } from './http/middleware/auth.js';
import type { McpToolContext } from './mcp/context.js';
import type { PluginTrpc } from './trpc/router.js';
import type { Services } from './wiring.js';

/**
 * What a plugin name may look like. It becomes a URL segment and a tRPC path
 * segment, where a `.` or `/` would split it.
 */
export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** What `setup` is given, once, at boot. */
export interface PluginSetupContext {
  db: PgDb;
  services: Services;
  logger: Logger;
}

/**
 * The name a plugin migration is recorded under in `_brainstack_migrations`.
 * BrainStack's own names carry no prefix, so neither can take the other's
 * place in the ledger, nor can two plugins.
 */
export const pluginMigrationName = (plugin: string, migration: string): string =>
  `plugin:${plugin}:${migration}`;

/**
 * Throws unless every name is well formed and used once. Checked at boot,
 * before anything is mounted under one.
 */
export function assertPluginNames(plugins: readonly { name: string }[]): void {
  const names = new Set<string>();
  for (const { name } of plugins) {
    if (!PLUGIN_NAME.test(name)) {
      throw new Error(`plugin name ${JSON.stringify(name)} must match ${PLUGIN_NAME}`);
    }
    if (names.has(name)) throw new Error(`plugin ${name} is passed twice`);
    names.add(name);
  }
}

/** The plugins' migrations, in order, each under its ledger name. Throws on a repeated name. */
export function pluginMigrations(
  plugins: readonly Pick<BrainStackPlugin, 'name' | 'migrations'>[],
): PgMigration[] {
  return plugins.flatMap((plugin) => {
    const seen = new Set<string>();
    return (plugin.migrations ?? []).map((m) => {
      if (!m.name) throw new Error(`plugin ${plugin.name} has a migration with no name`);
      if (seen.has(m.name)) {
        throw new Error(`plugin ${plugin.name} declares migration ${m.name} twice`);
      }
      seen.add(m.name);
      return { name: pluginMigrationName(plugin.name, m.name), statements: m.statements };
    });
  });
}

/** What a plugin's routes are built with. */
export interface PluginHttpContext {
  services: Services;
  logger: Logger;
  /**
   * Answers 401 unless the caller is signed in — session cookie, API key or
   * OAuth token, as on `/mcp` — and puts them on `c.var.principal`.
   */
  requireAuth: MiddlewareHandler<AuthBindings>;
  /** Puts the caller on `c.var.principal` when there is one, and lets anyone through. */
  optionalAuth: MiddlewareHandler<AuthBindings>;
  /** Whether cookies must be Secure: the instance is served over https. */
  secureCookies: boolean;
  /** Where the web app lives, for redirects back to it. */
  appHome: string;
  /** The public path the plugin's routes answer under, e.g. `/api/plugins/sso`. */
  mountPath: string;
}

/** One finished MCP tool call, as `onToolCall` hears about it. */
export interface ToolCall {
  tool: string;
  /** Who called. Null only for a call that was refused for having no principal. */
  userId: string | null;
  /** The key or OAuth client it called with, when there was one. */
  clientRef: string | null;
  /** The arguments as the tool received them, after validation. */
  args: unknown;
  /** False when the tool answered with an error. */
  ok: boolean;
  ms: number;
}

export interface BrainStackPlugin {
  /** Unique among the plugins a server runs; it names the plugin in logs. */
  name: string;
  /**
   * Schema the plugin needs, applied at boot after BrainStack's own and
   * recorded under `plugin:<name>:<migration>`. The same contract as
   * BrainStack's migrations: ordered, every statement idempotent
   * (`IF NOT EXISTS`), no transaction. Never rename or edit one that shipped.
   * Name the plugin's tables after it (`<name>_…`) and leave BrainStack's
   * tables alone: their shape is not part of this interface.
   */
  migrations?: readonly PgMigration[];
  /**
   * Runs once at boot, after the migrations and before anything else of the
   * plugin's is built: where it creates its own services from BrainStack's
   * and the database. A throw fails the boot.
   *
   * Reach notes through `services.notes` and ask `services.sharing` before
   * acting for a person: authorisation stays there.
   */
  setup?(ctx: PluginSetupContext): void | Promise<void>;
  /**
   * Registers the plugin's MCP tools. Called once per MCP session, after
   * BrainStack's own tools: a name already taken fails at boot.
   */
  mcpTools?(server: McpServer, ctx: McpToolContext): void;
  /**
   * Hears about every MCP tool call once it has answered, BrainStack's and
   * every plugin's. Awaited, so nothing is lost on a runtime that stops after
   * the response; a listener that throws is logged and the call's answer
   * stands.
   */
  onToolCall?(call: ToolCall): void | Promise<void>;
  /**
   * Hears what changed — a note written, moved or deleted, a folder created,
   * a share requested, granted or revoked, a sign-up or sign-in, an API key
   * or OAuth client added — with whose vault it is, who did it and through
   * what (`web`, `api`, `mcp`, `plugin`, `system`). Called after the change
   * has landed, and awaited, so nothing is lost on a runtime that stops after
   * the response. A listener that throws is logged and the change stands.
   */
  onEvent?(event: BrainStackEvent): void | Promise<void>;
  /**
   * HTTP routes, served under `/plugins/<name>`: a route `/callback` answers
   * at `<API prefix>/plugins/<name>/callback`. Built once, at boot.
   *
   * Every request is rate limited per client address before it reaches the
   * plugin, and bodies are capped as on BrainStack's own small routes. Nothing
   * is authenticated for it: a route that needs a caller uses `requireAuth`.
   */
  routes?(ctx: PluginHttpContext): Hono<AuthBindings>;
  /**
   * tRPC procedures, served as `plugins.<name>.*` next to BrainStack's own.
   * Build them with the procedures given, so they get the same context,
   * error mapping and checks: `protectedProcedure` refuses a caller without
   * an account and a read-only key's mutations, `sessionProcedure` anything
   * but a signed-in person.
   */
  trpc?(t: PluginTrpc): AnyTRPCRouter;
}
