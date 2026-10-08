'use client';

// The Sentinel lab. A `page.dev.tsx` is a route only under `next dev`
// (next.config.mjs); in a build this file is a plain module, never served.

import { SentinelLab } from '@/components/graph/crawl/sentinel/lab/sentinel-lab';

export default function SentinelLabPage() {
  return <SentinelLab />;
}
