// The BrainStack guide, served whole.

import { GUIDE } from '../guide.generated.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TEXT } from '../shared.js';
import type { McpToolContext } from '../context.js';

export function registerGuideTools(server: McpServer, _ctx: McpToolContext): void {
  server.registerTool(
    'get_brainstack_guide',
    {
      title: 'BrainStack guide for AI assistants',
      description:
        'Return the canonical BrainStack instructions for AI assistants (Skill content).',
      inputSchema: {},
    },
    () => TEXT(GUIDE),
  );
}
