// An on/off preference kept in localStorage. Null when never set, or when the
// browser keeps no storage (private mode, blocked site data).

export function readFlag(key: string): boolean | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // ignore
  }
}
