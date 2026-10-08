import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_SERVER_INSTRUCTIONS, renderGuideModule, serverInstructions } from './guide.js';
import { SERVER_INSTRUCTIONS } from './guide.generated.js';

const HERE = import.meta.dirname;
const read = (path: string) => readFile(resolve(HERE, path), 'utf8');

describe('the guide the server carries', () => {
  it('matches INSTRUCTIONS.md — after editing it, run `pnpm --filter @brainstack/server guide`', async () => {
    const markdown = await read('../../../../packages/skill/INSTRUCTIONS.md');
    const generated = (await read('guide.generated.ts')).replace(/\r\n/g, '\n');
    expect(generated).toBe(renderGuideModule(markdown));
  });

  it('sends a summary short enough that no client cuts it', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).not.toContain('<!--');
  });

  it('takes the summary from between its markers, and refuses a guide without them', () => {
    const md =
      'before\n<!-- server-instructions -->\n\n## In short\n\n- one\n\n<!-- /server-instructions -->\nafter';
    expect(serverInstructions(md)).toBe('## In short\n\n- one');
    expect(() => serverInstructions('no block here')).toThrow(/server-instructions/);
  });

  it('keeps backticks, backslashes and template markers literal', () => {
    const md = '<!-- server-instructions -->`a` \\n ${b}<!-- /server-instructions -->';
    const module = renderGuideModule(md);
    const body = module.slice(module.indexOf('export const GUIDE = '));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const evaluate = new Function(body.replace(/export const (\w+) =/g, 'this.$1 =')) as () => void;
    const out: { GUIDE?: string; SERVER_INSTRUCTIONS?: string } = {};
    evaluate.call(out);
    expect(out.GUIDE).toBe(md);
    expect(out.SERVER_INSTRUCTIONS).toBe('`a` \\n ${b}');
  });
});
