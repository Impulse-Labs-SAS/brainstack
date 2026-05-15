// Thin wrappers around the /auth/* REST endpoints. These do not go through
// tRPC because the auth flows set cookies directly and tRPC's mutations
// would just add ceremony.

function serverUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3000';
  }
  return process.env.NEXT_PUBLIC_SERVER_URL ?? window.location.origin.replace(':3001', ':3000');
}

export async function authFetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const body = init?.json !== undefined ? JSON.stringify(init.json) : init?.body;
  const headers = new Headers(init?.headers ?? {});
  if (init?.json !== undefined) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${serverUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers,
    body,
  });
  const text = await res.text();
  const payload = text ? (JSON.parse(text) as unknown) : ({} as unknown);
  if (!res.ok) {
    const message =
      (payload as { error?: string })?.error ?? `request failed (${res.status})`;
    throw new AuthApiError(message, res.status, (payload as { code?: string })?.code);
  }
  return payload as T;
}

export class AuthApiError extends Error {
  override readonly name = 'AuthApiError';
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export function googleSignInHref(redirectTo?: string): string {
  const target = `${serverUrl()}/auth/google`;
  if (!redirectTo) return target;
  return `${target}?redirect_to=${encodeURIComponent(redirectTo)}`;
}
