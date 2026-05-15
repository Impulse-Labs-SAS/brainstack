// Gemini CLI format. The CLI looks for GEMINI.md at the project root.

import type { Adapter, AdapterOutput } from './types.js';

export const geminiCli: Adapter = (source): AdapterOutput[] => [
  { filename: 'GEMINI.md', contents: source.body.trimStart() },
];
