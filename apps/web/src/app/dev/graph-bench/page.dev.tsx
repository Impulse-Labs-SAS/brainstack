'use client';

// The graph bench. A `page.dev.tsx` is a route only under `next dev`
// (next.config.mjs); in a build this file is a plain module, never served.

import { GraphBench } from '@/components/graph/bench/graph-bench';

export default function GraphBenchPage() {
  return <GraphBench />;
}
