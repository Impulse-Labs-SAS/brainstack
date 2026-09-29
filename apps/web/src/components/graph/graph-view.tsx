'use client';

// The graph page's canvas and chrome. Three views of the same notes, each
// answering its own question — Brain (3D, inside a brain), Network (how it
// connects) and Territories (what there is and where it is filed) — and one
// behaviour across all of them: a click brings the camera to a note and opens
// its preview without leaving the graph.
//
// The heavy lifting lives outside React: graph-controller runs the loop,
// graph-engine the layout, graph-scene the WebGL, graph-overlay the text.
// This file owns what React is good at: the toolbar, panels and preferences.

import { Brain, Map as MapIcon, Network, Play, Square } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button, ToggleButton, ToggleButtonGroup } from 'react-aria-components';

import type { AnglePreset } from '@/lib/graph-camera';
import {
  DEFAULT_LAYERS,
  GRAPH_VIEWS,
  buildGraphModel,
  noteHref,
  type AffinityInput,
  type GraphLayers,
  type GraphNode,
  type GraphView as View,
  type InputEdge,
  type InputNode,
  type SharedVaultName,
} from '@/lib/graph-model';
import { DEFAULT_FILTERS, searchGraph, type SearchFilters } from '@/lib/graph-search';
import { BRIDGE_COLOR, LABEL_COLORS, OWN_VAULT_COLOR, SHARED_VAULT_COLORS, TOPIC_COLOR } from '@/lib/graph-palette';
import { cn } from '@/lib/utils';

import { GraphController, type CountryHover, type Selection } from './graph-controller';
import { GraphLayersMenu } from './graph-layers';
import { GLASS, GraphPreview, edited } from './graph-preview';
import { FilterChips, GraphSearch } from './graph-search';

interface GraphViewProps {
  nodes: InputNode[];
  edges: InputEdge[];
  /** Shared topics and the edges they imply; null until loaded. */
  affinity: AffinityInput | null;
  /** Who is looking: a node owned by anyone else is a shared note. */
  viewerId: string | null;
  /** Owner id → how to name their vault. */
  vaultNames: ReadonlyMap<string, SharedVaultName>;
  /** Whether shared vaults are fetched at all; null when sharing is off on this deployment. */
  includeShared: boolean | null;
  onIncludeSharedChange(include: boolean): void;
}

const VIEW_KEY = 'brainstack.graph.view';
const LAYERS_KEY = 'brainstack.graph.layers';
const LAYOUT_KEY = 'brainstack.graph.layout';

const VIEWS: Array<{ id: View; label: string; icon: typeof Brain; hint: string }> = [
  { id: 'brain', label: 'Brain', icon: Brain, hint: 'Drag to turn the brain, Shift+drag to move it. Click a note to focus it.' },
  {
    id: 'network',
    label: 'Network',
    icon: Network,
    hint: 'Links alone decide where a note sits: hubs grow, and links between projects glow. Shift+click two notes for the path between them.',
  },
  {
    id: 'territories',
    label: 'Territories',
    icon: MapIcon,
    hint: 'Each project is a country, sized by its notes, and each vault a continent. Point at a note or a country to see its routes; click a country to zoom in.',
  },
];

