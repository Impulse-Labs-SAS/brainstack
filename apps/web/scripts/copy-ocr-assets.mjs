// Copies what OCR needs in the browser into public/ocr, so BrainStack serves it
// itself: tesseract.js's worker, its WebAssembly core and the Spanish and English
// language data. Nothing is fetched from a CDN at run time — a self-hosted
// instance works offline, and nobody else learns that a document was read.
//
// Run before `next dev` and `next build` (package.json). public/ocr is not
// committed: it is rebuilt from node_modules, at the versions the lockfile pins.

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'public', 'ocr');
const dir = (pkg) => dirname(require.resolve(`${pkg}/package.json`));

const files = [
  [join(dir('tesseract.js'), 'dist', 'worker.min.js'), 'worker.min.js'],
  // The core comes in builds with and without SIMD; the worker picks one.
  [
    join(dir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js'),
    'tesseract-core-simd-lstm.wasm.js',
  ],
  [join(dir('tesseract.js-core'), 'tesseract-core-lstm.wasm.js'), 'tesseract-core-lstm.wasm.js'],
  // The small integer LSTM models, the ones tesseract.js uses by default.
  [
    join(dir('@tesseract.js-data/spa'), '4.0.0_best_int', 'spa.traineddata.gz'),
    'spa.traineddata.gz',
  ],
  [
    join(dir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'),
    'eng.traineddata.gz',
  ],
];

mkdirSync(target, { recursive: true });
for (const [from, name] of files) copyFileSync(from, join(target, name));
console.log(`[ocr] copied ${files.length} files to public/ocr`);
