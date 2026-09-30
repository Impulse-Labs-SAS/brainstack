// Common error mapping for HTTP and MCP layers.

export class AppError extends Error {
  override readonly name = 'AppError';
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'ALREADY_EXISTS'
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

export function toHttpStatus(err: unknown): number {
  if (err instanceof AppError) return err.status;
  return 500;
}

export function describeError(err: unknown): { message: string; code: string } {
  if (err instanceof AppError) return { message: err.message, code: err.code };
  if (err instanceof Error) return { message: err.message, code: 'INTERNAL' };
  return { message: 'Unknown error', code: 'INTERNAL' };
}