// Preferences are per-browser conveniences: a blocked or private store just
// means starting from the defaults.
function readPref<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked; the preference is simply not kept
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function GraphView({ nodes, edges, affinity, viewerId, vaultNames, includeShared, onIncludeSharedChange }: GraphViewProps) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<GraphController | null>(null);
  const cacheRef = useRef(new Map<string, GraphNode>());
  const builtRef = useRef<{ nodes: InputNode[]; edges: InputEdge[] } | null>(null);

  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>('brain');
  const [layers, setLayers] = useState<GraphLayers>(DEFAULT_LAYERS);
  const [webgl, setWebgl] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [hoveredCountry, setHoveredCountry] = useState<CountryHover | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [growing, setGrowing] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [angle, setAngle] = useState<AnglePreset | null>(null);
  const [query, setQuery] = useState('');
  // Not remembered between visits: a filter left on yesterday would hide what you look for today.
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);

  const open = useCallback(
    (node: GraphNode) => {
      // A topic is not a note: "opening" it shows the notes that carry it.
      if (node.kind === 'topic') controllerRef.current?.select(node);
      else router.push(noteHref(node));
    },
    [router],
  );
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const saveLayout = useCallback(() => {
    const c = controllerRef.current;
    if (c?.model) writePref(LAYOUT_KEY, { view: c.view, positions: c.snapshot() });
  }, []);

  // One controller for the page's lifetime. Preferences load here, not during
  // render: localStorage and the hash exist only in the browser.
  useEffect(() => {
    const el = {
      stage: stageRef.current!,
      gl: glRef.current!,
      overlay: overlayRef.current!,
      minimap: minimapRef.current!,
      tooltip: tooltipRef.current!,
      timeChip: chipRef.current!,
    };
    const controller = new GraphController(
      el,
      {
        onSelection: setSelection,
        onHover: setHovered,
        onHoverCountry: setHoveredCountry,
        onToast: setToast,
        onGrowth: setGrowing,
        onSpin: setSpinning,
        onAngle: setAngle,
        onOpen: (node) => openRef.current(node),
        onSettled: saveLayout,
      },
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    controllerRef.current = controller;
    setWebgl(controller.webgl);

    const fromHash = GRAPH_VIEWS.find((v) => `#${v}` === window.location.hash);
    let initial: View = fromHash ?? readPref<View>(VIEW_KEY) ?? 'brain';
    if (!GRAPH_VIEWS.includes(initial) || (initial === 'brain' && !controller.webgl)) initial = controller.webgl ? 'brain' : 'network';
    controller.initView(initial);
    setView(initial);
    const storedLayers = readPref<GraphLayers>(LAYERS_KEY);
    if (storedLayers) setLayers({ ...DEFAULT_LAYERS, ...storedLayers });
    setReady(true);

    const onLeave = () => saveLayout();
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      saveLayout();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [saveLayout]);

  // A topic belongs to no project, so it has no place on the map: Territories
  // leaves topic nodes out whatever the layer says, and the others bring them back.
  const modelLayers = useMemo(() => (view === 'territories' && layers.topics ? { ...layers, topics: false } : layers), [view, layers]);
  const model = useMemo(
    () => (ready ? buildGraphModel({ nodes, edges, affinity, layers: modelLayers, viewerId, vaultNames, cache: cacheRef.current }) : null),
    [ready, nodes, edges, affinity, modelLayers, viewerId, vaultNames],
  );

  useEffect(() => {
    const c = controllerRef.current;
    if (!c || !model) return;
    const previous = builtRef.current;
    builtRef.current = { nodes, edges };
    if (!previous) {
      // First layout: start from where the notes were last time, if it was this view.
      const stored = readPref<{ view: View; positions: Record<string, [number, number, number]> }>(LAYOUT_KEY);
      const saved =
        stored?.view === c.view
          ? new Map(Object.entries(stored.positions).map(([id, [x, y, z]]) => [id, { x, y, z }] as const))
          : undefined;
      c.setModel(model, 'init', saved);
    } else {
      c.setModel(model, previous.nodes !== nodes || previous.edges !== edges ? 'data' : 'layers');
    }
  }, [model, nodes, edges]);

  useEffect(() => {
    if (!ready) return;
    controllerRef.current?.setView(view);
    writePref(VIEW_KEY, view);
    try {
      history.replaceState(null, '', `#${view}`);
    } catch {
      // a sandboxed frame may refuse; the preference still holds
    }
  }, [view, ready]);

  useEffect(() => {
    if (ready) writePref(LAYERS_KEY, layers);
    controllerRef.current?.setRoutes(layers.routes);
  }, [layers, ready]);

  // "Edited this week" is measured from when the search last changed, which is close enough for a filter.
  const matches = useMemo(() => (model ? searchGraph(model.nodes, query, filters, Date.now()) : null), [model, query, filters]);
  useEffect(() => {
    controllerRef.current?.setMatches(matches);
  }, [matches]);
  const currentMatch = selection?.kind === 'note' && matches?.includes(selection.node) ? selection.node : null;

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  // "/" jumps to search from anywhere on the page that is not already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onStageKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // Popovers render through a portal but their key events still bubble here.
    if (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.closest('[role=dialog]')) return;
    const index = ['1', '2', '3'].indexOf(e.key);
    if (index >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const next = GRAPH_VIEWS[index]!;
      if (next !== 'brain' || webgl) setView(next);
      e.preventDefault();
      return;
    }
    if (t === overlayRef.current && controllerRef.current?.keyDown(e.nativeEvent)) e.preventDefault();
  };

  const c = () => controllerRef.current;
  const is3D = view === 'brain';
  const visibleVaults = model?.vaults.filter((v) => !v.hidden) ?? [];
  const hint = VIEWS.find((v) => v.id === view)!.hint;

  return (
    <div
      ref={stageRef}
      className="relative h-full w-full overflow-hidden bg-bg-base"
      onKeyDown={onStageKey}
    >
      <canvas ref={glRef} aria-hidden className="absolute inset-0 block h-full w-full" />
      <canvas
        ref={overlayRef}
        tabIndex={0}
        aria-label="Graph of your notes. With a note selected, arrow keys move along its links and Enter opens it."
        className="absolute inset-0 block h-full w-full outline-none"
        style={{ touchAction: 'none', cursor: 'grab' }}
        onPointerDown={(e) => {
          e.currentTarget.focus({ preventScroll: true });
          c()?.pointerDown(e.nativeEvent);
        }}
        onPointerMove={(e) => c()?.pointerMove(e.nativeEvent)}
        onPointerUp={(e) => c()?.pointerUp(e.nativeEvent)}
        onPointerCancel={(e) => c()?.pointerUp(e.nativeEvent, true)}
        onPointerLeave={() => c()?.pointerLeave()}
        onDoubleClick={(e) => c()?.doubleClick(e.nativeEvent)}
        onContextMenu={(e) => e.preventDefault()}
      />
      <WheelBinder target={overlayRef} controller={controllerRef} />

      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2">
        {model && (
          <GraphLayersMenu
            model={model}
            layers={layers}
            onChange={setLayers}
            view={view}
            includeShared={includeShared}
            onIncludeSharedChange={onIncludeSharedChange}
          />
        )}

        <ToggleButtonGroup
          aria-label="View"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[view]}
          onSelectionChange={(keys) => {
            const next = [...keys][0] as View | undefined;
            if (next) setView(next);
          }}
          className={cn(GLASS, 'pointer-events-auto flex gap-0.5 rounded-lg p-[3px]')}
        >
          {VIEWS.map((v) => (
            <ToggleButton
              key={v.id}
              id={v.id}
              isDisabled={v.id === 'brain' && !webgl}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-fg-secondary outline-none',
                'hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
                'selected:bg-bg-elevated selected:text-fg-primary selected:shadow-[inset_0_0_0_1px_var(--border-strong)]',
              )}
            >
              <v.icon size={14} aria-hidden />
              {v.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {model && (
          <GraphSearch
            model={model}
            query={query}
            onQueryChange={setQuery}
            filters={filters}
            onFiltersChange={setFilters}
            matches={matches}
            current={currentMatch}
            onGo={(n) => c()?.select(n)}
            onPreview={(n) => c()?.preview(n)}
            onFrame={() => c()?.frameMatches()}
            inputRef={searchRef}
          />
        )}

        <span className="flex-1" />

        <Button
          onPress={() => (growing ? c()?.stopGrowth() : c()?.startGrowth())}
          isDisabled={!model?.nodes.length}
          className={cn(
            GLASS,
            'pointer-events-auto flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-fg-primary outline-none',
            'hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
          )}
        >
          {growing ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}
          {growing ? 'Stop' : 'Replay growth'}
        </Button>

        {model && <FilterChips model={model} filters={filters} onChange={setFilters} />}
      </div>

      {selection && model && (
        <GraphPreview
          selection={selection}
          model={model}
          onSelect={(n) => c()?.select(n)}
          onOpen={open}
          onPathFrom={(n) => c()?.startPathFrom(n)}
          onClose={() => c()?.clearSelection()}
        />
      )}

      <div
        ref={tooltipRef}
        // Display comes from a class, not the `hidden` attribute: `grid` would override [hidden].
        className={cn(
          GLASS,
          'pointer-events-none absolute z-20 max-w-[280px] gap-px rounded-lg px-2.5 py-2 text-xs',
          hovered || hoveredCountry ? 'grid' : 'hidden',
        )}
      >
        {hovered ? (
          <Tooltip node={hovered} vaultLabel={model?.vaults.find((v) => v.id === hovered.vault)?.label ?? ''} />
        ) : (
          hoveredCountry && <CountryTooltip country={hoveredCountry} vaultLabel={model?.vaults.find((v) => v.id === hoveredCountry.vault)?.label ?? ''} />
        )}
      </div>

      <div
        ref={chipRef}
        hidden
        aria-live="polite"
        className={cn(GLASS, 'absolute left-1/2 top-16 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-3.5 py-1.5 font-mono text-sm text-fg-primary')}
      />

      <div
        className={cn(
          GLASS,
          'absolute bottom-3 left-3 z-10 grid max-w-[calc(100%-1.5rem)] gap-1.5 rounded-lg px-3 py-2.5 text-xs text-fg-secondary md:max-w-[min(560px,calc(100%-15rem))]',
          selection && 'max-md:hidden',
        )}
      >
        <p className="text-[12.5px] leading-snug text-fg-primary">
          {hint}
          {!webgl && ' This browser has no WebGL, so the 3D brain is unavailable.'}
        </p>
        <ul className="flex flex-wrap gap-x-3.5 gap-y-1">
          {visibleVaults.map((v) => (
            <LegendItem key={v.id} glyph={<span className="h-2 w-2 rounded-full" style={{ background: v.color.hue, boxShadow: `0 0 6px ${v.color.hue}` }} />}>
              {v.label}
            </LegendItem>
          ))}
          <LegendItem glyph={<span className="flex gap-[3px]">{[0.35, 0.6, 1].map((o) => <span key={o} className="h-1.5 w-1.5 rounded-full" style={{ opacity: o, background: OWN_VAULT_COLOR.core }} />)}</span>}>
            brightness = recent activity
          </LegendItem>
          {layers.indexes && <LegendItem glyph={<span className="h-2 w-2 rounded-[2px]" style={{ background: LABEL_COLORS.index }} />}>index</LegendItem>}
          {visibleVaults.some((v) => !v.own) && (
            <LegendItem glyph={<span className="h-2 w-2 rounded-full border-2" style={{ borderColor: SHARED_VAULT_COLORS[0]!.hue }} />}>
              someone else&apos;s note
            </LegendItem>
          )}
          {view === 'territories' ? (
            <>
              <LegendItem
                glyph={<span className="h-2.5 w-4 rounded-[3px] border" style={{ borderColor: OWN_VAULT_COLOR.hue, background: `${OWN_VAULT_COLOR.hue}40` }} />}
              >
                project
              </LegendItem>
              <LegendItem glyph={<span className="w-4 border-t border-dashed" style={{ borderColor: OWN_VAULT_COLOR.hue }} />}>folder</LegendItem>
              <LegendItem glyph={<span className="w-4 border-t border-white/80" />}>route, on hover</LegendItem>
            </>
          ) : (
            <>
              <LegendItem glyph={<span className="w-4 border-t" style={{ borderColor: OWN_VAULT_COLOR.hue }} />}>link</LegendItem>
              {view === 'network' && (
                <LegendItem glyph={<span className="w-4 border-t-2" style={{ borderColor: BRIDGE_COLOR.hue }} />}>link between projects</LegendItem>
              )}
              {layers.affinity && <LegendItem glyph={<span className="w-4 border-t-2 border-dotted border-[#a7a4b8]" />}>shared topic</LegendItem>}
              {layers.topics && <LegendItem glyph={<span className="text-[11px] leading-none" style={{ color: TOPIC_COLOR.hue }}>⬡</span>}>topic</LegendItem>}
              {view === 'network' && (
                <LegendItem glyph={<span className="h-2.5 w-2.5 rounded-full border border-dashed border-fg-muted" />}>outer ring: no links</LegendItem>
              )}
            </>
          )}
        </ul>
      </div>

      <div className="absolute bottom-3 right-3 z-10 flex flex-col items-end gap-2 max-md:bottom-auto max-md:top-[6.5rem]">
        <canvas
          ref={minimapRef}
          hidden={is3D}
          aria-label="Minimap. Click to move there."
          // A class, not only the attribute: md:block would override [hidden].
          className={cn('h-[116px] w-[176px] cursor-crosshair rounded-lg border border-border-subtle', is3D ? 'hidden' : 'hidden md:block')}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            c()?.minimapPoint(e.nativeEvent);
          }}
          onPointerMove={(e) => {
            if (e.buttons) c()?.minimapPoint(e.nativeEvent);
          }}
        />
        {is3D && (
          <div className={cn(GLASS, 'flex gap-0.5 rounded-lg p-[3px]')} role="group" aria-label="Brain orientation">
            {(['side', 'top', 'front'] as const).map((a) => (
              <ToggleButton
                key={a}
                isSelected={angle === a}
                onChange={() => c()?.setAngle(a)}
                className="rounded-md px-2 py-1 text-xs capitalize text-fg-secondary outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 selected:bg-bg-elevated selected:text-fg-primary"
              >
                {a}
              </ToggleButton>
            ))}
            {!reduceMotion && (
              <ToggleButton
                isSelected={spinning}
                onChange={(on) => c()?.setSpin(on)}
                className="rounded-md px-2 py-1 text-xs text-fg-secondary outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 selected:bg-bg-elevated selected:text-fg-primary"
              >
                Spin
              </ToggleButton>
            )}
          </div>
        )}
        <div className={cn(GLASS, 'flex items-center gap-1 rounded-lg p-1 font-mono text-[11px]')}>
          <ZoomButton label="Fit to view" onPress={() => c()?.fit()}>
            fit
          </ZoomButton>
          <ZoomButton label="Zoom out" onPress={() => c()?.zoom(0.8)}>
            −
          </ZoomButton>
          <ZoomButton label="Zoom in" onPress={() => c()?.zoom(1.25)}>
            +
          </ZoomButton>
        </div>
      </div>

      {toast && (
        <div role="status" className={cn(GLASS, 'absolute bottom-6 left-1/2 z-30 max-w-[min(520px,calc(100%-2rem))] -translate-x-1/2 rounded-lg px-3.5 py-2 text-center text-sm text-fg-primary')}>
          {toast}
        </div>
      )}
    </div>
  );
}

