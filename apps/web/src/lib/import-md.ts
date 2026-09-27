// Importar archivos .md del disco como notas.
//
// Lógica pura, sin React y sin tRPC: quien la usa le inyecta la función que
// crea la nota, así que se puede probar entera sin levantar nada.
//
// Sobre la sanitización: la barrera de verdad es `normalizeNoteKey` de
// `packages/core/src/paths.ts`, que el store aplica en cada create. Aquí se
// repiten sus reglas en lugar de importarlas porque el entrypoint de
// `@brainstack/core` arrastra gray-matter, remark y drizzle, que no pintan nada
// en un bundle de navegador. Esto es la red de seguridad de delante: recorta el
// nombre a algo sensato y falla el archivo — no el lote — cuando no queda nada.

const MARKDOWN_EXT = /\.(md|markdown)$/i;

/** Bytes nulos y de control: invisibles en la UI, y un `\0` parte el path abajo. */
function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** Un archivo del disco, reducido a lo que aquí importa. */
export interface ImportableFile {
  name: string;
  text(): Promise<string>;
}

export interface ImportSummary {
  created: string[];
  failed: { name: string; error: string }[];
}

/** Lo que crea la nota de verdad. En la app, la mutación `notes.create`. */
export type CreateNoteFn = (input: { path: string; content: string }) => Promise<unknown>;

export function isMarkdownFile(file: { name: string }): boolean {
  return MARKDOWN_EXT.test(file.name);
}

/**
 * El nombre de nota que sale de un archivo: sólo el basename, sin extensión y
 * sin nada que pueda salirse de la carpeta destino.
 *
 * `"../../etc/passwd.md"` -> `"passwd"`. Lanza si no queda nombre.
 */
export function noteNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const clean = base
    .split('')
    .filter((ch) => !isControlChar(ch))
    .join('')
    .replace(MARKDOWN_EXT, '')
    .trim();
  // `.` y `..` no son nombres, son movimientos.
  if (clean === '' || clean === '.' || clean === '..') {
    throw new Error(`file name has no note name in it: ${fileName}`);
  }
  return clean;
}

/**
 * El path destino de una nota importada, con la misma forma que usa "New note"
 * en el árbol: el nombre cuelga de la carpeta sobre la que se importó.
 */
export function importPathFor(targetPath: string, fileName: string): string {
  const name = noteNameFromFile(fileName);
  return targetPath === '' ? `${name}.md` : `${targetPath}/${name}.md`;
}

/**
 * Crea una nota por archivo, de una en una.
 *
 * Secuencial a propósito: una ráfaga de creates concurrentes sobre el mismo
 * árbol no gana nada y complica leer qué falló. Un archivo que falla —nombre
 * duplicado, sin permiso, nombre imposible— se anota y el lote sigue.
 */
export async function importMarkdownFiles(
  files: readonly ImportableFile[],
  targetPath: string,
  createNote: CreateNoteFn,
): Promise<ImportSummary> {
  const summary: ImportSummary = { created: [], failed: [] };

  for (const file of files) {
    let path: string;
    try {
      path = importPathFor(targetPath, file.name);
    } catch (err) {
      summary.failed.push({ name: file.name, error: (err as Error).message });
      continue;
    }
    try {
      // El contenido va tal cual, front-matter incluido: el parser de
      // packages/core ya sabe leerlo.
      const content = await file.text();
      await createNote({ path, content });
      summary.created.push(path);
    } catch (err) {
      summary.failed.push({ name: file.name, error: (err as Error).message });
    }
  }

  return summary;
}

/** El texto de un solo toast que cuenta cómo fue el lote. */
export function summarizeImport(summary: ImportSummary): { kind: 'info' | 'error'; text: string } {
  const total = summary.created.length + summary.failed.length;
  if (summary.failed.length === 0) {
    return { kind: 'info', text: `imported ${total} note${total === 1 ? '' : 's'}` };
  }
  const detail = summary.failed.map((f) => `${f.name} (${f.error})`).join(', ');
  return {
    kind: 'error',
    text: `imported ${summary.created.length} of ${total} — failed: ${detail}`,
  };
}
