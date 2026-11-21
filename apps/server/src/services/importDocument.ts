// Importing a document as notes: Sentinel's plan (`planDocumentImport`, core's
// document.ts) run against the store.
//
// The document arrives as text — the web app reads the PDF or Word file in the
// browser, so the file never reaches the server — and Sentinel decides what
// notes it becomes and where. This answers its lookup and writes the notes.
//
// The web app (tRPC `notes.importDocument`) writes the notes one by one: a
// person's import, not held to the assistant batch. MCP's `import_document`
// writes the same plan through that batch, in as many calls as its cap takes.
// Either way the parts are written first and the index last; if one fails —
// somebody created a note at that path a moment ago — the ones before it stay
// and the answer says how many. Every path was free when the plan was made.
//
// Permission is not decided here: the tRPC and MCP layers check the caller may write in
// the folder before calling in, with the owner of that folder.

import {
  planDocumentImport,
  type DocumentImportInput,
  type DocumentImportPlan,
} from '@brainstack/core/sentinel';

import { AppError, toAppError } from '../lib/errors.js';

import type { NoteService } from './NoteService.js';

export interface ImportedDocument {
  title: string;
  folder: string;
  entry: string;
  notes: Array<{ path: string; chars: number }>;
}

/** What the import would create, writing nothing. */
export async function planImport(
  notes: NoteService,
  ownerId: string,
  input: DocumentImportInput,
): Promise<DocumentImportPlan> {
  return planDocumentImport(input, {
    existing: async (paths) => new Set((await notes.checksums(ownerId, paths)).keys()),
  });
}

/** Writes a plan `planImport` made, in order. */
export async function writeImport(
  notes: NoteService,
  ownerId: string,
  plan: DocumentImportPlan,
): Promise<void> {
  for (const [i, note] of plan.notes.entries()) {
    try {
      await notes.create(ownerId, note.path, note.content, note.frontmatter);
    } catch (err) {
      const known = toAppError(err);
      if (i === 0 || !known) throw err;
      throw new AppError(
        `${i} of ${plan.notes.length} notes were saved in ${plan.folder} before one failed: ${known.message}`,
        known.code,
        known.status,
      );
    }
  }
}

/** A plan as the web app shows it before saving: the paths and how long each note is. */
export function describeImport(plan: DocumentImportPlan): ImportedDocument {
  return {
    title: plan.title,
    folder: plan.folder,
    entry: plan.entry,
    notes: plan.notes.map((n) => ({ path: n.path, chars: [...n.content].length })),
  };
}
