'use client';

// Static one-hop ego-graph embedded in the Ecosystem section: the current
// note at the center, its backlinks/outbound links/related notes on a ring
// around it. Plain SVG, no physics — components/graph/graph-view.tsx's force
// simulation is built for the whole vault, and re-running it for a handful
// of one-hop neighbors would be doing far more work than the result needs.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { readPalette, FALLBACK_PALETTE, type Palette } from '@/lib/graph-palette';
import { layoutEgoGraph, type EgoNeighbor } from '@/lib/ego-graph-layout';
import { notePathToRoute } from '@/lib/wikilinks-client';

const RELATION_COLOR: Record<EgoNeighbor['relation'], keyof Palette> = {
  backlink: 'accent',
  outbound: 'foreign',
  related: 'node',
};

export interface EgoGraphProps {
  /** The open note's own path — drawn at the center, not clickable. */
  centerLabel: string;
  neighbors: readonly EgoNeighbor[];
  size?: number;
}

export function EgoGraph({ centerLabel, neighbors, size = 220 }: EgoGraphProps) {
  const router = useRouter();
  const [palette, setPalette] = useState<Palette>(FALLBACK_PALETTE);
  useEffect(() => setPalette(readPalette()), []);

  const layout = useMemo(
    () => layoutEgoGraph(neighbors, { width: size, height: size }),
    [neighbors, size],
  );

  if (neighbors.length === 0) return null;

  return (
    <div>
      <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-fg-muted">
        Mapa de un salto
      </div>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Notas conectadas a ${centerLabel}`}
      >
        {layout.nodes.map((n) => (
          <line
            key={`edge-${n.path}`}
            x1={layout.center.x}
            y1={layout.center.y}
            x2={n.x}
            y2={n.y}
            stroke={palette.link}
            strokeWidth={1}
            opacity={0.5}
          />
        ))}

        <circle cx={layout.center.x} cy={layout.center.y} r={6} fill={palette.accent} />
        <text
          x={layout.center.x}
          y={layout.center.y + 18}
          textAnchor="middle"
          fontSize={10}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fill={palette.labelStrong}
        >
          {truncate(centerLabel, 20)}
        </text>

        {layout.nodes.map((n) => (
          <g
            key={n.path}
            transform={`translate(${n.x}, ${n.y})`}
            onClick={() => router.push(notePathToRoute(n.path))}
            className="cursor-pointer"
          >
            <circle r={4} fill={palette[RELATION_COLOR[n.relation]]} />
            <text
              y={14}
              textAnchor="middle"
              fontSize={9}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fill={palette.label}
            >
              {truncate(n.label, 16)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
