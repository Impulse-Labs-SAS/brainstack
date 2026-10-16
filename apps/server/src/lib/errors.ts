// Common error mapping for HTTP and MCP layers.

import { PathTraversalError } from '@brainstack/core';
import {
  PgNoteAlreadyExistsError,
  PgNoteChangedError,
  PgNoteNotFoundError,
} from '@brainstack/core/pg';
import { NoteEditError } from '@brainstack/core/sentinel';

export class AppError extends Error {
  override readonly name = 'AppError';
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'ALREADY_EXISTS'
      /** Someone else changed the note since the caller read it. */
      | 'CHANGED'
      | 'INVALID_INPUT'
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'RATE_LIMITED'
      /** A sign-up this instance does not let in. Its own code so the login page can explain it. */
      | 'SIGNUP_CLOSED'
      /** The instance lacks something the request needs, such as email. */
      | 'UNAVAILABLE'
      | 'INTERNAL',
    public readonly status = 500,
  ) {
    super(message);
  }
}

/**
 * `err` as an AppError, when it is one or one of core's errors that mean the
 * same thing — a missing note, a taken path, a path that tries to climb out.
 * Null for anything else: a failure the caller did not cause and must not be
 * told the details of.
 */
export function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof PgNoteNotFoundError) return new AppError(err.message, 'NOT_FOUND', 404);
  if (err instanceof PgNoteAlreadyExistsError) {
    return new AppError(err.message, 'ALREADY_EXISTS', 409);
  }
  if (err instanceof PgNoteChangedError) return new AppError(err.message, 'CHANGED', 409);
  if (err instanceof PathTraversalError) return new AppError(err.message, 'INVALID_INPUT', 400);
  // An edit whose anchor is missing or ambiguous: the message says which, for
  // the caller to fix and resend.
  if (err instanceof NoteEditError) return new AppError(err.message, 'INVALID_INPUT', 400);
  return null;
}

export function toHttpStatus(err: unknown): number {
  return toAppError(err)?.status ?? 500;
}

/** What a client may be told about a failure. */
export const INTERNAL_MESSAGE = 'internal error';

/**
 * What a client may be told about `err`: an AppError's own message (or one of
 * core's, see `toAppError`), written for whoever asked, and nothing at all about anything else. A driver or SMTP
 * error names hosts, ports, tables and constraints — useful in the server log,
 * which is where the caller logs it, and nowhere else.
 */
export function describeError(err: unknown): { message: string; code: string } {
  const known = toAppError(err);
  if (known) return { message: known.message, code: known.code };
  return { message: INTERNAL_MESSAGE, code: 'INTERNAL' };
}
