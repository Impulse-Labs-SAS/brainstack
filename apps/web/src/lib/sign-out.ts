// Signing out, the one way every button does it.
//
// It used to post /auth/logout and then navigate client-side, which kept the
// whole page alive: react-query's cache still held the last account's tree,
// notes and identity, and whoever signed in next in the same tab was served
// them until each query refetched. Recently opened notes and expanded folders
// stayed in this browser's storage for good. A full page load drops the
// cache; the storage that names notes or folders is cleared by hand.

import { authFetch } from '@/lib/authApi';

/** Browser storage that names the account's notes or folders. Preferences stay. */
const ACCOUNT_KEYS = ['brainstack:recent-notes', 'brainstack:tree-expanded', 'brainstack:reveal-folder'];

export async function signOut(): Promise<void> {
  try {
    await authFetch('/auth/logout', { method: 'POST' });
  } catch {
    // The cookie is HttpOnly, so there is nothing to clean up here; /login
    // sorts out whatever session is left.
  }
  for (const key of ACCOUNT_KEYS) {
    try {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage can be unavailable (private mode, blocked); nothing to clear.
    }
  }
  window.location.replace('/login');
}
