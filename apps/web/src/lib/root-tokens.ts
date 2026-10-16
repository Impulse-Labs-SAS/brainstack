// The design tokens as globals.css writes them, read from the file itself: what the tests hold
// the tokens to, and the canvas's copies of them. It reads the disk, so only tests import it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every custom property of the :root block in globals.css, as written. */
export function rootTokens(): Map<string, string> {
  const css = readFileSync(
    fileURLToPath(new URL('../styles/globals.css', import.meta.url)),
    'utf8',
  );
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
  const tokens = new Map<string, string>();
  for (const m of root.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens.set(m[1]!, m[2]!.trim());
  }
  return tokens;
}
