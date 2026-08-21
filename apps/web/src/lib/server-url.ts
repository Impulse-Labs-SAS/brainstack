// Where the API is, resolved once for everything that calls it.
//
// Deployed, the web app and the API are the same origin: Netlify serves the
// Next site and routes `/api/*` to the function. Locally they are two ports,
// web on :3001 and server on :3000, so the origin has to be adjusted.
//
// The `/api` prefix is not optional in either case — the server mounts every
// route behind it, in development too, so that a URL which works on a laptop
// works deployed.

/** Prefix the server mounts every route behind. Matches API_BASE_PATH. */
const API_PREFIX = '/api';

/**
 * Origin the API answers on, without a trailing slash and without the prefix.
 *
 * `NEXT_PUBLIC_SERVER_URL` overrides it, which is how development points the
 * web app at the other port. Deployed it is unset and the current origin is
 * right, because the same site serves both.
 */
export function serverOrigin(): string {
  const env = process.env.NEXT_PUBLIC_SERVER_URL;
  if (env) return env.replace(/\/+$/, '');
  // Rendering on the server: no window, and nothing on this path needs a
  // same-origin call, so the dev default is the only useful answer.
  if (typeof window === 'undefined') return 'http://localhost:3000';
  return window.location.origin.replace(':3001', ':3000');
}

/** Base every API call is built on: origin plus the prefix. */
export function apiBase(): string {
  return `${serverOrigin()}${API_PREFIX}`;
}

export function attachmentUrl(logicalPath: string): string {
  const encoded = logicalPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${apiBase()}/attachments/${encoded}`;
}
