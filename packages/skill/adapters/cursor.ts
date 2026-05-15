// Cursor format. Both .cursorrules (plain text) and cursor/rules/brainstack.mdc
// (with metadata) are emitted so the user can drop either into their project.

import type { Adapter, AdapterOutput } from './types.js';

export const cursor: Adapter = (source): AdapterOutput[] => {
  const mdcFrontmatter = [
    '---',
    'description: BrainStack — shared brain for Cursor.',
    'globs: **/*',
    'alwaysApply: true',
    '---',
    '',
  ].join('\n');

  return [
    { filename: '.cursorrules', contents: source.body.trimStart() },
    {
      filename: 'cursor/rules/brainstack.mdc',
      contents: mdcFrontmatter + source.body.trimStart(),
    },
  ];
};
