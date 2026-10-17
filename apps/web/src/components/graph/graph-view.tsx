'use client';

// The graph page's canvas and chrome. Three views of the same notes, each
// answering its own question — Brain (3D, inside a brain), Network (how it
// connects) and Territories (what there is and where it is filed) — and one
// behaviour across all of them: a click brings the camera to a note and opens
// its preview without leaving the graph. One more tab, the Sentinel, comes
// first and opens by default: what the brain hands an assistant, walked before
// your eyes.
//
// The heavy lifting lives outside React: graph-controller runs the loop,
// graph-engine the layout, graph-scene the WebGL, graph-overlay the text.
// This file owns what React is good at: the toolbar, panels and preferences.

import { Brain, Map as MapIcon, Network, Play, ScanEye, Square } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  Component,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button, ToggleButton, ToggleButtonGroup, type PressEvent } from 'react-aria-components';

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
import {
  BRIDGE_COLOR,
  LABEL_COLORS,
  OWN_VAULT_COLOR,
  SHARED_VAULT_COLORS,
  TOPIC_COLOR,
} from '@/lib/graph-palette';
import { cn } from '@/lib/utils';

import {
  CHOICE_KEY,
  LEGACY_VIEW_KEY,
  openingView,
  rememberedChoice,
  type ViewChoice,
} from './crawl/view-choice';
import { GraphController, type CountryHover, type Selection } from './graph-controller';
import type { KitPlace } from './graph-kit';
import { browserShortcut, reachesGraph, withoutPointer, type KeyOrigin } from './graph-keys';
import { GraphLayersMenu } from './graph-layers';
import { FLOAT_GLASS, GLASS, GraphPreview, edited } from './graph-preview';
import { readReturn, writeReturn } from './graph-return';
import { FilterChips, GraphSearch } from './graph-search';
import { LINEART_VIEWS, STYLE_KEY, graphStyle, type GraphStyle } from './graph-style';
import { chromeRects } from './labels/chrome';

/** The preview sheet's heading, where focus goes after a pick made from the keyboard. */
const SHEET_HEADING = '[data-graph-sheet] h3';

/** Where on the stage a key was pressed, for `reachesGraph`. */
function keyOrigin(target: HTMLElement, canvas: HTMLCanvasElement | null): KeyOrigin {
  if (target === canvas) return 'canvas';
  if (!target.closest('[data-graph-sheet]')) return 'elsewhere';
  return target.matches(SHEET_HEADING) ? 'sheet-heading' : 'sheet';
}

/**
 * How a pointer focuses the canvas: for its keys, without the ring. Chrome shows the ring on a
 * script's focus() unless what had focus before was focused by the mouse — so on the first click
 * after a reload, or after typing in the search — and `focusVisible: false` says not to. It is
 * newer than TypeScript's DOM types, hence a constant rather than a literal; a browser that does
 * not know it ignores it.
 */
const POINTER_FOCUS = { preventScroll: true, focusVisible: false };
/** Between the toolbar and what a phone puts under it, px: the toolbar's own gap between rows. */
const TOOLBAR_GAP = 8;

interface GraphViewProps {
  nodes: InputNode[];
  edges: InputEdge[];
  /** Shared topics and the edges they imply; null until loaded. */
  affinity: AffinityInput | null;
  /** Who is looking: a node owned by anyone else is a shared note. */
  viewerId: string | null;
  /** Owner id → how to name their vault. */
  vaultNames: ReadonlyMap<string, SharedVaultName>;
  /** Whether shared vaults are fetched at all. */
  includeShared: boolean;
  onIncludeSharedChange(include: boolean): void;
  /**
   * Whether the browser's graph preferences are read and kept: layers, the last layout, the view
   * last chosen. On by default; the bench turns it off, so every run starts cold and the
   * graph page's own preferences stay as they were.
   */
  persist?: boolean;
  /**
   * Whether the preview reads each note's first lines from the server. On by default; the bench
   * turns it off: its vault is invented, and a read without a session signs the page out.
   */
  excerpts?: boolean;
}

const LAYERS_KEY = 'brainstack.graph.layers';
const LAYOUT_KEY = 'brainstack.graph.layout';

