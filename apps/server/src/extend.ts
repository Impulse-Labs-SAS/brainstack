// @brainstack/server/plugin — what a deployment that extends BrainStack uses.
//
// Everything here is the public contract for plugins: boot an instance with
// `createBrainStack`, and write a `BrainStackPlugin` against the types below.
// Anything not exported from here may change in any release. While BrainStack
// is 0.x, this may change too, but only in a minor version, and only with a
// note in the release; `publicApi.test.ts` makes every change to it show up in
// the pull request that makes it. See docs/Extending.md.

export { createBrainStack, type BrainStack, type CreateBrainStackOptions } from './boot.js';
export { loadConfig, type AppConfig } from './config/env.js';
export type { BrainStackEvent, EventVia } from './events.js';
export type { AuthBindings, Principal } from './http/middleware/auth.js';
export { AppError } from './lib/errors.js';
export type { McpToolContext } from './mcp/context.js';
export {
  PLUGIN_NAME,
  pluginMigrationName,
  type BrainStackPlugin,
  type PluginHttpContext,
  type PluginSetupContext,
  type ToolCall,
} from './plugin.js';
export type { EventInput } from './services/events.js';
export type { PluginTrpc } from './trpc/router.js';
export type { Services } from './wiring.js';
