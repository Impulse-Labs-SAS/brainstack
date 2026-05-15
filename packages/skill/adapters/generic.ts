// Generic system prompt for clients without a dedicated convention.

import type { Adapter, AdapterOutput } from './types.js';

export const generic: Adapter = (source): AdapterOutput[] => [
  { filename: 'SYSTEM_PROMPT.md', contents: source.body.trimStart() },
];
