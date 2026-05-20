// Resolves the API server origin for raw asset URLs (img/iframe/video src).
// tRPC uses the same logic in lib/trpc.ts; keep them in sync. The defaults
// match dev: web on :3001, server on :3000. In production both can sit
// behind the same origin and the env var (or matching origin) takes over.

export function serverOrigin(): string {
  const env = process.env.NEXT_PUBLIC_SERVER_URL;
  if (env) return env.replace(/\/$/, '');
  if (typeof window === 'undefined') return 'http://localhost:3000';
  return window.location.origin.replace(':3001', ':3000');
}

export function attachmentUrl(logicalPath: string): string {
  const encoded = logicalPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${serverOrigin()}/api/attachments/${encoded}`;
}
