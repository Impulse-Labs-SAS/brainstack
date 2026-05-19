import { redirect } from 'next/navigation';

// Inbox was removed: the vault editor on /notes is now the only landing.
// The auth middleware (apps/web/src/middleware.ts) gates this route, so an
// unauthenticated visitor still goes through /login.
export default function HomePage(): never {
  redirect('/notes');
}