const VIEWS: Array<{ id: View; label: string; icon: typeof Brain; hint: string }> = [
  {
    id: 'brain',
    label: 'Brain',
    icon: Brain,
    hint: 'Drag to turn the brain, Shift+drag to move it. Click a note to focus it.',
  },
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

// The Sentinel is not a fourth layout. Under it the engine shows the brain,
// and components/graph/crawl plugs into the controller (a GraphPlugin) with a
// stage of its own — the dormant network of your notes, which the Sentinel
// walks — that the graph steps aside for, and gives back as it was on leaving.
// The engine never hears of it. The folder is loaded only when the view opens
// (SentinelPanel below), so the other three never download it.
/** Territories in line art, while it is in beta: what the plates are, and how to move them. */
const LINEART_HINT =
  'Line art, in beta. Each vault is a plate, each project a plate on it and each folder a plate on that; every note is a block. Drag to move the map and scroll to zoom; Q and E turn it, and P looks straight down. Shift+click two notes for the path between them.';

const NETWORK_LINEART_HINT =
  'Line art, in beta. Every note is a column on one board, where its links pull it; a link between two projects arcs over it. Select a note and it rises with what it links to, wired between the two levels. Drag to move the board and scroll to zoom; Q and E turn it, and P looks straight down. Shift+click two notes for the path between them.';

const SENTINEL_HINT =
  'Ask your brain something and watch the Sentinel look for it: it walks the links to every note your question refers to, and lights each thread it takes. Drag to look around while it walks.';
const GRAPH_LABEL =
  'Graph of your notes. With a note selected, arrow keys move along its links and Enter opens it.';
const LINEART_LABEL =
  'Territories in line art. Arrow keys move between notes, Space shows the one you are on and Enter opens it, Shift+Enter traces a path to it, and ] and [ walk the selected note’s links. Q and E turn the map, P looks straight down, Escape steps out a level.';
const NETWORK_LINEART_LABEL =
  'Network in line art. With a note selected, arrow keys move along its links and Enter opens it. Q and E turn the board, P looks straight down.';
const SENTINEL_LABEL =
  'The Sentinel walking your notes. Drag to turn the view, Shift+drag to move it; the wheel zooms.';

const SentinelPanel = dynamic(() => import('./crawl/crawl-panel').then((m) => m.CrawlPanel), {
  ssr: false,
});

/**
 * The Sentinel's chunk is fetched when the view opens, from the build the tab
 * was loaded with: after a deploy that chunk may be gone. Failing, it takes the
 * Sentinel down, never the page — the brain stays, with a toast.
 */
class SentinelBoundary extends Component<
  { onError(error: unknown): void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Stored layers over the defaults, each field kept only if it has the right
 * type. Storage is whatever an older version, another tab or a hand left
 * there; `hiddenVaults` that is not an array used to throw on first render.
 */
function storedLayersOr(stored: unknown, defaults: GraphLayers): GraphLayers {
  if (typeof stored !== 'object' || stored === null) return defaults;
  const s = stored as Record<string, unknown>;
  const flag = (key: 'affinity' | 'indexes' | 'topics' | 'routes') =>
    typeof s[key] === 'boolean' ? (s[key] as boolean) : defaults[key];
  return {
    hiddenVaults: Array.isArray(s.hiddenVaults)
      ? s.hiddenVaults.filter((v): v is string => typeof v === 'string')
      : defaults.hiddenVaults,
    affinity: flag('affinity'),
    indexes: flag('indexes'),
    topics: flag('topics'),
    routes: flag('routes'),
  };
}

/** Saved node positions for `view`, skipping any entry that is not three numbers. */
function storedPositions(
  stored: unknown,
  view: View,
): Map<string, { x: number; y: number; z: number }> | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const { view: savedView, positions } = stored as { view?: unknown; positions?: unknown };
  if (savedView !== view || typeof positions !== 'object' || positions === null) return undefined;
  const out = new Map<string, { x: number; y: number; z: number }>();
  for (const [id, p] of Object.entries(positions)) {
    if (Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n))) {
      out.set(id, { x: p[0] as number, y: p[1] as number, z: p[2] as number });
    }
  }
  return out;
}

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

/**
 * This tab's session storage, where the way back from a note is kept (graph-return): per tab, as
 * Back is. Null where the browser refuses it.
 */
function tabStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
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

