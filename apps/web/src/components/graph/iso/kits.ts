// Line art's kits, as the controller holds them: one, which draws each view line art has with the
// kit made for it. Territories' plates and Network's board share nothing but the seam, so each
// keeps a kit of its own, built the first time its view is drawn, and this hands every call to the
// one entered last.

import type { Viewport } from '@/lib/graph-camera';
import type { GraphModel, GraphNode, GraphView } from '@/lib/graph-model';

import type { GraphKit, KitFrame, KitHost } from '../graph-kit';

export class LineArtKits implements GraphKit {
  private network: GraphKit | null = null;
  /** The kit drawing now; null between a leave and the next enter. */
  private active: GraphKit | null = null;

  constructor(
    private readonly territories: GraphKit,
    private readonly makeNetwork: () => GraphKit,
  ) {}

  private kitFor(view: GraphView): GraphKit | null {
    if (this.territories.handles(view)) return this.territories;
    if (view !== 'network') return null;
    return (this.network ??= this.makeNetwork());
  }

  handles(view: GraphView): boolean {
    return this.territories.handles(view) || view === 'network';
  }

  enter(host: KitHost, model: GraphModel, vp: Viewport, dpr: number, view: GraphView): void {
    this.active?.leave();
    this.active = this.kitFor(view);
    this.active?.enter(host, model, vp, dpr, view);
  }

  leave(): void {
    this.active?.leave();
    this.active = null;
  }

  usesEngine(): boolean {
    return this.active?.usesEngine() ?? false;
  }

  setModel(model: GraphModel): void {
    // Each lays out what it needs when it next draws: the one away keeps the model for then.
    this.territories.setModel(model);
    this.network?.setModel(model);
  }

  resize(vp: Viewport, dpr: number): void {
    this.active?.resize(vp, dpr);
  }
  frame(f: KitFrame): void {
    this.active?.frame(f);
  }
  pointerDown(e: PointerEvent, x: number, y: number): void {
    this.active?.pointerDown(e, x, y);
  }
  pointerMove(e: PointerEvent, x: number, y: number): void {
    this.active?.pointerMove(e, x, y);
  }
  pointerUp(e: PointerEvent, x: number, y: number, cancelled: boolean): void {
    this.active?.pointerUp(e, x, y, cancelled);
  }
  pointerLeave(): void {
    this.active?.pointerLeave();
  }
  wheel(e: WheelEvent, x: number, y: number): void {
    this.active?.wheel(e, x, y);
  }
  doubleClick(x: number, y: number): void {
    this.active?.doubleClick(x, y);
  }
  key(e: KeyboardEvent): boolean {
    return this.active?.key(e) ?? false;
  }
  fit(): void {
    this.active?.fit();
  }
  zoom(factor: number): void {
    this.active?.zoom(factor);
  }
  reveal(node: GraphNode): void {
    this.active?.reveal(node);
  }
  frameNotes(notes: readonly GraphNode[]): void {
    this.active?.frameNotes(notes);
  }
  up(): boolean {
    return this.active?.up() ?? false;
  }
  focusPlace(id: string | null): void {
    this.active?.focusPlace(id);
  }
  screenOf(node: GraphNode): { x: number; y: number } | null {
    return this.active?.screenOf(node) ?? null;
  }
  invalidate(): void {
    this.active?.invalidate();
  }
  startGrowth(): boolean {
    return this.active?.startGrowth() ?? false;
  }
  stopGrowth(): void {
    this.active?.stopGrowth();
  }
  growthStatus(): { at: number; count: number } | null {
    return this.active?.growthStatus() ?? null;
  }
  minimapPoint(x: number, y: number): void {
    this.active?.minimapPoint(x, y);
  }

  dispose(): void {
    this.active = null;
    this.territories.dispose();
    this.network?.dispose();
  }
}
