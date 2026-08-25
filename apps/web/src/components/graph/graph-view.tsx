'use client';

// Obsidian-style force-directed graph. Self-contained: no extra deps — we
// run a small velocity-Verlet simulation on a canvas. Repulsion is O(n^2)
// which is fine up to a few thousand notes; if vaults outgrow this we can
// swap in a Barnes-Hut quadtree without changing the render loop.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface InputNode {
  /** Stored path: unique across owners, used to join nodes to edges. */
  id: string;
  /** Path as its owner writes it, for display and navigation. */
  path: string;
  title: string;
  ownerId: string | null;
}
interface InputEdge {
  source: string;
  target: string;
  weight: number;
}
interface SimNode {
  id: string;
  path: string;
  title: string;
  ownerId: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}
interface SimEdge {
  source: SimNode;
  target: SimNode;
  weight: number;
}

interface GraphViewProps {
  nodes: InputNode[];
  edges: InputEdge[];
  /** Who is looking: a node owned by anyone else opens as a shared note. */
  viewerId: string | null;
}

const LINK_DISTANCE = 140;
const LINK_STRENGTH = 0.04;
const REPULSION = 3500;
const CENTER_STRENGTH = 0.008;
const NODE_BASE_RADIUS = 6;
const NODE_DEGREE_SCALE = 3.2;
const DAMPING = 0.85;
const MAX_VELOCITY = 12;

