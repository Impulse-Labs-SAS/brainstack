// What a plugin can add to a BrainStack server.
//
// A plugin is optional code a deployment passes to `createBrainStack`: without
// one, BrainStack behaves exactly as it does with none. It adds; it does not
// replace. A plugin cannot take over a tool BrainStack registers, and its
// tools reach a vault only through the same context BrainStack's own tools
// use, so the permission checks in `SharingService` hold for them too.
//
// This is the start of the interface: MCP tools and a hook after every tool
// call. HTTP routes, services and migrations come next, each in its own change.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpToolContext } from './mcp/context.js';

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
}
