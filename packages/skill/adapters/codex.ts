// Codex (OpenAI) format. Uses AGENTS.md, the convention shared with several
// other agent clients.

import type { Adapter, AdapterOutput } from './types.js';

export const codex: Adapter = (source): AdapterOutput[] => [
  { filename: 'AGENTS.md', contents: source.body.trimStart() },
];
