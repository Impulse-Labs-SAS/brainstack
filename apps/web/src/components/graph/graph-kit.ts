// The seam a drawing kit plugs into: a style of its own for some views (line art for
// Territories), drawn with the graph's renderer on a camera and a layout of its own, taking the
// pointer and the keys while it draws. The controller holds at most one. With none, or over a
// view it does not handle, or under a plugin's stage, nothing here runs and the classic graph
// draws as it always has. Types only: a kit's code comes with import(), so the classic graph
// never downloads it.

import type { WebGLRenderer } from 'three';

import type { Viewport } from '@/lib/graph-camera';
import type { GraphModel, GraphNode, GraphView } from '@/lib/graph-model';

import type { Rect } from './labels/placer';

/** A step of where the map is: a vault, a project or a folder, by its plate. */
export interface KitPlace {
  id: string;
  kind: 'vault' | 'project' | 'folder';
  label: string;
}

/** What the controller lends a kit while it draws. */
export interface KitHost {
  /** The graph's renderer: one WebGL context on the page. The controller keeps it sized. */
  readonly renderer: WebGLRenderer;
  /** The 2D overlay over it, sized to the stage times the pixel ratio: for crisp text. */
  readonly overlay: CanvasRenderingContext2D;
  readonly fonts: { sans: string; mono: string };
  /** A label's size, CSS pixels: a point larger on a touch screen. */
  readonly labelPx: number;
  readonly reduceMotion: boolean;
  /** The person moved the camera themselves. */
  onUserCamera(): void;
  /** The pointer's look over the stage: 'grab', 'grabbing', 'pointer'. */
  setCursor(cursor: string): void;
  /** A note picked on the map: selected as a click on it selects it, the preview opened. */
  select(node: GraphNode): void;
  /** Bare ground clicked: nothing selected any more. */
  clearSelection(): void;
  /** Open a note's page. */
  open(node: GraphNode): void;
  /** Where the map is now, vault first: for the breadcrumb over it. Empty for the whole map. */
  onPlace(steps: readonly KitPlace[]): void;
  /** The keyboard moved the cursor to a note: for a screen reader to say which. */
  onCursor(node: GraphNode | null): void;
  /**
   * Draw the renderer's buffer at this pixel ratio, lower than the page's when frames come late:
   * the controller gives it back its own when the kit leaves.
   */
  setPixelRatio(dpr: number): void;
}

/** What the kit is handed each frame it draws. */
export interface KitFrame {
  now: number;
  dt: number;
  vp: Viewport;
  dpr: number;
  model: GraphModel;
  /** What floats over the graph, CSS pixels from the stage's corner: framing keeps clear of it. */
  chrome: readonly Rect[];
  selected: GraphNode | null;
  /** A result under the pointer in the results list. */
  previewed: GraphNode | null;
  /** What a search found; null with no search. */
  matches: ReadonlySet<GraphNode> | null;
  /** The All routes layer: every link drawn, between projects. */
  routes: boolean;
}

export interface GraphKit {
  handles(view: GraphView): boolean;
  /** It starts drawing: the classic graph has stopped. */
  enter(host: KitHost, model: GraphModel, vp: Viewport, dpr: number): void;
  /** It stops: the classic graph takes the renderer and the overlay back. */
  leave(): void;
  /** The notes changed, drawing or not: what it lays out next time it draws. */
  setModel(model: GraphModel): void;
  resize(vp: Viewport, dpr: number): void;
  /** Once a frame while it draws. It draws only when something changed since it last did. */
  frame(f: KitFrame): void;
  /** Pointer positions are CSS pixels from the stage's corner. */
  pointerDown(e: PointerEvent, x: number, y: number): void;
  pointerMove(e: PointerEvent, x: number, y: number): void;
  pointerUp(e: PointerEvent, x: number, y: number, cancelled: boolean): void;
  pointerLeave(): void;
  wheel(e: WheelEvent, x: number, y: number): void;
  doubleClick(x: number, y: number): void;
  /** A key the graph was given; true when the kit used it. */
  key(e: KeyboardEvent): boolean;
  fit(): void;
  zoom(factor: number): void;
  /** Fly to a note just selected, from the search or the preview. */
  reveal(node: GraphNode): void;
  /** Bring these notes into view beside the preview: a step up from a note. */
  frameNotes(notes: readonly GraphNode[]): void;
  /** Escape with nothing selected: up a level. False at the top, the whole map in view. */
  up(): boolean;
  /** A step of the breadcrumb, by its plate's id; null for the whole map. */
  focusPlace(id: string | null): void;
  /** Where a note is drawn, CSS pixels from the stage's corner; null when it is off the stage. */
  screenOf(node: GraphNode): { x: number; y: number } | null;
  /** What it drew is gone (a context restored, the fonts in): draw again. */
  invalidate(): void;
  dispose(): void;
}
