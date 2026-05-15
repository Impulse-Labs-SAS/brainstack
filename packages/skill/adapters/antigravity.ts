// Antigravity (Google) format. Same AGENTS.md convention as Codex.

import type { Adapter, AdapterOutput } from './types.js';

export const antigravity: Adapter = (source): AdapterOutput[] => [
  { filename: 'AGENTS.md', contents: source.body.trimStart() },
];
