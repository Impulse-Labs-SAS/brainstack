'use client';

// The graph bench: the graph page's own view over an invented vault of any size, with a frame
// probe beside it, so how the graph draws can be measured at sizes no real vault has reached
// yet — and the same run repeated after a change. Mounted only by a `page.dev.tsx`, so it
// exists under `next dev` alone; nothing here reaches the API.
//
//   /dev/graph-bench?notes=5000&seed=11&view=territories
//
// The vault is `largeVault`: seeded, so a seed and a size always build the same notes. The
// view opens through the hash, as /graph does. The probe's numbers sit at the foot of the
// page, and on `window.__graphBench` for a script: `report()` and `reset()`.
//
// It shares the browser's storage with /graph on this origin, so the layers it saves are the
// ones /graph opens with; the layout it saves names notes /graph has not got, and is ignored there.

import { useEffect, useMemo, useState } from 'react';
import { Button } from 'react-aria-components';

import { largeVault } from '../crawl/space/large-vault';
import { GraphView } from '../graph-view';
import { benchParams, type BenchParams } from './bench-params';
import { FrameProbe, type FrameStats } from './frame-probe';

/** What a script reads from the page while it measures. */
export interface GraphBenchHandle {
  params: BenchParams;
  notes: number;
  links: number;
  report(): FrameStats;
  reset(): void;
}

declare global {
  interface Window {
    __graphBench?: GraphBenchHandle;
  }
}

const ms = (n: number) => `${n.toFixed(1)} ms`;

/** The bench never fetches shared vaults: there is nothing to toggle. */
const ignore = () => {};

export function GraphBench() {
  const [params, setParams] = useState<BenchParams | null>(null);

  // In the browser only: the query, and the hash the graph opens its view from.
  useEffect(() => {
    const p = benchParams(window.location.search);
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#${p.view}`);
    } catch {
      // a sandboxed frame may refuse; the graph then opens on its default view
    }
    setParams(p);
  }, []);

  const vault = useMemo(() => (params ? largeVault(params.seed, params.notes) : null), [params]);

  if (!params || !vault) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-base font-mono text-[12px] text-fg-secondary">
        building the vault…
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg-base">
      <GraphView
        nodes={vault.inputs.nodes}
        edges={vault.inputs.edges}
        affinity={null}
        viewerId={vault.inputs.viewerId}
        vaultNames={vault.inputs.vaultNames}
        includeShared
        onIncludeSharedChange={ignore}
        persist={false}
        excerpts={false}
      />
      <BenchReadout
        params={params}
        notes={vault.inputs.nodes.length}
        links={vault.inputs.edges.length}
      />
    </div>
  );
}

/**
 * The probe and its numbers. A component of its own, so the readout's updates every half
 * second re-render only itself, never the graph it is measuring.
 */
function BenchReadout({
  params,
  notes,
  links,
}: {
  params: BenchParams;
  notes: number;
  links: number;
}) {
  const [stats, setStats] = useState<FrameStats | null>(null);

  useEffect(() => {
    const probe = new FrameProbe();
    probe.start();
    window.__graphBench = {
      params,
      notes,
      links,
      report: () => probe.report(),
      reset: () => probe.reset(),
    };
    const timer = window.setInterval(() => setStats(probe.report()), 500);
    return () => {
      window.clearInterval(timer);
      probe.stop();
      delete window.__graphBench;
    };
  }, [params, notes, links]);

  return (
    <div
      role="status"
      // On a phone it would sit over the preview's sheet: there the numbers are read through
      // window.__graphBench, from a desktop's remote inspector.
      className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded border border-border bg-bg-surface px-3 py-1.5 font-mono text-[12px] text-fg-secondary max-md:hidden"
    >
      <span>
        bench · {notes.toLocaleString('en')} notes · {links.toLocaleString('en')} links · seed{' '}
        {params.seed}
      </span>
      {stats && (
        <span className="text-fg-primary">
          p50 {ms(stats.p50)} · p95 {ms(stats.p95)} · max {ms(stats.max)} · {stats.fps.toFixed(0)}{' '}
          fps · long tasks {stats.longTasks} ({ms(stats.longTaskMs)})
        </span>
      )}
      <Button
        onPress={() => window.__graphBench?.reset()}
        className="rounded border border-border px-2 py-0.5 text-fg-primary outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent"
      >
        Reset
      </Button>
    </div>
  );
}
