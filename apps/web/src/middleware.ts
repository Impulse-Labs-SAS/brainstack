// Edge middleware: refuse to render any protected route when the session
// cookie is missing. The cookie itself is validated server-side on every
// trpc call — here we only check for its presence so nothing protected is
// ever sent to the browser. In dev the cookie is set by the API on
// localhost (host-only, no Domain attribute), so it is visible to both
// :3000 and :3001.
//
// Public routes: login, signup, password recovery, email verification
// landing, plus the framework's static asset paths.

import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'bs_session';
const PUBLIC_ROUTES = new Set([
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_ROUTES.has(pathname)) return true;
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  /*
   * The API is not a page and must never be redirected.
   *
   * Deployed, it is served from this same origin under `/api`, so it passes
   * through here — and a request carrying no session cookie was answered with
   * a 307 to /login instead of reaching the function at all. Locally the two
   * live on different ports, so this only ever appears in production.
   *
   * The matcher below already excludes it. This is the second lock: whoever
   * edits that regex next should not be able to take the API down with it.
   */
  if (pathname === '/api' || pathname.startsWith('/api/')) return NextResponse.next();

  // OAuth discovery documents (RFC 8414/9728). Same deal as /api: they belong
  // to the function, and a redirect to /login here would read as "this server
  // does not speak OAuth" to every MCP client that probes them.
  if (pathname.startsWith('/.well-known/')) return NextResponse.next();

  const hasSession = req.cookies.get(SESSION_COOKIE)?.value;

  if (isPublic(pathname)) {
    // Already signed in → bounce away from login/signup back to home so the
    // user doesn't see an auth form they don't need.
    if (hasSession && (pathname === '/login' || pathname === '/signup')) {
      const url = req.nextUrl.clone();
      url.pathname = '/notes';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    // Preserve where the user was trying to go (relative path only).
    if (pathname !== '/') url.searchParams.set('redirect_to', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip the matcher for the API, OAuth discovery, framework internals and
  // static assets. Everything else flows through the middleware above.
  matcher: [
    '/((?!api/|\\.well-known/|_next/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)).*)',
  ],
};
