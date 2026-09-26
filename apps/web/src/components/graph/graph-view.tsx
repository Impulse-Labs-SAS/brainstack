'use client';

// Obsidian-style force-directed graph. Self-contained: no extra deps — the
// simulation mirrors d3-force's model (many-body repulsion, link springs, a
// weak pull to the origin, collision) with alpha cooling, so the layout
// settles and then stops instead of shivering forever.
//
// Two things that made the first version unreadable, worth not undoing:
//
//  - Repulsion falls off as 1/d, not 1/d². With the faster falloff distant
//    notes stopped pushing each other at all and gravity packed the whole
//    vault into one ball; no amount of zoom separates labels after that.
//  - A node the user drags is *pinned* (`fx`/`fy`). The sim used to keep its
//    own forces on it, so anything you pulled out sprang straight back.
//
// Nodes and labels are drawn in screen space (only the links live inside the
// canvas transform) so text stays 12px at any zoom, dots never shrink to
// nothing, and labels that would collide are dropped instead of overlapping.
//
// Structure is told apart from content. A MOC index (`_<Folder>.md`) links to
// every note in its folder, so it used to be the hub of every cluster; its
// edges now pull less, draw fainter and can be hidden.
//
// Four views: links only; links plus dashed affinity edges between notes that
// share a rare topic; links plus a node per topic; or one node per project.
// Projects are told apart by the panel on the left (hover lights one up, click
// focuses it), not by colour — a palette runs out long before projects do.
// What connects to what is decided in lib/graph-model.ts; this file only
// simulates and draws it.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FALLBACK_PALETTE, readPalette, type Palette } from '@/lib/graph-palette';
import {
  buildGraphModel,
  summariseProjects,
  worldRadius,
  type AffinityInput,
  type GraphMode,
  type InputEdge,
  type InputNode,
  type ProjectSummary,
  type SimEdge,
  type SimNode,
} from '@/lib/graph-model';
import { isIndexNote } from '@/lib/graph-structure';

interface GraphViewProps {
  nodes: InputNode[];
  edges: InputEdge[];
  /** Shared topics and the edges they imply; null until loaded, or in the links view. */
  affinity: AffinityInput | null;
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  /** Who is looking: a node owned by anyone else opens as a shared note. */
  viewerId: string | null;
}

const CHARGE = -420; // many-body repulsion; negative repels
const GRAVITY = 0.035; // the only thing bounding a 1/d repulsion
const VELOCITY_DECAY = 0.6;
const ALPHA_DECAY = 0.017; // ~300 ticks to settle
const ALPHA_MIN = 0.0015;
const ALPHA_REHEAT = 0.4;
const COLLIDE_PADDING = 8;
const MIN_SCREEN_RADIUS = 3;
const MAX_SCREEN_RADIUS = 44;

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
const LABEL_FONT = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
const LABEL_MAX_CHARS = 32;
const CLICK_SLOP = 4; // px of pointer travel still counted as a click

