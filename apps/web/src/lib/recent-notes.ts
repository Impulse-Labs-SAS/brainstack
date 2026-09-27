// The notes this browser opened last, for the sidebar's Recent group and the
// quick switcher's empty state. Per browser on purpose: "recently opened" is
// about this person at this desk, and it costs the server nothing.

import { useEffect, useState } from 'react';

export interface RecentNote {
  /** Route the note opens at: `/notes/...` or `/notes/shared/<owner>/...`. */
  href: string;
  title: string;
  /** Path as shown to the reader, without `.md`. */
  path: string;
}

const KEY = 'brainstack:recent-notes';
const EVENT = 'brainstack:recent-notes';
const MAX = 12;

export function readRecent(): RecentNote[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentNote =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as RecentNote).href === 'string' &&
        typeof (r as RecentNote).title === 'string' &&
        typeof (r as RecentNote).path === 'string',
    );
  } catch {
    return [];
  }
}

function write(list: RecentNote[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage can be full or blocked; Recent is a convenience, not a record.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Put a note first, dropping an older entry for the same route. */
export function pushRecent(note: RecentNote): void {
  const list = readRecent().filter((r) => r.href !== note.href);
  write([note, ...list].slice(0, MAX));
}

/** Forget a route, and everything under it when it is a folder's. */
export function forgetRecent(hrefPrefix: string): void {
  const list = readRecent().filter(
    (r) => r.href !== hrefPrefix && !r.href.startsWith(`${hrefPrefix}/`),
  );
  write(list);
}

export function useRecentNotes(): RecentNote[] {
  const [list, setList] = useState<RecentNote[]>([]);
  useEffect(() => {
    const sync = () => setList(readRecent());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return list;
}
