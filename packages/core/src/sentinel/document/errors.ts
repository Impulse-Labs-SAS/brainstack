/** Why a document cannot be imported as it is. */
export class DocumentImportError extends Error {
  override readonly name = 'DocumentImportError';
  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'EMPTY_TEXT' | 'ALREADY_EXISTS' | 'TOO_LONG',
  ) {
    super(message);
  }
}
