// Refuses a request that changes something on the strength of the session
// cookie when the browser says it came from a page on another site.
//
// `SameSite=Lax` already keeps the cookie off most cross-site requests, but
// "site" is the registrable domain: an app on a sibling subdomain of the same
// domain is same-site, and its pages get the cookie sent along. Checking where
// the request came from closes that gap, and costs nothing where BrainStack has
// a domain to itself.
//
// Only requests that carry the session cookie are checked. An API key, an
// OAuth token or the session header is something a page on another site
// cannot make a browser attach on its own, and a request with no credentials
// has nothing to borrow. Requests with no `Origin` and no `Sec-Fetch-Site`
// come from something that is not a browser (scripts, tests) and pass: the
// check is about a browser being steered, not about who may call the API.

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

import { SESSION_COOKIE, type AuthBindings } from './auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckOptions {
  /** Origins whose pages may make these requests: the web app, the API's own. */
  allowedOrigins: readonly string[];
}

export function buildOriginCheckMiddleware(opts: OriginCheckOptions): MiddlewareHandler<AuthBindings> {
  const allowed = new Set(opts.allowedOrigins.flatMap((o) => originOf(o) ?? []));

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || !getCookie(c, SESSION_COOKIE)) return next();

    const origin = c.req.header('origin');
    if (origin !== undefined) {
      // A page on this same host (the consent form posts to the API itself)
      // is fine whichever scheme the proxy in front reports.
      const parsed = originOf(origin);
      const host = c.req.header('host');
      const sameHost = parsed !== null && host !== undefined && new URL(parsed).host === host;
      if (parsed !== null && (allowed.has(parsed) || sameHost)) return next();
      return c.json({ error: 'request origin not allowed', code: 'FORBIDDEN' }, 403);
    }

    // No Origin: older browsers leave it off some same-origin requests. The
    // fetch metadata header, where sent, still says whether another site
    // started it.
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ error: 'request origin not allowed', code: 'FORBIDDEN' }, 403);
    }
    return next();
  };
}

/** The serialised origin of a URL, or null for `null`, opaque or junk values. */
function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