export function GraphView({
  nodes,
  edges,
  affinity,
  viewerId,
  vaultNames,
  includeShared,
  onIncludeSharedChange,
  persist = true,
  excerpts = true,
}: GraphViewProps) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<GraphController | null>(null);
  const cacheRef = useRef(new Map<string, GraphNode>());
  const builtRef = useRef<{ nodes: InputNode[]; edges: InputEdge[] } | null>(null);
  /** The page opened on the Sentinel: no way back from a note is taken up under it. */
  const openedOnSentinel = useRef(false);

  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>('brain');
  const [sentinel, setSentinel] = useState(false);
  /** The Sentinel walking, its panel on screen: the panel carries the legend of what lights up. */
  const [sentinelWalk, setSentinelWalk] = useState(false);
  const [layers, setLayers] = useState<GraphLayers>(DEFAULT_LAYERS);
  const [webgl, setWebgl] = useState(true);
  /** Line art came and draws the views it has (graph-style). */
  const [lineart, setLineart] = useState(false);
  /** The style chosen: line art draws only once its code has come (`lineart`). */
  const [style, setStyle] = useState<GraphStyle>('classic');
  /** Bumped by every switch of style: a load that comes back after one is dropped. */
  const kitLoad = useRef(0);
  // Line art's code, fetched and handed to the controller; the classic graph shows meanwhile.
  const loadKit = useCallback(
    (controller: GraphController, asked = false) => {
      if (!controller.webgl) return;
      const load = ++kitLoad.current;
      const current = () => controllerRef.current === controller && kitLoad.current === load;
      void import('./iso/kit')
        .then((m) => {
          // Switched back to classic while it came, or asked for again: not this load's to install.
          if (!current()) return;
          controller.setKit(m.createKit());
          setLineart(true);
        })
        .catch((error) => {
          console.warn('Line art failed to load; the classic graph shows.', error);
          if (!current()) return;
          // The box would stay ticked over the classic map.
          setStyle('classic');
          // Stored and failed on the way in, it is kept, so a reload after a deploy that moved the
          // code tries again. Asked for and failed, it is not: the box, unticked, could not undo it,
          // and every visit would fail again.
          if (asked && persist) writePref(STYLE_KEY, 'classic');
          // Said when it was asked for, or where it would have drawn: not over the Brain.
          if (asked || LINEART_VIEWS.includes(controller.view))
            setToast('Line art could not load. Reload the page and try again.');
        });
    },
    [persist],
  );
  /** Where line art's map is, for its breadcrumb. */
  const [place, setPlace] = useState<readonly KitPlace[]>([]);
  /** The note line art's keyboard cursor is on, said to a screen reader. */
  const [cursorNote, setCursorNote] = useState<GraphNode | null>(null);
  const placeRef = useRef<HTMLElement | null>(null);
  // A breadcrumb wider than the stage shows its end, where the map is.
  useEffect(() => {
    const nav = placeRef.current;
    if (nav) nav.scrollLeft = nav.scrollWidth;
  }, [place]);
  const [selection, setSelection] = useState<Selection | null>(null);
  // The selection as the controller last told it: read right after a key or a press in the
  // sheet, to see what it did, when the state is still a render behind.
  const selectionRef = useRef<Selection | null>(null);
  // Focus goes to the sheet's heading once the selection now on its way renders.
  const headingNext = useRef(false);
  // A pointer pressed in the sheet: if what had focus went with the press, the canvas takes it.
  const canvasIfLost = useRef(false);
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
      const c = controllerRef.current;
      // A topic is not a note: "opening" it shows the notes that carry it.
      if (node.kind === 'topic') {
        c?.select(node);
        return;
      }
      // Back from the note, the graph comes up as it is now (see the first layout, below).
      // Not from the Sentinel: its walk is no place to come back to.
      const back = persist && !sentinel ? c?.returnState(node) : null;
      if (back) writeReturn(tabStore(), back, Date.now());
      router.push(noteHref(node));
    },
    [router, persist, sentinel],
  );
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const saveLayout = useCallback(() => {
    const c = controllerRef.current;
    if (persist && c?.model) writePref(LAYOUT_KEY, { view: c.view, positions: c.snapshot() });
  }, [persist]);

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
        onSelection: (s) => {
          selectionRef.current = s;
          setSelection(s);
        },
        onHover: setHovered,
        onHoverCountry: setHoveredCountry,
        onToast: setToast,
        onGrowth: setGrowing,
        onSpin: setSpinning,
        onAngle: setAngle,
        onOpen: (node) => openRef.current(node),
        onSettled: saveLayout,
        onPlace: setPlace,
        onCursor: setCursorNote,
      },
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    controllerRef.current = controller;
    setWebgl(controller.webgl);
    // Line art draws the views it has so far, the classic graph the rest, and all of them without
    // WebGL. Its code comes only when asked for (the layers' Style, or `?style=lineart`), and the
    // graph shows meanwhile.
    const drawn = graphStyle(window.location.search, persist ? readPref(STYLE_KEY) : null);
    setStyle(drawn);
    if (drawn === 'lineart') loadKit(controller);

    const opening = openingView(
      window.location.hash,
      persist ? rememberedChoice(readPref(CHOICE_KEY), readPref(LEGACY_VIEW_KEY)) : null,
      controller.webgl,
    );
    if (opening.sentinel) {
      // Fetched alongside the graph: the panel renders once there is a model and imports the
      // stage when it mounts, so in series the brain would wait under an inert prompt. The same
      // chunks either way; a failure here is the panel's to report, when it imports them itself.
      void import('./crawl/crawl-panel').catch(() => {});
      void import('./crawl/stage/sentinel-stage').catch(() => {});
    }
    // Before the first frame: opening on the Sentinel, the brain must not show while its panel's
    // code arrives and its stage starts.
    controller.awaitPlugin(opening.sentinel);
    openedOnSentinel.current = opening.sentinel;
    controller.initView(opening.view);
    setView(opening.view);
    setSentinel(opening.sentinel);
    setLayers(
      persist ? storedLayersOr(readPref<unknown>(LAYERS_KEY), DEFAULT_LAYERS) : DEFAULT_LAYERS,
    );
    setReady(true);

    const onLeave = () => saveLayout();
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      saveLayout();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [saveLayout, persist, loadKit]);

  // The chrome's rectangles for the labels to keep clear of, measured again whenever something
  // in the stage appears, goes, changes class or changes its text (a panel, the search's
  // results, the legend hiding, the growth chip counting up) or the stage resizes — at most
  // once a frame. Not under the Sentinel: its stage draws no graph labels, and its cards measure
  // the chrome themselves, as the panel slides in.
  useEffect(() => {
    const stage = stageRef.current;
    if (!ready || !stage) return;
    if (sentinel) {
      controllerRef.current?.setChrome([]);
      return;
    }
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        controllerRef.current?.setChrome(chromeRects(stage));
      });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(stage);
    const mutations = new MutationObserver(schedule);
    mutations.observe(stage, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'data-toolbar-bottom'],
    });
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [ready, sentinel]);

  // On a phone the toolbar wraps onto as many rows as its controls need, one more while a search
  // is typed, and the zoom controls and the growth chip go under it wherever it ends: at fixed
  // offsets, a longer toolbar ran under them. Two variables on the stage say where.
  useEffect(() => {
    const stage = stageRef.current;
    const bar = toolbarRef.current;
    const tools = toolsRef.current;
    if (!stage || !bar || !tools) return;
    const place = () => {
      // Both read before either is written: a write between them would lay the page out twice.
      const below = bar.offsetTop + bar.offsetHeight + TOOLBAR_GAP;
      const tall = tools.offsetHeight;
      stage.style.setProperty('--graph-below-toolbar', `${below}px`);
      stage.style.setProperty('--graph-below-tools', `${below + tall + TOOLBAR_GAP}px`);
      // Moved, they are chrome somewhere else: the attribute tells the labels' measuring to look
      // again, which watches attributes, not styles (the tooltip writes its own every frame).
      stage.dataset.toolbarBottom = String(below);
    };
    const resize = new ResizeObserver(place);
    resize.observe(bar);
    resize.observe(tools);
    place();
    return () => resize.disconnect();
  }, []);

  // A topic belongs to no project, so it has no place on the map: Territories
  // leaves topic nodes out whatever the layer says, and the others bring them back.
  // Topics have no place on the map, nor on line art's board, which draws notes only.
  const modelLayers = useMemo(
    () =>
      (view === 'territories' || (lineart && view === 'network')) && layers.topics
        ? { ...layers, topics: false }
        : layers,
    [view, layers, lineart],
  );
  const model = useMemo(
    () =>
      ready
        ? buildGraphModel({
            nodes,
            edges,
            affinity,
            layers: modelLayers,
            viewerId,
            vaultNames,
            cache: cacheRef.current,
          })
        : null,
    [ready, nodes, edges, affinity, modelLayers, viewerId, vaultNames],
  );

  useEffect(() => {
    const c = controllerRef.current;
    if (!c || !model) return;
    const previous = builtRef.current;
    builtRef.current = { nodes, edges };
    if (!previous) {
      // First layout: start from where the notes were last time, if it was this view.
      const saved = persist ? storedPositions(readPref<unknown>(LAYOUT_KEY), c.view) : undefined;
      c.setModel(model, 'init', saved);
      // Back from a note opened here: the graph comes up as it was left, in the view it was left
      // in. Taken here, not on mount: StrictMode mounts twice, and the first would take it from
      // the second.
      if (persist) {
        const back = readReturn(tabStore(), c.view, Date.now());
        if (back && !openedOnSentinel.current) c.restore(back);
      }
    } else {
      c.setModel(model, previous.nodes !== nodes || previous.edges !== edges ? 'data' : 'layers');
    }
  }, [model, nodes, edges, persist]);

  // The hash follows the view, so a reload stays on it; the choice is remembered only when picked (`choose`).
  useEffect(() => {
    if (!ready) return;
    controllerRef.current?.setView(view);
    try {
      history.replaceState(null, '', `#${sentinel ? 'sentinel' : view}`);
    } catch {
      // a sandboxed frame may refuse; the hash is a convenience
    }
  }, [view, sentinel, ready]);

  /** A tab or a key: the view, and the choice remembered for the next visit. Brain and the Sentinel need WebGL. */
  const choose = (choice: ViewChoice) => {
    if ((choice === 'brain' || choice === 'sentinel') && !webgl) return;
    setSentinel(choice === 'sentinel');
    setView(choice === 'sentinel' ? 'brain' : choice);
    if (persist) writePref(CHOICE_KEY, choice);
  };

  // Into the Sentinel from another view, the brain goes dark at once rather than stay under an
  // inert prompt until the stage is ready; out of it (or when it fails to load), it comes back.
  // Not before `ready`: the opening view was set in the mount effect, before the first frame.
  useEffect(() => {
    if (ready) controllerRef.current?.awaitPlugin(sentinel);
  }, [sentinel, ready]);

  const leaveSentinel = useCallback((error: unknown) => {
    console.warn('Sentinel: the view failed to load; the brain shows instead.', error);
    setSentinel(false);
    setToast('The Sentinel could not load. Reload the page to try again.');
  }, []);

  useEffect(() => {
    if (ready && persist) writePref(LAYERS_KEY, layers);
    controllerRef.current?.setRoutes(layers.routes);
  }, [layers, ready, persist]);

  // "Edited this week" is measured from when the search last changed, which is close enough for a filter.
  const matches = useMemo(
    () => (model ? searchGraph(model.nodes, query, filters, Date.now()) : null),
    [model, query, filters],
  );
  // Search and filters are hidden in the Sentinel, so what they left lit in the brain goes dark there.
  useEffect(() => {
    controllerRef.current?.setMatches(sentinel ? null : matches);
  }, [matches, sentinel]);
  const currentMatch =
    selection?.kind === 'note' && matches?.includes(selection.node) ? selection.node : null;

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
      // The Sentinel has no search box: the key is left alone there.
      if (!searchRef.current) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const focusCanvas = () => overlayRef.current?.focus({ preventScroll: true });

  /**
   * After the keyboard or a screen reader acted from the sheet, focus follows what it did: the
   * element that had it may be gone — a row of the note left behind, the sheet itself — and with
   * it every key the graph listens for. With nothing selected any more, to the canvas; with
   * something else, to its heading once it renders, so its title is read out and Tab goes on
   * from there through the note's actions and its connections.
   */
  const refocus = (before: Selection | null) => {
    const now = selectionRef.current;
    if (!now) focusCanvas();
    else if (now !== before) headingNext.current = true;
  };

  /**
   * A press in the sheet; focus moves with what it did only when no pointer made it. After a
   * mouse or a finger it stays where it was, unless that was the button pressed and the press
   * took it away (a row of the note left behind, Back to the first note): then the canvas takes
   * it, quietly, or no key would reach the graph until it was clicked again.
   */
  const fromSheet = (e: PressEvent, act: () => void) => {
    const before = selectionRef.current;
    act();
    if (withoutPointer(e.pointerType)) refocus(before);
    else canvasIfLost.current = true;
  };

  useEffect(() => {
    const lost = canvasIfLost.current;
    canvasIfLost.current = false;
    if (headingNext.current) {
      headingNext.current = false;
      stageRef.current?.querySelector<HTMLElement>(SHEET_HEADING)?.focus();
      return;
    }
    const active = document.activeElement;
    if (lost && (!active || active === document.body)) overlayRef.current?.focus(POINTER_FOCUS);
  }, [selection]);

  // Line art draws this view: its legend is its own. Territories' map has places and a cursor
  // of its own; Network's board has neither, and its keys are the classic graph's.
  const kitView = lineart && !sentinel && LINEART_VIEWS.includes(view);
  const mapKit = kitView && view === 'territories';

  const onStageKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // Popovers render through a portal but their key events still bubble here. A field keeps its
    // keys, but for Escape in the sheet's filter once it is empty (it empties it first): from
    // anywhere in the sheet, Escape closes.
    const sheetEscape =
      e.key === 'Escape' && !e.nativeEvent.isComposing && !!t.closest('[data-graph-sheet]');
    if ((/^(INPUT|TEXTAREA)$/.test(t.tagName) && !sheetEscape) || t.closest('[role=dialog]'))
      return;
    // The keys follow the tabs: the Sentinel first, then the three layouts.
    const index = ['1', '2', '3', '4'].indexOf(e.key);
    if (index >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      choose(index === 0 ? 'sentinel' : GRAPH_VIEWS[index - 1]!);
      e.preventDefault();
      return;
    }
    if (browserShortcut(e)) return;
    const origin = keyOrigin(t, overlayRef.current);
    if (!reachesGraph(e.key, origin, mapKit)) return;
    const before = selectionRef.current;
    if (!controllerRef.current?.keyDown(e.nativeEvent)) return;
    e.preventDefault();
    if (origin !== 'canvas') refocus(before);
  };

  const c = () => controllerRef.current;
  const is3D = view === 'brain';
  const visibleVaults = model?.vaults.filter((v) => !v.hidden) ?? [];
  const hint = sentinel
    ? SENTINEL_HINT
    : mapKit
      ? LINEART_HINT
      : kitView
        ? NETWORK_LINEART_HINT
        : VIEWS.find((v) => v.id === view)!.hint;

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
        aria-label={
          sentinel
            ? SENTINEL_LABEL
            : mapKit
              ? LINEART_LABEL
              : kitView
                ? NETWORK_LINEART_LABEL
                : GRAPH_LABEL
        }
        // The ring for keyboard focus is an outline drawn inside: the stage clips anything outside,
        // and a ring's inset shadow would paint under the canvas's bitmap.
        className="absolute inset-0 block h-full w-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/60"
        style={{ touchAction: 'none', cursor: 'grab' }}
        onPointerDown={(e) => {
          e.currentTarget.focus(POINTER_FOCUS);
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
      {mapKit && (
        // Where line art's keyboard cursor is, said: on the canvas it is only brackets.
        <p className="sr-only" aria-live="polite">
          {cursorNote?.title ?? ''}
        </p>
      )}

      <div
        ref={toolbarRef}
        data-graph-chrome="children"
        className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2"
      >
        <ToggleButtonGroup
          aria-label="View"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[sentinel ? 'sentinel' : view]}
          onSelectionChange={(keys) => {
            const next = [...keys][0] as ViewChoice | undefined;
            if (next) choose(next);
          }}
          className={cn(FLOAT_GLASS, 'pointer-events-auto flex gap-0.5 rounded-xl p-[3px]')}
        >
          <ToggleButton
            id="sentinel"
            isDisabled={!webgl}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-fg-secondary outline-none touch:min-h-11 max-sm:[&>svg]:hidden',
              'hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
              'selected:bg-accent/15 selected:text-fg-primary selected:ring-1 selected:ring-inset selected:ring-accent/35',
            )}
          >
            <ScanEye size={14} aria-hidden />
            Sentinel
          </ToggleButton>
          {VIEWS.map((v) => (
            <ToggleButton
              key={v.id}
              id={v.id}
              isDisabled={v.id === 'brain' && !webgl}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-fg-secondary outline-none touch:min-h-11 max-sm:[&>svg]:hidden',
                'hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
                'selected:bg-accent/15 selected:text-fg-primary selected:ring-1 selected:ring-inset selected:ring-accent/35',
              )}
            >
              <v.icon size={14} aria-hidden />
              {v.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {/*
          The brain's own tools: the Sentinel keeps the views, zoom and Fit. The layers still
          decide which notes its walk can reach; the panel says when they left some out.
        */}
        {model && !sentinel && (
          <GraphLayersMenu
            model={model}
            layers={layers}
            onChange={setLayers}
            view={view}
            includeShared={includeShared}
            onIncludeSharedChange={onIncludeSharedChange}
            // Line art needs WebGL; without it there is no style to choose.
            {...(webgl && {
              style,
              onStyleChange: (next: GraphStyle) => {
                const controller = controllerRef.current;
                setStyle(next);
                if (persist) writePref(STYLE_KEY, next);
                if (!controller) return;
                // Switched live: the kit comes or goes, and the graph is not mounted again.
                if (next === 'lineart') loadKit(controller, true);
                else {
                  // A load still on its way is dropped when it comes.
                  kitLoad.current++;
                  controller.setKit(null);
                  setLineart(false);
                }
              },
            })}
          />
        )}
        {model && !sentinel && (
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

        {!sentinel && (
          <Button
            onPress={() => (growing ? c()?.stopGrowth() : c()?.startGrowth())}
            isDisabled={!model?.nodes.length}
            className={cn(
              GLASS,
              'pointer-events-auto flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-fg-primary outline-none touch:h-11',
              'hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
            )}
          >
            {growing ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}
            {growing ? 'Stop' : 'Replay growth'}
          </Button>
        )}

        {model && !sentinel && (
          <FilterChips model={model} filters={filters} onChange={setFilters} />
        )}

        {mapKit && (
          // A row of its own under the tools, measured at its own size: the rest of the row is map.
          <div data-graph-chrome="children" className="pointer-events-none flex basis-full">
            <nav
              ref={placeRef}
              aria-label="Where the map is"
              className={cn(
                GLASS,
                'pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg px-1.5 py-1',
              )}
            >
              {[{ id: null, label: 'Territories' }, ...place].map((step, i, all) => (
                <Fragment key={step.id ?? 'map'}>
                  {i > 0 && (
                    <span aria-hidden className="font-mono text-xs text-fg-tertiary">
                      ›
                    </span>
                  )}
                  <Button
                    onPress={() => c()?.focusPlace(step.id)}
                    aria-current={i === all.length - 1 ? 'location' : undefined}
                    className="h-7 whitespace-nowrap rounded-md px-1.5 font-mono text-xs text-fg-secondary outline-none hover:bg-bg-hover hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 aria-[current]:text-fg-primary touch:h-11"
                  >
                    {step.label}
                  </Button>
                </Fragment>
              ))}
            </nav>
          </div>
        )}
      </div>

      {sentinel && model && controllerRef.current && (
        <SentinelBoundary onError={leaveSentinel}>
          <SentinelPanel
            controller={controllerRef.current}
            reduceMotion={reduceMotion}
            onCrawl={setSentinelWalk}
          />
        </SentinelBoundary>
      )}

      {selection && model && (
        <GraphPreview
          selection={selection}
          model={model}
          onSelect={(n, e) => fromSheet(e, () => c()?.select(n))}
          onOpen={open}
          // Line art traces no paths yet.
          onPathFrom={(n) => c()?.startPathFrom(n)}
          onBack={(e) => fromSheet(e, () => c()?.back())}
          onFrame={(notes) => c()?.frameNotes(notes)}
          walk={mapKit ? 'brackets' : 'arrows'}
          excerpts={excerpts}
          onClose={() => {
            c()?.clearSelection();
            // Whatever pressed it: the button goes with the sheet, and the keys stay the graph's.
            focusCanvas();
          }}
        />
      )}

      <div
        ref={tooltipRef}
        // Display comes from a class, not the `hidden` attribute: `grid` would override [hidden].
        // Not chrome: the controller places it clear of the labels, and labels that dodged it
        // as well would chase it from frame to frame.
        className={cn(
          GLASS,
          'pointer-events-none absolute z-20 max-w-[280px] gap-px rounded-lg px-2.5 py-2 text-xs',
          hovered || hoveredCountry ? 'grid' : 'hidden',
        )}
      >
        {hovered ? (
          <Tooltip
            node={hovered}
            vaultLabel={model?.vaults.find((v) => v.id === hovered.vault)?.label ?? ''}
          />
        ) : (
          hoveredCountry && (
            <CountryTooltip
              country={hoveredCountry}
              vaultLabel={model?.vaults.find((v) => v.id === hoveredCountry.vault)?.label ?? ''}
            />
          )
        )}
      </div>

      <div
        ref={chipRef}
        hidden
        data-graph-chrome
        aria-live="polite"
        className={cn(
          GLASS,
          // On a phone the toolbar wraps further down, and the zoom controls sit under it: the
          // chip waits under both.
          'absolute left-1/2 top-16 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-3.5 py-1.5 font-mono text-sm text-fg-primary max-md:top-[var(--graph-below-tools,12rem)]',
        )}
      />

      <div
        data-graph-chrome
        className={cn(
          GLASS,
          'absolute bottom-3 left-3 z-10 grid max-w-[calc(100%-1.5rem)] gap-1.5 rounded-lg px-3 py-2.5 text-xs text-fg-secondary md:max-w-[min(560px,calc(100%-15rem))]',
          // On a phone the Sentinel's recents need the room under the prompt.
          (selection || sentinel) && 'max-md:hidden',
          // In the walk, the panel takes the whole height and counts what lit up in its colours.
          sentinel && sentinelWalk && 'hidden',
        )}
      >
        <p className="text-[12.5px] leading-snug text-fg-primary">
          {hint}
          {!webgl && ' This browser has no WebGL, so the 3D brain is unavailable.'}
        </p>
        {/* Line art's marks are not these: its legend comes with its labels. */}
        <ul className={cn('flex flex-wrap gap-x-3.5 gap-y-1', kitView && 'hidden')}>
          {visibleVaults.map((v) => (
            <LegendItem
              key={v.id}
              glyph={
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: v.color.hue, boxShadow: `0 0 6px ${v.color.hue}` }}
                />
              }
            >
              {v.label}
            </LegendItem>
          ))}
          {/* At the Sentinel's prompt nothing has lit up yet; in its walk, the panel says what did. */}
          {!sentinel && (
            <>
              <LegendItem
                glyph={
                  <span className="flex gap-[3px]">
                    {[0.35, 0.6, 1].map((o) => (
                      <span
                        key={o}
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ opacity: o, background: OWN_VAULT_COLOR.core }}
                      />
                    ))}
                  </span>
                }
              >
                brightness = recent activity
              </LegendItem>
              {layers.indexes && (
                <LegendItem
                  glyph={
                    <span
                      className="h-2 w-2 rounded-[2px]"
                      style={{ background: LABEL_COLORS.index }}
                    />
                  }
                >
                  index
                </LegendItem>
              )}
              {visibleVaults.some((v) => !v.own) && (
                <LegendItem
                  glyph={
                    <span
                      className="h-2 w-2 rounded-full border-2"
                      style={{ borderColor: SHARED_VAULT_COLORS[0]!.hue }}
                    />
                  }
                >
                  someone else&apos;s note
                </LegendItem>
              )}
              {view === 'territories' ? (
                <>
                  <LegendItem
                    glyph={
                      <span
                        className="h-2.5 w-4 rounded-[3px] border"
                        style={{
                          borderColor: OWN_VAULT_COLOR.hue,
                          background: `${OWN_VAULT_COLOR.hue}40`,
                        }}
                      />
                    }
                  >
                    project
                  </LegendItem>
                  <LegendItem
                    glyph={
                      <span
                        className="w-4 border-t border-dashed"
                        style={{ borderColor: OWN_VAULT_COLOR.hue }}
                      />
                    }
                  >
                    folder
                  </LegendItem>
                  <LegendItem glyph={<span className="w-4 border-t border-white/80" />}>
                    route, on hover
                  </LegendItem>
                </>
              ) : (
                <>
                  <LegendItem
                    glyph={
                      <span className="w-4 border-t" style={{ borderColor: OWN_VAULT_COLOR.hue }} />
                    }
                  >
                    link
                  </LegendItem>
                  {view === 'network' && (
                    <LegendItem
                      glyph={
                        <span
                          className="w-4 border-t-2"
                          style={{ borderColor: BRIDGE_COLOR.hue }}
                        />
                      }
                    >
                      link between projects
                    </LegendItem>
                  )}
                  {layers.affinity && (
                    <LegendItem
                      glyph={<span className="w-4 border-t-2 border-dotted border-[#a7a4b8]" />}
                    >
                      shared topic
                    </LegendItem>
                  )}
                  {layers.topics && (
                    <LegendItem
                      glyph={
                        <span
                          className="text-[11px] leading-none"
                          style={{ color: TOPIC_COLOR.hue }}
                        >
                          ⬡
                        </span>
                      }
                    >
                      topic
                    </LegendItem>
                  )}
                  {view === 'network' && (
                    <LegendItem
                      glyph={
                        <span className="h-2.5 w-2.5 rounded-full border border-dashed border-fg-muted" />
                      }
                    >
                      outer ring: no links
                    </LegendItem>
                  )}
                </>
              )}
            </>
          )}
        </ul>
        {kitView && !mapKit && (
          <ul className="flex flex-wrap gap-x-3.5 gap-y-1" aria-label="What the marks mean">
            <LegendItem glyph={<LineArtGlyph kind="note" />}>note</LegendItem>
            <LegendItem glyph={<LineArtGlyph kind="flat" />}>link</LegendItem>
            <LegendItem glyph={<LineArtGlyph kind="arc" />}>link between projects</LegendItem>
            <LegendItem glyph={<LineArtGlyph kind="link" />}>link of the selected note</LegendItem>
            <LegendItem glyph={<LineArtGlyph kind="hidden" />}>behind something</LegendItem>
            <LegendItem glyph={<LineArtGlyph kind="found" />}>search match</LegendItem>
            {selection?.kind === 'path' && (
              <LegendItem glyph={<LineArtGlyph kind="path" />}>a path, step by step</LegendItem>
            )}
          </ul>
        )}
        {mapKit && (
          <ul className="flex flex-wrap gap-x-3.5 gap-y-1" aria-label="What the marks mean">
            <LegendItem glyph={<LineArtGlyph kind="note" />}>note</LegendItem>
            {layers.indexes && (
              <LegendItem glyph={<LineArtGlyph kind="index" />}>project&apos;s index</LegendItem>
            )}
            {visibleVaults.some((v) => !v.own) && (
              <LegendItem glyph={<LineArtGlyph kind="shared" />}>shared vault</LegendItem>
            )}
            <LegendItem glyph={<LineArtGlyph kind="link" />}>link of the selected note</LegendItem>
            <LegendItem glyph={<LineArtGlyph kind="hidden" />}>behind something</LegendItem>
            <LegendItem glyph={<LineArtGlyph kind="found" />}>search match</LegendItem>
            {layers.routes && (
              <LegendItem glyph={<LineArtGlyph kind="route" />}>links between projects</LegendItem>
            )}
            {selection?.kind === 'path' && (
              <LegendItem glyph={<LineArtGlyph kind="path" />}>a path, step by step</LegendItem>
            )}
          </ul>
        )}
      </div>

      <div
        ref={toolsRef}
        data-graph-chrome="children"
        // On a phone, under the toolbar, however many rows it has wrapped onto.
        className="absolute bottom-3 right-3 z-10 flex flex-col items-end gap-2 max-md:bottom-auto max-md:top-[var(--graph-below-toolbar,6.5rem)]"
      >
        <canvas
          ref={minimapRef}
          hidden={is3D}
          aria-label="Minimap. Click to move there."
          // A class, not only the attribute: md:block would override [hidden].
          className={cn(
            'h-[116px] w-[176px] cursor-crosshair rounded-lg border border-border-subtle',
            is3D ? 'hidden' : 'hidden md:block',
          )}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            c()?.minimapPoint(e.nativeEvent);
          }}
          onPointerMove={(e) => {
            if (e.buttons) c()?.minimapPoint(e.nativeEvent);
          }}
        />
        {is3D && !sentinel && (
          <div
            className={cn(GLASS, 'flex gap-0.5 rounded-lg p-[3px]')}
            role="group"
            aria-label="Brain orientation"
          >
            {(['side', 'top', 'front'] as const).map((a) => (
              <ToggleButton
                key={a}
                isSelected={angle === a}
                onChange={() => c()?.setAngle(a)}
                className="rounded-md px-2 py-1 text-xs capitalize text-fg-secondary outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 selected:bg-bg-elevated selected:text-fg-primary touch:min-h-11"
              >
                {a}
              </ToggleButton>
            ))}
            {!reduceMotion && (
              <ToggleButton
                isSelected={spinning}
                onChange={(on) => c()?.setSpin(on)}
                className="rounded-md px-2 py-1 text-xs text-fg-secondary outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 selected:bg-bg-elevated selected:text-fg-primary touch:min-h-11"
              >
                Spin
              </ToggleButton>
            )}
          </div>
        )}
        <div
          className={cn(
            FLOAT_GLASS,
            'flex items-center gap-1 rounded-xl p-1 font-mono text-[11px]',
          )}
        >
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
        <div
          role="status"
          data-graph-chrome
          className={cn(
            GLASS,
            'absolute bottom-6 left-1/2 z-30 max-w-[min(520px,calc(100%-2rem))] -translate-x-1/2 rounded-lg px-3.5 py-2 text-center text-sm text-fg-primary',
          )}
        >
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
      <span className="font-mono text-[11px] text-fg-tertiary">
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
        {country.folders > 0 &&
          ` · ${country.folders} ${country.folders === 1 ? 'folder' : 'folders'}`}{' '}
        · {vaultLabel}
      </span>
      <span className="font-mono text-[11px] text-fg-tertiary">
        {country.routes} {country.routes === 1 ? 'route' : 'routes'} to other projects · click to
        zoom in
      </span>
    </>
  );
}

