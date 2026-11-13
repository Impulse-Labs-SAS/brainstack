// Pieces more than one group of tools uses.

import { MAX_EDITS } from '@brainstack/core/sentinel';
import { z } from 'zod';

import { field, frontmatterField, noteContent } from '../config/limits.js';

export const TEXT = (text: string) => ({ content: [{ type: 'text' as const, text }] });

export const JSON_TEXT = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** Notes `get_notes` opens in one call, at most. */
export const MAX_NOTES_READ = 20;
/**
 * Body characters `get_notes` answers with, all notes together. Twenty notes
 * at the size limit would be an answer of forty million characters; past this
 * the rest are cut, and say so.
 */
export const MAX_NOTES_READ_CHARS = 400_000;

/** One of Sentinel's edits, as an assistant sends it. */
export const EDIT = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('replace'),
    find: noteContent().min(1).describe('Text in the note to replace. Must appear exactly once.'),
    replace: noteContent().describe('What replaces it. Empty deletes it.'),
  }),
  z.object({
    op: z.literal('append'),
    text: noteContent(),
    section: field()
      .optional()
      .describe(
        'A heading, like "Notas" or "## Notas" — or the start of one, when only one heading begins with it. Omit to append to the end of the note.',
      ),
  }),
  z.object({
    op: z.literal('prepend'),
    text: noteContent(),
    section: field()
      .optional()
      .describe('A heading: the text goes right under it. Omit to prepend to the whole note.'),
  }),
  z.object({
    op: z.literal('set_frontmatter'),
    values: frontmatterField().describe('Keys to set; a null value removes the key.'),
  }),
]);
export const EDITS = z.array(EDIT).min(1).max(MAX_EDITS);
