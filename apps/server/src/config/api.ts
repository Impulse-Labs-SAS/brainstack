// Paths that more than one layer has to agree on.
//
// The API answers under a prefix so a single Netlify function can serve it:
// Netlify routes a path pattern to a function, and `/api/*` is that pattern.
// Development mounts it identically rather than at the root, because a layout
// that only exists in production is a layout nobody tests — and the failure it
// produces (tRPC parsing the procedure name out of the wrong path) looks like
// a 404 with no explanation.
//
// Anything that builds a URL for a client — the web app's tRPC link, the
// verification and reset links in emails — reads it from here.

/** Prefix every HTTP route sits behind, in every deployment. */
export const API_BASE_PATH = '/api';

/** Page in the web app that turns a magic-link token into a session. */
export const MAGIC_LINK_CALLBACK_PATH = '/auth/callback';

/** Absolute URL of that page, for an email to point at. */
export function magicLinkCallbackUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, '')}${MAGIC_LINK_CALLBACK_PATH}`;
}
