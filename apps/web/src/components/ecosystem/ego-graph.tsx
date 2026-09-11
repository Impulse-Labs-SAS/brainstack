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

/*
 * A `related` neighbor is not a link: it is another note that happens to
 * share a tag or facet (NoteService.listRelated). Drawing it with the same
 * solid line as a wikilink made this map assert connections that nobody
 * wrote — and that the full graph, which reads only the `links` table,
 * correctly refuses to draw. Dashed keeps the affinity visible while saying
 * it is a weaker, different thing.
 */
const RELATION_DASH: Record<EgoNeighbor['relation'], string | undefined> = {
  backlink: undefined,
  outbound: undefined,
  related: '3 3',
};

const RELATION_LABEL: Record<EgoNeighbor['relation'], string> = {
  backlink: 'enlace entrante',
  outbound: 'enlace saliente',
  related: 'afín por tag/faceta',
};

/** The order the legend reads in, so it does not reshuffle per note. */
const RELATION_ORDER: EgoNeighbor['relation'][] = ['backlink', 'outbound', 'related'];

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

  // From the laid-out nodes, not from `neighbors`: dedup and the node cap
  // both happen in the layout, and a legend row for a relation that got
  // dropped would explain a line nobody can see.
  const present = useMemo(
    () => new Set(layout.nodes.map((n) => n.relation)),
    [layout.nodes],
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
            strokeDasharray={RELATION_DASH[n.relation]}
            opacity={n.relation === 'related' ? 0.3 : 0.55}
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

      {/*
       * Without this the three relations are three shades of dot, and the
       * only reading left is "these notes are connected" — which for the
       * dashed ones is not what the vault actually says.
       */}
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {RELATION_ORDER.filter((rel) => present.has(rel)).map((rel) => (
          <li key={rel} className="flex items-center gap-1 font-mono text-[10px] text-fg-muted">
            <svg width={16} height={8} aria-hidden="true">
              <line
                x1={0}
                y1={4}
                x2={16}
                y2={4}
                stroke={palette.link}
                strokeWidth={1}
                strokeDasharray={RELATION_DASH[rel]}
                opacity={rel === 'related' ? 0.3 : 0.55}
              />
              <circle cx={8} cy={4} r={3} fill={palette[RELATION_COLOR[rel]]} />
            </svg>
            {RELATION_LABEL[rel]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
