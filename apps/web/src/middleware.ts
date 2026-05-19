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
  // Skip the matcher for framework internals and static assets. Everything
  // else flows through the middleware above.
  matcher: ['/((?!_next/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)).*)'],
};