/** Wheel has to be a native, non-passive listener: React's is passive and cannot stop the page scrolling. */
function WheelBinder({
  target,
  controller,
}: {
  target: RefObject<HTMLCanvasElement | null>;
  controller: RefObject<GraphController | null>;
}) {
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => controller.current?.wheel(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [target, controller]);
  return null;
}

function Tooltip({ node, vaultLabel }: { node: GraphNode; vaultLabel: string }) {
  if (node.kind === 'topic') {
    return (
      <>
        <b className="text-[13px] font-semibold text-fg-primary">{node.label}</b>
        <span className="text-fg-secondary">Topic · carried by {node.carriers} notes</span>
      </>
    );
  }
  return (
    <>
      <b className="text-[13px] font-semibold text-fg-primary">{node.label}</b>
      <span className="text-fg-secondary">
        {node.isIndex ? 'Project index' : node.project?.label} · {vaultLabel}
      </span>
      <span className="font-mono text-[11px] text-fg-muted">
        {edited(node.updatedAt)} · {node.degree} connections
      </span>
    </>
  );
}

function CountryTooltip({ country, vaultLabel }: { country: CountryHover; vaultLabel: string }) {
  return (
    <>
      <b className="text-[13px] font-semibold text-fg-primary">{country.label}</b>
      <span className="text-fg-secondary">
        {country.notes} {country.notes === 1 ? 'note' : 'notes'}
        {country.folders > 0 && ` · ${country.folders} ${country.folders === 1 ? 'folder' : 'folders'}`} · {vaultLabel}
      </span>
      <span className="font-mono text-[11px] text-fg-muted">
        {country.routes} {country.routes === 1 ? 'route' : 'routes'} to other projects · click to zoom in
      </span>
    </>
  );
}

function LegendItem({ glyph, children }: { glyph: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className="inline-flex items-center">
        {glyph}
      </span>
      {children}
    </li>
  );
}

function ZoomButton({ label, onPress, children }: { label: string; onPress(): void; children: ReactNode }) {
  return (
    <Button
      aria-label={label}
      onPress={onPress}
      className="h-[26px] min-w-[26px] rounded-md border border-border-subtle bg-bg-elevated px-1.5 text-fg-secondary outline-none hover:border-border-strong hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {children}
    </Button>
  );
}