export function GraphView({ nodes, edges, viewerId }: GraphViewProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<SimNode | null>(null);
  const [query, setQuery] = useState('');

  const { simNodes, simEdges } = useMemo(() => {
    const map = new Map<string, SimNode>();
    for (const n of nodes) {
      map.set(n.id, {
        id: n.id,
        path: n.path,
        title: n.title,
        ownerId: n.ownerId,
        x: (Math.random() - 0.5) * 400,
        y: (Math.random() - 0.5) * 400,
        vx: 0,
        vy: 0,
        degree: 0,
      });
    }
    const se: SimEdge[] = [];
    for (const e of edges) {
      const s = map.get(e.source);
      const t = map.get(e.target);
      if (!s || !t) continue;
      s.degree += 1;
      t.degree += 1;
      se.push({ source: s, target: t, weight: e.weight });
    }
    return { simNodes: Array.from(map.values()), simEdges: se };
  }, [nodes, edges]);

  const matchedPaths = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return new Set(
      simNodes
        .filter((n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
        .map((n) => n.id),
    );
  }, [query, simNodes]);

  const tick = useCallback(() => {
    const n = simNodes.length;
    for (let i = 0; i < n; i++) {
      const a = simNodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = simNodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy + 0.01;
        }
        const f = REPULSION / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
      a.vx -= a.x * CENTER_STRENGTH;
      a.vy -= a.y * CENTER_STRENGTH;
    }
    for (const e of simEdges) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const delta = (d - LINK_DISTANCE) * LINK_STRENGTH;
      const fx = (dx / d) * delta;
      const fy = (dy / d) * delta;
      e.source.vx += fx;
      e.source.vy += fy;
      e.target.vx -= fx;
      e.target.vy -= fy;
    }
    for (const node of simNodes) {
      node.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vx * DAMPING));
      node.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vy * DAMPING));
      node.x += node.vx;
      node.y += node.vy;
    }
  }, [simNodes, simEdges]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2 + transform.x, h / 2 + transform.y);
    ctx.scale(transform.k, transform.k);

    ctx.lineCap = 'round';
    for (const e of simEdges) {
      const dim =
        matchedPaths &&
        !matchedPaths.has(e.source.id) &&
        !matchedPaths.has(e.target.id);
      ctx.strokeStyle = dim ? 'rgba(120,120,140,0.08)' : 'rgba(140,140,160,0.35)';
      ctx.lineWidth = Math.min(4, 1 + Math.log2(e.weight + 1) * 0.8);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    }

    for (const node of simNodes) {
      const r = NODE_BASE_RADIUS + Math.sqrt(node.degree) * NODE_DEGREE_SCALE;
      const isHover = hover?.path === node.path;
      const matched = matchedPaths ? matchedPaths.has(node.path) : true;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHover
        ? '#f5d76e'
        : matched
          ? 'rgba(180,180,210,0.95)'
          : 'rgba(180,180,210,0.18)';
      ctx.fill();
      if (isHover) {
        ctx.strokeStyle = '#f5d76e';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    ctx.font = `${12 / transform.k}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const node of simNodes) {
      const r = NODE_BASE_RADIUS + Math.sqrt(node.degree) * NODE_DEGREE_SCALE;
      const isHover = hover?.path === node.path;
      const matched = matchedPaths ? matchedPaths.has(node.path) : true;
      ctx.fillStyle = isHover
        ? '#f5d76e'
        : matched
          ? 'rgba(220,220,235,0.85)'
          : 'rgba(220,220,235,0.18)';
      ctx.fillText(node.title, node.x, node.y + r + 3);
    }
    ctx.textAlign = 'start';

    ctx.restore();
  }, [simNodes, simEdges, transform, hover, matchedPaths]);

  useEffect(() => {
    let stop = false;
    const loop = () => {
      if (stop) return;
      tick();
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      stop = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [tick, draw]);

  const screenToWorld = useCallback(
    (sx: number, sy: number) => {
      const container = containerRef.current;
      if (!container) return { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      const cx = sx - rect.left - rect.width / 2 - transform.x;
      const cy = sy - rect.top - rect.height / 2 - transform.y;
      return { x: cx / transform.k, y: cy / transform.k };
    },
    [transform],
  );

  const findNodeAt = useCallback(
    (sx: number, sy: number): SimNode | null => {
      const { x, y } = screenToWorld(sx, sy);
      let best: SimNode | null = null;
      let bestDist = Infinity;
      for (const node of simNodes) {
        const r = NODE_BASE_RADIUS + Math.sqrt(node.degree) * NODE_DEGREE_SCALE + 4;
        const dx = node.x - x;
        const dy = node.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r * r && d2 < bestDist) {
          bestDist = d2;
          best = node;
        }
      }
      return best;
    },
    [screenToWorld, simNodes],
  );

  const dragState = useRef<{ kind: 'pan'; sx: number; sy: number; ox: number; oy: number } | { kind: 'node'; node: SimNode } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const node = findNodeAt(e.clientX, e.clientY);
    if (node) {
      dragState.current = { kind: 'node', node };
    } else {
      dragState.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        ox: transform.x,
        oy: transform.y,
      };
    }
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state) {
      const node = findNodeAt(e.clientX, e.clientY);
      setHover(node);
      if (containerRef.current) {
        containerRef.current.style.cursor = node ? 'pointer' : 'grab';
      }
      return;
    }
    if (state.kind === 'pan') {
      setTransform((t) => ({ ...t, x: state.ox + (e.clientX - state.sx), y: state.oy + (e.clientY - state.sy) }));
    } else {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      state.node.x = x;
      state.node.y = y;
      state.node.vx = 0;
      state.node.vy = 0;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    dragState.current = null;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (state?.kind === 'node') {
      const moved = Math.hypot(state.node.vx, state.node.vy);
      if (moved < 0.5) {
        router.push(noteHref(state.node, viewerId));
      }
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setTransform((t) => ({
      x: t.x,
      y: t.y,
      k: Math.max(0.2, Math.min(4, t.k * factor)),
    }));
  };

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex items-center gap-3 border-b border-border-subtle bg-bg-surface px-4 py-2 font-mono text-[11px] text-fg-muted">
        <span>{simNodes.length} notes · {simEdges.length} links</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter…"
          className="ml-auto h-7 w-56 rounded border border-border-subtle bg-bg-base px-2 text-fg-primary outline-none focus:border-border-strong"
        />
      </div>
      <div
        ref={containerRef}
        className="relative flex-1 select-none overflow-hidden bg-bg-base"
        style={{ cursor: 'grab', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
        {hover && (
          <div className="pointer-events-none absolute left-3 bottom-3 max-w-[60%] rounded border border-border-subtle bg-bg-surface px-2 py-1 font-mono text-[11px] text-fg-primary shadow-sm">
            <div>{hover.title}</div>
            <div className="text-fg-muted">{hover.path}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where clicking a node goes.
 *
 * Someone else's note lives under the shared route, which carries the owner;
 * the plain route resolves against the viewer and would miss.
 */
function noteHref(node: SimNode, viewerId: string | null): string {
  const path = node.path.replace(/\.md$/i, '');
  const foreign = node.ownerId && viewerId && node.ownerId !== viewerId;
  return foreign
    ? `/notes/shared/${node.ownerId}/${node.path}`
    : `/notes/${path}`;
}
