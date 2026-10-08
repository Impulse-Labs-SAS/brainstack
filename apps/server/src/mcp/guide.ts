// The assistant instructions, as the MCP server carries them.
//
// `packages/skill/INSTRUCTIONS.md` is the one source. The server cannot read it
// from disk where it matters most: a Netlify function is a bundle, and the file
// is not in it (see netlify.toml). So it travels as code — `guide.generated.ts`,
// written from the Markdown by `pnpm --filter @brainstack/server guide` — and
// `guide.test.ts` fails whenever the two disagree.

const OPEN = '<!-- server-instructions -->';
const CLOSE = '<!-- /server-instructions -->';

/**
 * Most clients truncate a server's `instructions` around 2,000 characters, and
 * a summary cut mid-rule is worse than none. The test holds the block to this.
 */
export const MAX_SERVER_INSTRUCTIONS = 2000;

/** The marked summary in INSTRUCTIONS.md: what every connection is told. */
export function serverInstructions(markdown: string): string {
  const start = markdown.indexOf(OPEN);
  const end = markdown.indexOf(CLOSE);
  if (start < 0 || end < start) {
    throw new Error(`INSTRUCTIONS.md has no ${OPEN} … ${CLOSE} block`);
  }
  return markdown.slice(start + OPEN.length, end).trim();
}

/** `guide.generated.ts`, as written from INSTRUCTIONS.md. */
export function renderGuideModule(source: string): string {
  // A Windows checkout may hand the Markdown over with CRLF; the guide is the
  // same guide either way, and the generated file should not depend on it.
  const markdown = source.replace(/\r\n/g, '\n');
  return [
    '// Generated from packages/skill/INSTRUCTIONS.md by',
    '// `pnpm --filter @brainstack/server guide`. Do not edit: edit the Markdown.',
    '',
    '/** The whole guide, as `get_brainstack_guide` returns it. */',
    `export const GUIDE = ${literal(markdown)};`,
    '',
    '/** The summary every MCP connection receives as the server `instructions`. */',
    `export const SERVER_INSTRUCTIONS = ${literal(serverInstructions(markdown))};`,
    '',
  ].join('\n');
}

/** A template literal holding `text` exactly, line breaks kept for review. */
function literal(text: string): string {
  return '`' + text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}
