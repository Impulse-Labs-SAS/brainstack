import { describe, expect, it } from 'vitest';

import {
  importMarkdownFiles,
  importPathFor,
  isMarkdownFile,
  noteNameFromFile,
  summarizeImport,
  type ImportableFile,
} from './import-md';

/** Un archivo de disco de mentira, con el contenido que se le dé. */
function file(name: string, content = '# hola\n'): ImportableFile {
  return { name, text: async () => content };
}

/** Un `notes.create` de mentira que anota lo que le llega. */
function recorder(reject?: (path: string) => string | undefined) {
  const calls: { path: string; content: string }[] = [];
  return {
    calls,
    createNote: async (input: { path: string; content: string }) => {
      const message = reject?.(input.path);
      if (message) throw new Error(message);
      calls.push(input);
    },
  };
}

describe('importMarkdownFiles', () => {
  it('crea una nota con el contenido literal del archivo', async () => {
    // El front-matter viaja tal cual: reescribirlo aquí sería adivinar por
    // encima del parser de packages/core.
    const content = '---\ntags: [reunión]\n---\n\nVer [[Gondor]]\n';
    const rec = recorder();

    const summary = await importMarkdownFiles([file('Reunión.md', content)], 'Inbox', rec.createNote);

    expect(rec.calls).toEqual([{ path: 'Inbox/Reunión.md', content }]);
    expect(summary).toEqual({ created: ['Inbox/Reunión.md'], failed: [] });
  });

  it('importa a la raíz sin barra de más', async () => {
    const rec = recorder();
    await importMarkdownFiles([file('suelta.md')], '', rec.createNote);
    expect(rec.calls[0]?.path).toBe('suelta.md');
  });

  it('un duplicado no se lleva por delante el resto del lote', async () => {
    const rec = recorder((path) => (path === 'Inbox/b.md' ? 'ya existe' : undefined));

    const summary = await importMarkdownFiles(
      [file('a.md'), file('b.md'), file('c.md')],
      'Inbox',
      rec.createNote,
    );

    // Los tres se intentaron, aunque el segundo fallara.
    expect(summary.created).toEqual(['Inbox/a.md', 'Inbox/c.md']);
    expect(summary.failed).toEqual([{ name: 'b.md', error: 'ya existe' }]);
    expect(rec.calls.map((c) => c.path)).toEqual(['Inbox/a.md', 'Inbox/c.md']);
  });

  it('resume el lote en un solo cartel', async () => {
    expect(summarizeImport({ created: ['a.md', 'b.md'], failed: [] })).toEqual({
      kind: 'info',
      text: 'imported 2 notes',
    });
    expect(
      summarizeImport({ created: ['a.md'], failed: [{ name: 'b.md', error: 'ya existe' }] }),
    ).toEqual({
      kind: 'error',
      text: 'imported 1 of 2 — failed: b.md (ya existe)',
    });
  });
});

describe('sanitización del nombre', () => {
  it('se queda con el basename, nunca con la ruta que traiga', () => {
    expect(noteNameFromFile('../../etc/passwd.md')).toBe('passwd');
    expect(noteNameFromFile('..\\..\\secrets.md')).toBe('secrets');
    expect(noteNameFromFile('C:\\Users\\yo\\notas\\diario.md')).toBe('diario');
  });

  it('el path importado nunca sale de la carpeta destino', () => {
    expect(importPathFor('Inbox', '../../etc/passwd.md')).toBe('Inbox/passwd.md');
    expect(importPathFor('Inbox', '..\\..\\secrets.md')).toBe('Inbox/secrets.md');
    expect(importPathFor('', '../../../root.md')).toBe('root.md');
  });

  it('un nombre que no deja nota detrás falla el archivo, no el lote', async () => {
    const rec = recorder();
    const summary = await importMarkdownFiles(
      [file('..'), file('bueno.md'), file('../.md')],
      'Inbox',
      rec.createNote,
    );

    expect(summary.created).toEqual(['Inbox/bueno.md']);
    expect(summary.failed.map((f) => f.name)).toEqual(['..', '../.md']);
    // Un nombre imposible ni siquiera llega al servidor.
    expect(rec.calls).toHaveLength(1);
  });

  it('quita bytes nulos y caracteres de control', () => {
    expect(noteNameFromFile('no\u0000ta.md')).toBe('nota');
  });
});

describe('isMarkdownFile', () => {
  it('acepta .md y .markdown, y nada más', () => {
    expect(isMarkdownFile({ name: 'a.md' })).toBe(true);
    expect(isMarkdownFile({ name: 'A.MARKDOWN' })).toBe(true);
    expect(isMarkdownFile({ name: 'foto.png' })).toBe(false);
    expect(isMarkdownFile({ name: 'notas.txt' })).toBe(false);
  });
});
