// Input limits shared by every transport: tRPC, MCP and the HTTP edge.
//
// Every string an account can send ends up parsed, indexed and stored. Left
// unbounded, one request could hand the parser a body large enough to hold
// the event loop that every other user of the instance waits on. These are
// generous for real notes and tight for anything else; one place, so the two
// transports cannot drift apart.

import { MAX_PATH_LENGTH } from '@brainstack/core';
import { z } from 'zod';

/** A note body, in characters. A long book chapter is a few hundred thousand. */
export const MAX_NOTE_CHARS = 2_000_000;

/** Frontmatter, measured as JSON. Real frontmatter is well under a kilobyte. */
export const MAX_FRONTMATTER_CHARS = 100_000;

/** Paths, ids, tags, facet keys and values, search queries, tokens. */
export const MAX_FIELD_CHARS = MAX_PATH_LENGTH;

/** RFC 5321's limit on an address. */
export const MAX_EMAIL_CHARS = 320;

/** Request bodies at the HTTP edge, in bytes: a full note encoded as JSON fits. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Request bodies on routes that never carry a note (auth, OAuth). */
export const MAX_SMALL_BODY_BYTES = 64 * 1024;

/** Calls tRPC accepts in one batched request. The web app sends at most a dozen. */
export const MAX_TRPC_BATCH = 50;

/** A short text field: a path, an id, a tag, a query. */
export const field = (): z.ZodString => z.string().max(MAX_FIELD_CHARS);

/** A note body. */
export const noteContent = (): z.ZodString => z.string().max(MAX_NOTE_CHARS);

/** An email address. */
export const emailField = (): z.ZodString => z.string().email().max(MAX_EMAIL_CHARS);

/** Frontmatter as a client sends it: any JSON object, of bounded size. */
export const frontmatterField = () =>
  z
    .record(z.string().max(MAX_FIELD_CHARS), z.unknown())
    .refine((value) => JSON.stringify(value).length <= MAX_FRONTMATTER_CHARS, {
      message: `frontmatter is larger than ${MAX_FRONTMATTER_CHARS} characters`,
    });
