// Build script for the skill package.
// Reads INSTRUCTIONS.md, parses the YAML-ish frontmatter, runs every adapter,
// and writes the result under dist/<client>/...
//
// The runtime equivalent (read INSTRUCTIONS at request time) lives in
// apps/server/src/mcp/server.ts as the `get_brainstack_guide` tool.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { antigravity } from './adapters/antigravity.js';
import { claude } from './adapters/claude.js';
import { codex } from './adapters/codex.js';
import { cursor } from './adapters/cursor.js';
import { geminiCli } from './adapters/gemini-cli.js';
import { generic } from './adapters/generic.js';
import type { Adapter, SkillSource } from './adapters/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// When running from build/ (compiled JS) the source files live one level up.
const PKG_ROOT = /[\\/](build|dist)$/.test(HERE) ? resolve(HERE, '..') : HERE;

const ADAPTERS: Record<string, Adapter> = {
  claude,
  cursor,
  'gemini-cli': geminiCli,
  codex,
  antigravity,
  generic,
};

export async function build(opts: { sourcePath?: string; outDir?: string } = {}): Promise<void> {
  const sourcePath = opts.sourcePath ?? resolve(PKG_ROOT, 'INSTRUCTIONS.md');
  const outDir = opts.outDir ?? resolve(PKG_ROOT, 'dist');

  const raw = await readFile(sourcePath, 'utf8');
  const { body, frontmatter } = parseFrontmatter(raw);
  const source: SkillSource = { raw, body, frontmatter };

  await rm(outDir, { recursive: true, force: true });
  for (const [client, adapter] of Object.entries(ADAPTERS)) {
    for (const file of adapter(source)) {
      const target = join(outDir, client, file.filename);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, 'utf8');
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[skill] built ${Object.keys(ADAPTERS).length} adapters to ${outDir}`);
}

/** Minimal frontmatter parser. We don't pull gray-matter into this package to
 * keep its dependency tree tiny — the format is constrained to `key: value`. */
function parseFrontmatter(raw: string): { body: string; frontmatter: Record<string, unknown> } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { body: raw, frontmatter: {} };
  const [, head, body] = match;
  const frontmatter: Record<string, unknown> = {};
  for (const line of (head ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    frontmatter[key] = value;
  }
  return { body: body ?? '', frontmatter };
}

// Always run when invoked as a Node script (the only consumer of this file).
// We don't try to detect "main" — module resolution on Windows + ESM makes
// that comparison flaky and there's nothing else loading this file.
void build();