/** Line art's marks, drawn as the map draws them, in its tokens. */
function LineArtGlyph({
  kind,
}: {
  kind:
    | 'note'
    | 'index'
    | 'shared'
    | 'link'
    | 'hidden'
    | 'found'
    | 'route'
    | 'path'
    | 'flat'
    | 'arc';
}) {
  const edge = 'var(--graph-la-block-edge)';
  const block = (
    <>
      <path d="M14 3 22 7 14 11 6 7Z" fill="var(--graph-la-block-top)" stroke={edge} />
      <path d="M6 7v4l8 4v-4M22 7v4l-8 4" fill="none" stroke={edge} />
    </>
  );
  return (
    <svg viewBox="0 0 28 18" className="h-3 w-5">
      {kind === 'note' && block}
      {kind === 'index' && (
        <>
          {block}
          <path d="M14 5 18 7 14 9 10 7Z" fill="none" stroke={edge} />
        </>
      )}
      {kind === 'shared' && (
        <path
          d="M2 9 14 3 26 9 14 15Z"
          fill="none"
          stroke="var(--graph-la-route)"
          strokeDasharray="3 2.5"
        />
      )}
      {kind === 'link' && (
        <path d="M3 12h9V6h13" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      )}
      {kind === 'hidden' && (
        <path
          d="M3 12h9V6h13"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.2"
          strokeDasharray="3 3"
          opacity="0.6"
        />
      )}
      {kind === 'found' && (
        <path
          d="M7 6V3h3M18 3h3v3M21 12v3h-3M10 15H7v-3"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
        />
      )}
      {kind === 'route' && (
        <path d="M3 12h9V6h13" fill="none" stroke="var(--graph-la-route)" strokeWidth="2" />
      )}
      {kind === 'flat' && (
        <path d="M3 12 25 6" fill="none" stroke="var(--graph-la-route)" strokeWidth="1" />
      )}
      {kind === 'arc' && (
        <path d="M3 14Q14 -2 25 14" fill="none" stroke="var(--graph-la-route)" strokeWidth="1.25" />
      )}
      {kind === 'path' && (
        <>
          <path d="M4 13h8V5h12" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
          <circle cx="4" cy="13" r="2" fill="var(--accent)" />
          <circle cx="12" cy="9" r="1.6" fill="var(--accent)" />
          <circle cx="24" cy="5" r="2" fill="var(--accent)" />
        </>
      )}
    </svg>
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

function ZoomButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress(): void;
  children: ReactNode;
}) {
  return (
    <Button
      aria-label={label}
      onPress={onPress}
      className="h-[26px] min-w-[26px] rounded-md border border-border-subtle bg-bg-elevated px-1.5 text-fg-secondary outline-none hover:border-border-strong hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 touch:h-11 touch:min-w-11"
    >
      {children}
    </Button>
  );
}
