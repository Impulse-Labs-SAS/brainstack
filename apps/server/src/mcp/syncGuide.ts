// Rewrites guide.generated.ts from packages/skill/INSTRUCTIONS.md.
// Run after editing the Markdown: `pnpm --filter @brainstack/server guide`.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderGuideModule } from './guide.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '../../../../packages/skill/INSTRUCTIONS.md');
const TARGET = resolve(HERE, 'guide.generated.ts');

await writeFile(TARGET, renderGuideModule(await readFile(SOURCE, 'utf8')), 'utf8');
// eslint-disable-next-line no-console
console.log(`[guide] wrote ${TARGET}`);
