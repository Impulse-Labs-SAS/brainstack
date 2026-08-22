// Bundles netlify/functions the way Netlify does, then checks the result.
//
// Written after six deploys spent discovering, one at a time, that a function
// can build cleanly and still be dead on arrival: exported as CommonJS so the
// runtime cannot find it, or missing a dependency the bundler skipped. Both
// failures are visible here, before anything is uploaded.
//
//   node scripts/check-functions.mjs
//
// Exits non-zero with a description of what is wrong.

import { rm, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { spawn } from 'node:child_process';
import { builtinModules } from 'node:module';

import { zipFunctions } from '@netlify/zip-it-and-ship-it';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'netlify', 'functions');
const OUT = join(ROOT, '.netlify-check');

/** Node ships these; they are never missing from a bundle. */
const BUILTINS = new Set(builtinModules);

/** Netlify's own runtime looks for this. A CommonJS emit does not have it. */
const V2_MARKER = /export\s*\{[^}]*\bas default\b|export\s+default\b/;

async function main() {
  await rm(OUT, { recursive: true, force: true });

  console.log('empaquetando netlify/functions ...\n');
  /*
   * `zip` y no `none`. Con `none` el bundler crea symlinks reales para las
   * dependencias del workspace, y Windows los prohíbe sin permisos de
   * administrador: el chequeo se caía antes de chequear nada. Dentro del zip
   * son entradas, no llamadas al sistema de archivos.
   */
  const results = await zipFunctions(SRC, OUT, {
    archiveFormat: 'zip',
    basePath: ROOT,
    repositoryRoot: ROOT,
  });

  if (results.length === 0) fail('no se empaquetó ninguna función');

  const problems = [];

  for (const fn of results) {
    console.log(`── ${fn.name}`);
    console.log(`   runtime           ${fn.runtime}`);
    console.log(`   version           ${fn.runtimeAPIVersion ?? '(sin declarar)'}`);
    console.log(`   tamaño            ${Math.round((await stat(fn.path)).size / 1e4) / 100} MB`);

    const unpacked = join(OUT, `${fn.name}-abierto`);
    await rm(unpacked, { recursive: true, force: true });
    await unzip(fn.path, unpacked);

    if (fn.runtimeAPIVersion !== 2) {
      problems.push(
        `${fn.name}: empaquetada como v${fn.runtimeAPIVersion ?? 1}. ` +
          'El runtime va a buscar un export llamado `handler` y responder 502.',
      );
    }

    const entry = await findEntry(unpacked, fn.name);
    if (!entry) {
      problems.push(`${fn.name}: no encontré el archivo de entrada en el bundle`);
      continue;
    }

    const code = await readFile(entry, 'utf8');
    console.log(`   entrada           ${entry.slice(ROOT.length + 1)}`);

    if (!V2_MARKER.test(code)) {
      problems.push(
        `${fn.name}: el bundle no expone un export default. ` +
          'Es lo que produce "D.handler is not a function".',
      );
    }

    // Un import que quedó afuera muere en runtime, no al empaquetar.
    const externos = [...code.matchAll(/^\s*(?:import|export)[^;]*?from\s*["']([^"'.][^"']*)["']/gm)]
      .map((m) => m[1])
      .filter((mod) => !mod.startsWith('node:') && !BUILTINS.has(mod.split('/')[0]));
    const unicos = [...new Set(externos)];
    if (unicos.length > 0) {
      console.log(`   imports externos  ${unicos.join(', ')}`);
      for (const mod of unicos) {
        const pkg = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
        const enBundle = await exists(join(unpacked, 'node_modules', pkg));
        if (!enBundle) {
          problems.push(
            `${fn.name}: importa "${mod}" y no está en el bundle. ` +
              'En runtime esto es ERR_MODULE_NOT_FOUND.',
          );
        }
      }
    } else {
      console.log('   imports externos  ninguno (todo inline)');
    }
    console.log();
  }

  if (problems.length > 0) {
    console.error('PROBLEMAS:\n');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    process.exit(1);
  }

  console.log('Las funciones se empaquetan como v2, exportan default y no les falta nada.');
  await rm(OUT, { recursive: true, force: true });
}

function unzip(zipPath, dest) {
  return new Promise((ok, err) => {
    const p = spawn('unzip', ['-q', '-o', zipPath, '-d', dest], { stdio: 'inherit' });
    p.on('close', (code) => (code === 0 ? ok() : err(new Error(`unzip salió con ${code}`))));
    p.on('error', err);
  });
}

/**
 * The function's own compiled file, not Netlify's wrapper.
 *
 * The bundle root holds `___netlify-entry-point.mjs` and a minified bootstrap;
 * the code that was written lives under netlify/functions/. Checking the
 * wrapper instead reports on Netlify's code, which is always fine and says
 * nothing about ours.
 */
async function findEntry(dir, name) {
  for (const candidate of [
    join('netlify', 'functions', `${name}.mjs`),
    join('netlify', 'functions', `${name}.js`),
    `${name}.mjs`,
    `${name}.js`,
  ]) {
    const p = join(dir, candidate);
    if (await exists(p)) return p;
  }
  return null;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

await main();
