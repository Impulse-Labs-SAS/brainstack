'use client';

import { useEffect, useState } from 'react';

/** Tailwind's `md`: from here up the panel is a column at the left; under it, a sheet from the bottom. */
const WIDE = '(min-width: 768px)';

/** Whether the screen is wide enough for the side panel, following a resize or a turned phone. */
export function useWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window === 'undefined' || window.matchMedia(WIDE).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}
