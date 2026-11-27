// MCP server setup. One McpServer per session, with BrainStack's tools
// registered from their modules (`tools/`), then any tools a plugin brings.
//
// What the tools share — who is calling, whose vault a path is in, the
// permission checks and how a write runs — is built once in `context.ts`, and
// every module gets the same one.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger } from 'pino';

import type { AuthService } from '../services/AuthService.js';
import type { CrawlHistoryService } from '../services/CrawlHistoryService.js';
import type { CrossOwnerReader } from '../services/CrossOwnerReader.js';
import type { MentionService } from '../services/MentionService.js';
import type { NoteService } from '../services/NoteService.js';
import type { SearchService } from '../services/SearchService.js';
import type { SharingService } from '../services/SharingService.js';

import type { BrainStackPlugin, ToolCall } from '../plugin.js';

import { buildToolContext, type McpToolContext } from './context.js';
import { SERVER_INSTRUCTIONS } from './guide.generated.js';
import { attachNotices } from './notices.js';
import { registerGuideTools } from './tools/guide.js';
import { registerMentionTools } from './tools/mentions.js';
import { registerReadTools } from './tools/read.js';
import { registerSharingTools } from './tools/sharing.js';
import { registerWriteTools } from './tools/write.js';

export interface McpPrincipal {
  /** The authenticated user calling the MCP server. */
  userId: string;
  /**
   * The API key it called with — `oauth:<clientId>` for a client of this
   * server's OAuth provider. Only used to name the assistant in the crawl history.
   */
  clientRef?: string;
  /** A key without `notes:write`: every tool that changes something refuses. */
  readOnly?: boolean;
}

export interface BuildMcpServerOptions {
  notes: NoteService;
  search: SearchService;
  sharing: SharingService;
  /** Reads across an ownership boundary, masking what the grant does not cover. */
  crossOwner: CrossOwnerReader;
  /** Resolves the email a caller unshares into an account. */
  auth: AuthService;
  /** Where `gather_context` leaves each crawl for the Sentinel view to replay. */
  crawls: CrawlHistoryService;
  /**
   * `@username` mentions. With it, every answer carries the caller's pending
   * mentions and `set_username` / `list_mentions` are registered.
   */
  mentions?: MentionService;
  logger: Logger;
  /**
   * Who is calling. Every tool that touches a vault refuses to run without
   * one: there is no vault that belongs to nobody.
   */
  principal?: McpPrincipal | null;
  /** Plugins whose tools and listeners this server adds, in order. */
  plugins?: readonly BrainStackPlugin[];
  /**
   * Where the web app answers, for links an assistant hands the user — the
   * page that approves a share it asked for. Without it the tool names the
   * page instead of linking it.
   */
  appOrigin?: string;
}

export function buildMcpServer(opts: BuildMcpServerOptions): McpServer {
  // `instructions` reach the assistant on connect, before any tool is called,
  // so the habits that matter most hold even where nobody installed the skill.
  const server = new McpServer(
    { name: 'brainstack', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const ctx: McpToolContext = buildToolContext(opts);
  const plugins = opts.plugins ?? [];

  const listeners = plugins.filter((p) => p.onToolCall);
  if (listeners.length > 0) reportToolCalls(server, opts, listeners);
  // Wrapped first, so the notices ride on plugin tools' answers too.
  if (opts.mentions && opts.principal?.userId) {
    attachNotices(server, opts.mentions, opts.principal.userId, opts.logger);
  }

  registerReadTools(server, ctx);
  registerWriteTools(server, ctx, { appOrigin: opts.appOrigin });
  registerSharingTools(server, ctx, { appOrigin: opts.appOrigin });
  registerGuideTools(server, ctx);
  if (opts.mentions) registerMentionTools(server, ctx, opts.mentions);
  for (const plugin of plugins) plugin.mcpTools?.(server, ctx);

  return server;
}

/**
 * Wraps every tool registered from here on so each call, once answered, is
 * reported to the plugins listening. The answer goes back unchanged, and a
 * listener that throws is logged rather than turning a done call into an error.
 */
function reportToolCalls(
  server: McpServer,
  opts: BuildMcpServerOptions,
  listeners: readonly BrainStackPlugin[],
): void {
  const register = server.registerTool.bind(server);
  type Callback = (...args: unknown[]) => unknown;
  const wrapped = (name: string, config: unknown, cb: Callback) =>
    register(
      name,
      config as never,
      (async (...args: unknown[]) => {
        const started = Date.now();
        const result = await cb(...args);
        const call: ToolCall = {
          tool: name,
          userId: opts.principal?.userId ?? null,
          clientRef: opts.principal?.clientRef ?? null,
          // A tool with an input schema gets its arguments first; one without
          // gets only the request context, which is not the caller's input.
          args: args.length > 1 ? args[0] : undefined,
          ok: (result as { isError?: boolean } | undefined)?.isError !== true,
          ms: Date.now() - started,
        };
        for (const plugin of listeners) {
          try {
            await plugin.onToolCall!(call);
          } catch (err) {
            opts.logger.error({ err, plugin: plugin.name, tool: name }, 'onToolCall failed');
          }
        }
        return result;
      }) as never,
    );
  server.registerTool = wrapped as typeof server.registerTool;
}