function screenRadius(node: SimNode, k: number): number {
  return Math.max(MIN_SCREEN_RADIUS, Math.min(MAX_SCREEN_RADIUS, worldRadius(node) * k));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

type Rect = { x: number; y: number; w: number; h: number };

function overlaps(a: Rect, placed: Rect[]): boolean {
  for (const b of placed) {
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return true;
  }
  return false;
}

const MODES: Array<{ id: GraphMode; label: string }> = [
  { id: 'links', label: 'enlaces' },
  { id: 'affinity', label: 'afinidad' },
  { id: 'topics', label: 'temas' },
  { id: 'projects', label: 'proyectos' },
];

export function GraphView({
  nodes,
  edges,
  affinity,
  mode,
  onModeChange,
  viewerId,
}: GraphViewProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);

  const [hover, setHover] = useState<SimNode | null>(null);
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pinnedCount, setPinnedCount] = useState(0);
  const [showIndexes, setShowIndexes] = useState(true);
  // The project under the pointer in the panel, and the projects a click
  // focused. Either one dims everything outside it.
  const [panelProject, setPanelProject] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ ids: Set<string>; label: string } | null>(null);

  // The viewport lives in a ref: panning at 60fps must not re-render React.
  const transform = useRef({ x: 0, y: 0, k: 1 });
  const alphaRef = useRef(1);
  const needsDraw = useRef(true);
  const userMoved = useRef(false);
  const paletteRef = useRef<Palette>(FALLBACK_PALETTE);

  const isForeign = useCallback(
    (ownerId: string | null) => Boolean(ownerId && viewerId && ownerId !== viewerId),
    [viewerId],
  );

  const indexCount = useMemo(() => nodes.filter((n) => isIndexNote(n.path)).length, [nodes]);
  const projects = useMemo(() => summariseProjects(nodes), [nodes]);

  const { simNodes, simEdges, neighbours, related, counts } = useMemo(
    () => buildGraphModel({ nodes, edges, affinity, mode, showIndexes, isForeign }),
    [nodes, edges, affinity, mode, showIndexes, isForeign],
  );

  // What stays lit: the text filter, narrowed to the hovered or focused
  // projects. Null means everything.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    const within = panelProject ? new Set([panelProject]) : (focus?.ids ?? null);
    if (!q && !within) return null;
    return new Set(
      simNodes
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
        .filter((n) => !within || (n.project !== null && within.has(n.project.id)))
        .map((n) => n.id),
    );
  }, [query, panelProject, focus, simNodes]);

  // -- Simulation ------------------------------------------------------------

  const tick = useCallback(() => {
    const a = alphaRef.current;
    const n = simNodes.length;

    for (let i = 0; i < n; i++) {
      const p = simNodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const q = simNodes[j]!;
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (i - j) % 2 === 0 ? 0.7 : -0.7;
          dy = 0.7;
          d2 = dx * dx + dy * dy;
        }
        // d3's many-body: acceleration ∝ strength / d², i.e. force ∝ 1/d.
        const w = (CHARGE * a) / d2;
        const fx = dx * w;
        const fy = dy * w;
        p.vx += fx;
        p.vy += fy;
        q.vx -= fx;
        q.vy -= fy;

        // Collision, folded into the pair loop we already pay for.
        const rs = worldRadius(p) + worldRadius(q) + COLLIDE_PADDING;
        if (d2 < rs * rs) {
          const d = Math.sqrt(d2);
          const push = ((rs - d) / d) * 0.5;
          if (p.fx === null) {
            p.x -= dx * push;
            p.y -= dy * push;
          }
          if (q.fx === null) {
            q.x += dx * push;
            q.y += dy * push;
          }
        }
      }
      p.vx -= p.x * GRAVITY * a;
      p.vy -= p.y * GRAVITY * a;
    }

    for (const e of simEdges) {
      const s = e.source;
      const t = e.target;
      let dx = t.x + t.vx - s.x - s.vx;
      let dy = t.y + t.vy - s.y - s.vy;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const l = ((d - e.distance) / d) * a * e.strength;
      dx *= l;
      dy *= l;
      t.vx -= dx * e.bias;
      t.vy -= dy * e.bias;
      s.vx += dx * (1 - e.bias);
      s.vy += dy * (1 - e.bias);
    }

    for (const node of simNodes) {
      if (node.fx !== null && node.fy !== null) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= VELOCITY_DECAY;
      node.vy *= VELOCITY_DECAY;
      node.x += node.vx;
      node.y += node.vy;
    }
  }, [simNodes, simEdges]);

  // -- Viewport --------------------------------------------------------------

  const fit = useCallback(() => {
    const container = containerRef.current;
    if (!container || simNodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of simNodes) {
      const r = worldRadius(node);
      minX = Math.min(minX, node.x - r);
      minY = Math.min(minY, node.y - r);
      maxX = Math.max(maxX, node.x + r);
      maxY = Math.max(maxY, node.y + r);
    }
    const w = container.clientWidth;
    const h = container.clientHeight;
    const pad = 80;
    const k = Math.max(
      MIN_ZOOM,
      Math.min(1.2, (w - pad) / Math.max(1, maxX - minX), (h - pad) / Math.max(1, maxY - minY)),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    transform.current = { x: -cx * k, y: -cy * k, k };
    setZoom(k);
    needsDraw.current = true;
  }, [simNodes]);

  // -- Drawing ---------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const colors = paletteRef.current;
    const { x: tx, y: ty, k } = transform.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const focus = hover ? (neighbours.get(hover.id) ?? new Set<string>()) : null;
    const toScreenX = (x: number) => w / 2 + tx + x * k;
    const toScreenY = (y: number) => h / 2 + ty + y * k;

    // Links, in world space so they scale with the layout.
    ctx.save();
    ctx.translate(w / 2 + tx, h / 2 + ty);
    ctx.scale(k, k);
    ctx.lineCap = 'round';
    for (const e of simEdges) {
      const touchesHover = hover ? e.source.id === hover.id || e.target.id === hover.id : false;
      const inFilter = !matched || matched.has(e.source.id) || matched.has(e.target.id);
      const style = EDGE_STYLE[e.kind];
      let opacity = style.opacity;
      if (!inFilter) opacity = 0.05;
      else if (hover) opacity = touchesHover ? style.hoverOpacity : 0.06;
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = touchesHover ? colors.accent : colors.link;
      const width =
        e.kind === 'link' ? Math.min(3.5, 0.8 + Math.log2(e.weight + 1) * 0.7) : style.width;
      const scale = Math.max(k, 0.45);
      ctx.lineWidth = width / scale;
      // Dashed means "nobody linked these": the one thing an affinity edge must
      // never be mistaken for is a link.
      ctx.setLineDash(style.dash ? style.dash.map((d) => d / scale) : []);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Nodes, in screen space: a dot never shrinks below a clickable size.
    for (const node of simNodes) {
      const sx = toScreenX(node.x);
      const sy = toScreenY(node.y);
      const r = screenRadius(node, k);
      if (sx < -r || sx > w + r || sy < -r || sy > h + r) continue;
      const isHover = hover?.id === node.id;
      const isNeighbour = focus?.has(node.id) ?? false;
      const inFilter = !matched || matched.has(node.id);
      const fill = colors.node;

      let opacity = 1;
      if (!inFilter) opacity = 0.15;
      else if (hover && !isHover && !isNeighbour) opacity = 0.25;
      ctx.globalAlpha = opacity;
      // Shape carries what colour cannot: a square is an index, a ring is
      // somebody else's note. Identity never rests on hue alone.
      ctx.beginPath();
      if (node.kind === 'topic') {
        hexagon(ctx, sx, sy, r * 1.25);
      } else if (node.isIndex) {
        const side = r * 1.7;
        ctx.roundRect(sx - side / 2, sy - side / 2, side, side, Math.min(3, side / 4));
      } else {
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
      }
      if (node.kind === 'topic') {
        // Hollow and grey: a topic is not a note, and has no folder to wear.
        ctx.fillStyle = colors.bg;
        ctx.fill();
        ctx.strokeStyle = colors.label;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (node.foreign) {
        ctx.fillStyle = colors.bg;
        ctx.fill();
        ctx.strokeStyle = colors.foreign;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (isHover) {
        // A ring, not a repaint: the hovered note keeps its folder colour.
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (node.fx !== null) {
        // Pinned: a ring, so it is clear the sim is no longer moving it.
        ctx.globalAlpha = Math.min(1, opacity + 0.2);
        ctx.strokeStyle = colors.labelStrong;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Labels, in screen space, biggest first, dropping any that would collide.
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    // Collision alone thins the labels out; the degree gate only kicks in when
    // zoomed far enough out that even the survivors would be a grey smear.
    const minDegree = k >= 0.5 ? 0 : k >= 0.3 ? 3 : 8;
    const placed: Rect[] = [];
    const order = [...simNodes].sort((a, b) => b.size - a.size);
    for (const node of order) {
      const isHover = hover?.id === node.id;
      const isNeighbour = focus?.has(node.id) ?? false;
      const isMatch = matched?.has(node.id) ?? false;
      if (matched && !isMatch && !isHover && !isNeighbour) continue;
      if (!isHover && !isNeighbour && !isMatch && node.size < minDegree) continue;

      const sx = toScreenX(node.x);
      const sy = toScreenY(node.y);
      if (sx < -120 || sx > w + 120 || sy < -40 || sy > h + 40) continue;

      const text = truncate(node.kind === 'topic' ? node.path : node.title, LABEL_MAX_CHARS);
      const tw = ctx.measureText(text).width;
      const top = sy + screenRadius(node, k) + 4;
      const rect: Rect = { x: sx - tw / 2 - 3, y: top - 2, w: tw + 6, h: 15 };
      if (!isHover && overlaps(rect, placed)) continue;
      placed.push(rect);

      ctx.globalAlpha = hover && !isHover && !isNeighbour ? 0.35 : 1;
      // Halo first: labels sit on top of links, and mid-grey on mid-grey is
      // the other half of why this was unreadable.
      ctx.strokeStyle = colors.bg;
      ctx.lineWidth = 3;
      ctx.strokeText(text, sx, top);
      ctx.fillStyle =
        isHover || isNeighbour ? colors.labelStrong : node.kind === 'topic' ? colors.link : colors.label;
      ctx.fillText(text, sx, top);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
  }, [simNodes, simEdges, neighbours, hover, matched]);

  // -- Render loop -----------------------------------------------------------
  //
  // Refs, not deps: the loop must survive a re-render without restarting, and
  // it must stop entirely once the layout has settled and nothing is moving.

  const tickRef = useRef(tick);
  const drawRef = useRef(draw);
  const fitRef = useRef(fit);
  const tickCount = useRef(0);

  const ensureRunning = useCallback(() => {
    if (frameRef.current !== null) return;
    const loop = () => {
      frameRef.current = null;
      let moving = false;
      if (alphaRef.current > ALPHA_MIN) {
        tickRef.current();
        alphaRef.current += (0 - alphaRef.current) * ALPHA_DECAY;
        tickCount.current += 1;
        needsDraw.current = true;
        moving = true;
        // Follow the layout while it expands, until the user takes over.
        if (!userMoved.current && tickCount.current % 20 === 0) fitRef.current();
        if (alphaRef.current <= ALPHA_MIN && !userMoved.current) fitRef.current();
      }
      if (needsDraw.current) {
        needsDraw.current = false;
        drawRef.current();
      }
      if (moving || needsDraw.current) frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);
  }, []);

  const requestDraw = useCallback(() => {
    needsDraw.current = true;
    ensureRunning();
  }, [ensureRunning]);

  const reheat = useCallback(
    (alpha = ALPHA_REHEAT) => {
      alphaRef.current = Math.max(alphaRef.current, alpha);
      ensureRunning();
    },
    [ensureRunning],
  );

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);
  useEffect(() => {
    drawRef.current = draw;
    requestDraw();
  }, [draw, requestDraw]);

  // A new vault means a new layout: cool from scratch and re-fit.
  useEffect(() => {
    paletteRef.current = readPalette();
    alphaRef.current = 1;
    tickCount.current = 0;
    userMoved.current = false;
    setPinnedCount(0);
    ensureRunning();
  }, [simNodes, ensureRunning]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => requestDraw());
    observer.observe(container);
    return () => observer.disconnect();
  }, [requestDraw]);

  // -- Hit testing -----------------------------------------------------------

  const findNodeAt = useCallback(
    (clientX: number, clientY: number): SimNode | null => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { x: tx, y: ty, k } = transform.current;
      let best: SimNode | null = null;
      let bestDist = Infinity;
      for (const node of simNodes) {
        const sx = rect.width / 2 + tx + node.x * k;
        const sy = rect.height / 2 + ty + node.y * k;
        const r = screenRadius(node, k) + 4;
        const dx = sx - px;
        const dy = sy - py;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r * r && d2 < bestDist) {
          bestDist = d2;
          best = node;
        }
      }
      return best;
    },
    [simNodes],
  );

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    const { x: tx, y: ty, k } = transform.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - tx) / k,
      y: (clientY - rect.top - rect.height / 2 - ty) / k,
    };
  }, []);

  const zoomBy = useCallback(
    (factor: number, originX?: number, originY?: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const px = (originX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const py = (originY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const t = transform.current;
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.k * factor));
      const ratio = k / t.k;
      // Keep whatever sits under the cursor exactly where it is.
      transform.current = { x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio, k };
      userMoved.current = true;
      setZoom(k);
      requestDraw();
    },
    [requestDraw],
  );

  // -- Pointer ---------------------------------------------------------------

  const dragState = useRef<
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number; travel: number }
    | { kind: 'node'; node: SimNode; sx: number; sy: number; travel: number }
    | null
  >(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const node = findNodeAt(e.clientX, e.clientY);
    if (node) {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      node.fx = x;
      node.fy = y;
      dragState.current = { kind: 'node', node, sx: e.clientX, sy: e.clientY, travel: 0 };
      // Hands off the viewport: auto-fit re-centring mid-drag would slide the
      // graph out from under the cursor.
      userMoved.current = true;
      reheat(0.25);
    } else {
      dragState.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        ox: transform.current.x,
        oy: transform.current.y,
        travel: 0,
      };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state) {
      const node = findNodeAt(e.clientX, e.clientY);
      if (node?.id !== hover?.id) setHover(node);
      if (containerRef.current) containerRef.current.style.cursor = node ? 'pointer' : 'grab';
      return;
    }
    state.travel = Math.max(state.travel, Math.hypot(e.clientX - state.sx, e.clientY - state.sy));
    if (state.kind === 'pan') {
      transform.current = {
        ...transform.current,
        x: state.ox + (e.clientX - state.sx),
        y: state.oy + (e.clientY - state.sy),
      };
      if (state.travel > CLICK_SLOP) userMoved.current = true;
      requestDraw();
    } else {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      state.node.fx = x;
      state.node.fy = y;
      state.node.x = x;
      state.node.y = y;
      reheat(0.25);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    dragState.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // the pointer was never captured; nothing to release
    }
    if (state?.kind !== 'node') return;
    if (state.travel <= CLICK_SLOP) {
      // A click, not a drag: opening the note, so leave nothing pinned.
      state.node.fx = null;
      state.node.fy = null;
      // A topic is not a note and has nowhere to open; hovering it already
      // lights up every note that carries it.
      if (state.node.kind === 'topic') return;
      // A project opens as its notes: the project and every project it
      // connects to, so what made the connection is on screen.
      if (state.node.kind === 'project' && state.node.project) {
        const ids = new Set([state.node.project.id]);
        for (const id of neighbours.get(state.node.id) ?? []) {
          const project = simNodes.find((n) => n.id === id)?.project;
          if (project) ids.add(project.id);
        }
        setFocus({ ids, label: state.node.title });
        setHover(null);
        onModeChange('affinity');
        return;
      }
      router.push(noteHref(state.node, viewerId));
      return;
    }
    setPinnedCount(simNodes.filter((n) => n.fx !== null).length);
    requestDraw();
  };

  // Wheel has to be a native listener: React registers it passively, and a
  // passive listener cannot preventDefault the page scroll.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      // The panel scrolls its own list; a native listener here fires before
      // React could stop it, so it has to look where the wheel came from.
      if (e.target instanceof Element && e.target.closest('[data-graph-panel]')) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const releasePins = () => {
    for (const node of simNodes) {
      node.fx = null;
      node.fy = null;
    }
    setPinnedCount(0);
    reheat(0.5);
  };

  const relayout = () => {
    userMoved.current = false;
    tickCount.current = 0;
    reheat(1);
  };

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex items-center gap-3 border-b border-border-subtle bg-bg-surface px-4 py-2 font-mono text-[11px] text-fg-muted">
        {mode === 'projects' ? (
          <span>
            {counts.projects} proyectos · {counts.links} con enlaces · {counts.affinity} por temas
          </span>
        ) : (
          <span>
            {counts.notes} notes · {counts.links} links
            {counts.structure > 0 && <span> · {counts.structure} de índices</span>}
            {mode === 'affinity' && <span> · {counts.affinity} afinidades</span>}
            {mode === 'topics' && <span> · {counts.topics} temas</span>}
            {counts.foreign > 0 && (
              <span className="text-info"> · {counts.foreign} de otros</span>
            )}
          </span>
        )}
        <div role="radiogroup" aria-label="Conexiones" className="flex overflow-hidden rounded border border-border-subtle">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => onModeChange(m.id)}
              className={
                mode === m.id
                  ? 'bg-bg-elevated px-2 py-0.5 text-fg-primary'
                  : 'px-2 py-0.5 text-fg-muted transition-colors hover:text-fg-primary'
              }
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={showIndexes}
            onChange={(e) => setShowIndexes(e.target.checked)}
            className="h-3 w-3 accent-accent"
          />
          <span className={showIndexes ? 'text-fg-primary' : undefined}>índices</span>
        </label>
        {focus && (
          <button
            type="button"
            onClick={() => setFocus(null)}
            title="Quitar el enfoque"
            className="rounded border border-border-strong px-2 py-0.5 text-fg-primary transition-colors hover:bg-bg-hover"
          >
            enfoque: {focus.label}
            {focus.ids.size > 1 && <span className="text-fg-muted"> +{focus.ids.size - 1}</span>} ✕
          </button>
        )}
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
      >
        <canvas ref={canvasRef} className="block h-full w-full" />

        <ProjectPanel
          projects={projects}
          focused={focus?.ids ?? null}
          onHoverProject={setPanelProject}
          onFocusProject={(project) =>
            setFocus((current) =>
              current?.ids.size === 1 && current.ids.has(project.id)
                ? null
                : { ids: new Set([project.id]), label: project.label },
            )
          }
          indexCount={indexCount}
          showsIndexes={showIndexes}
          onToggleIndexes={() => setShowIndexes((v) => !v)}
          hasForeign={counts.foreign > 0}
          mode={mode}
        />

        {hover && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[60%] rounded border border-border-subtle bg-bg-surface px-2 py-1 font-mono text-[11px] text-fg-primary shadow-sm">
            {hover.kind === 'topic' ? (
              <>
                <div>{hover.path}</div>
                <div className="text-fg-muted">
                  tema compartido por {neighbours.get(hover.id)?.size ?? 0} notas
                </div>
              </>
            ) : (
              <>
                <div>{hover.title}</div>
                <div className="text-fg-muted">
                  {hover.path}
                  {hover.kind === 'note' && hover.project && mode !== 'links' && (
                    <span> · {hover.project.label}</span>
                  )}
                </div>
                {(related.get(hover.id)?.length ?? 0) > 0 && (
                  <ul className="mt-1 space-y-0.5 border-t border-border-subtle pt-1">
                    {related
                      .get(hover.id)!
                      .slice(0, 5)
                      .map((a) => (
                        <li key={a.id}>
                          <span className="text-fg-secondary">
                            {a.links > 0 ? '—' : '┄'} {a.title}
                          </span>{' '}
                          <span className="text-fg-muted">
                            {[
                              a.links > 0 ? `${a.links} ${a.links === 1 ? 'enlace' : 'enlaces'}` : null,
                              a.shared.length > 0 ? a.shared.slice(0, 3).join(', ') : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </li>
                      ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        <div className="absolute bottom-3 right-3 flex items-center gap-1 font-mono text-[11px]">
          {pinnedCount > 0 && (
            <GraphButton onPress={releasePins}>soltar {pinnedCount} fijados</GraphButton>
          )}
          <GraphButton onPress={relayout}>reordenar</GraphButton>
          <GraphButton onPress={fit}>ajustar</GraphButton>
          <GraphButton onPress={() => zoomBy(1 / 1.25)}>−</GraphButton>
          <span className="w-10 text-center text-fg-muted">{Math.round(zoom * 100)}%</span>
          <GraphButton onPress={() => zoomBy(1.25)}>+</GraphButton>
        </div>
      </div>
    </div>
  );
}

/** How each kind of edge is drawn. Only a real link ever gets a solid, weighted line. */
const EDGE_STYLE: Record<
  SimEdge['kind'],
  { opacity: number; hoverOpacity: number; width: number; dash: number[] | null }
> = {
  link: { opacity: 0.28, hoverOpacity: 0.75, width: 1, dash: null },
  structure: { opacity: 0.1, hoverOpacity: 0.4, width: 0.7, dash: null },
  affinity: { opacity: 0.4, hoverOpacity: 0.85, width: 1, dash: [4, 4] },
  topic: { opacity: 0.18, hoverOpacity: 0.6, width: 0.7, dash: null },
};

function hexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const px = x + r * Math.cos(angle);
    const py = y + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * The projects in view, and what the marks mean.
 *
 * Projects are told apart here rather than by colour: hovering one lights its
 * notes up, clicking focuses it. That works for three projects or fifty, where
 * a palette runs out at a handful. The list scrolls and filters so fifty still
 * fits beside the graph.
 *
 * It sits on top of the canvas, so it keeps the pointer to itself: a press
 * that reached the canvas started a pan, and nothing here could be clicked.
 */
function ProjectPanel({
  projects,
  focused,
  onHoverProject,
  onFocusProject,
  indexCount,
  showsIndexes,
  onToggleIndexes,
  hasForeign,
  mode,
}: {
  projects: ProjectSummary[];
  focused: Set<string> | null;
  onHoverProject: (id: string | null) => void;
  onFocusProject: (project: ProjectSummary) => void;
  indexCount: number;
  showsIndexes: boolean;
  onToggleIndexes: () => void;
  hasForeign: boolean;
  mode: GraphMode;
}) {
  const [open, setOpen] = useState(true);
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.label.toLowerCase().includes(q)) : projects;

  return (
    <div
      data-graph-panel
      className="absolute left-3 top-3 flex max-h-[calc(100%-5rem)] w-56 cursor-default flex-col rounded border border-border-subtle bg-bg-surface font-mono text-[11px] text-fg-secondary"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between px-2 py-1.5 text-fg-primary transition-colors hover:bg-bg-hover"
      >
        <span>
          proyectos <span className="text-fg-muted">{projects.length}</span>
        </span>
        <span aria-hidden className="text-fg-muted">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <>
          {projects.length > 6 && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filtrar proyectos…"
              aria-label="Filtrar proyectos"
              className="mx-2 mb-1 h-6 rounded border border-border-subtle bg-bg-base px-1.5 text-fg-primary outline-none focus:border-border-strong"
            />
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-1" onMouseLeave={() => onHoverProject(null)}>
            {shown.map((p) => {
              const isFocused = focused?.has(p.id) ?? false;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-pressed={isFocused}
                    onMouseEnter={() => onHoverProject(p.id)}
                    onFocus={() => onHoverProject(p.id)}
                    onBlur={() => onHoverProject(null)}
                    onClick={() => onFocusProject(p)}
                    title={isFocused ? 'Quitar el enfoque' : 'Enfocar este proyecto'}
                    className={
                      'flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-bg-hover hover:text-fg-primary' +
                      (isFocused ? ' bg-bg-elevated text-fg-primary' : '')
                    }
                  >
                    <span className="truncate">{p.label}</span>
                    <span className="shrink-0 text-fg-muted">{p.count}</span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-1 py-0.5 text-fg-muted">sin resultados</li>}
          </ul>

          <ul className="space-y-1 border-t border-border-subtle px-2 py-1.5">
            {indexCount > 0 && mode !== 'projects' && (
              <li>
                <button
                  type="button"
                  aria-pressed={showsIndexes}
                  onClick={onToggleIndexes}
                  title={showsIndexes ? 'Ocultar índices' : 'Mostrar índices'}
                  className="-mx-0.5 flex items-center gap-2 rounded px-0.5 transition-colors hover:bg-bg-hover hover:text-fg-primary"
                >
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-[2px] border border-fg-secondary"
                  />
                  <span className={showsIndexes ? undefined : 'text-fg-muted line-through'}>
                    índice (MOC)
                  </span>
                  <span className="text-fg-muted">{indexCount}</span>
                </button>
              </li>
            )}
            {hasForeign && (
              <li className="flex items-center gap-2">
                <span aria-hidden className="inline-block h-2 w-2 rounded-full border-2 border-info" />
                <span>de otros</span>
              </li>
            )}
            <li className="flex items-center gap-2">
              <span aria-hidden className="inline-block w-3 border-t border-fg-secondary" />
              <span>enlace</span>
            </li>
            {(mode === 'affinity' || mode === 'projects') && (
              <li className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block w-3 border-t border-dashed border-fg-secondary"
                />
                <span>afinidad (tema en común)</span>
              </li>
            )}
            {mode === 'topics' && (
              <li className="flex items-center gap-2">
                <span aria-hidden className="text-[10px] leading-none text-fg-secondary">
                  ⬡
                </span>
                <span>tema</span>
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function GraphButton({ children, onPress }: { children: React.ReactNode; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="rounded border border-border-subtle bg-bg-surface px-2 py-1 text-fg-muted transition-colors hover:border-border-strong hover:text-fg-primary"
    >
      {children}
    </button>
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
  return foreign ? `/notes/shared/${node.ownerId}/${node.path}` : `/notes/${path}`;
}
