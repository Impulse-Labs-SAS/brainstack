// Claude Skills format (Claude Code, Claude Desktop, Claude Chat).
// SKILL.md is the canonical document with the Claude frontmatter envelope.

import type { Adapter, AdapterOutput } from './types.js';

export const claude: Adapter = (source): AdapterOutput[] => {
  const frontmatter = [
    '---',
    `name: ${stringValue(source.frontmatter.name, 'brainstack')}`,
    `description: ${stringValue(source.frontmatter.description, 'Use BrainStack as the shared second brain.')}`,
    '---',
    '',
  ].join('\n');
  return [{ filename: 'SKILL.md', contents: frontmatter + source.body.trimStart() }];
};

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}
