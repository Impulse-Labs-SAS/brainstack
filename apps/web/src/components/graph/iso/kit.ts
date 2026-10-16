// Line art for Territories: the map as plates and blocks, seen in isometric from one of four
// corners or straight down. It draws with the graph's renderer on an orthographic camera of its
// own, over a layout of its own (vault, project, folder, sub-folder plates; one block per note),
// and takes the pointer while it draws (see graph-kit). What is selected, found or previewed is
// the controller's; here it only shows, in the one accent the style keeps for what is active.
//
// It draws only when something changed: a camera moving, a block lifting, a new selection, the
// stage resized. A map at rest costs nothing, as the classic graph's does.

import * as THREE from 'three';

import type { Viewport } from '@/lib/graph-camera';
import type { GraphModel, GraphNode, GraphView } from '@/lib/graph-model';
import { lineArtTheme, type LineArtTheme } from '@/lib/graph-theme';

import type { GraphKit, KitFrame, KitHost } from '../graph-kit';
import { LINEART_VIEWS } from '../graph-style';
import { freeStage } from '../labels/chrome';
import type { Rect } from '../labels/placer';
import { layoutInput } from './layout/input';
import { LayoutClient } from './layout/client';
import type { IsoLayout, IsoPlate } from './layout/territories';
import {
  ISO_EL,
  PLAN_EL,
  interpolateIso,
  isoFit,
  isoProject,
  isoUnproject,
  isoZoomAt,
  snapAz,
  targetFor,
  type Box3,
  type IsoCam,
} from './math/camera';
import { BoxLayer, FLAG, KIND, STATE } from './render/boxes';
import { GroundGrid } from './render/grid';
import { LiftMarks, type LiftMark } from './render/marks';
import { applyIsoCamera } from './render/ortho';

/** A note's block: its footprint across, and its height. */
const BLOCK = 0.62;
const BLOCK_H = 0.5;
/** How far a block rises: the selected one, and the one a result in the list points at. */
const LIFT_SELECTED = 0.55;
const LIFT_PREVIEWED = 0.36;
/** The height a drag or a pinch holds on to: about the folders' tops, where the notes stand. */
const GRAB_Z = 0.6;
/** Pixels per unit, the closest and the farthest the camera goes. */
const PPU_RANGE: readonly [number, number] = [1, 150];
/** The zoom a note is flown to at the least: its folder's notes are a readable size there. */
const NOTE_PPU = 32;
/** How far a pointer moves before a press is a drag, CSS pixels: a finger rolls more. */
const SLOP = { mouse: 4, touch: 10 };
const FLY_MS = 520;
const TURN_MS = 420;
/** A flight aimed again because the preview came up over where it was going. */
const REAIM_MS = 360;
/** Narrower than this, the map opens on the viewer's own vault: the whole of it is too small. */
const NARROW = 700;

interface Tween {
  from: IsoCam;
  to: IsoCam;
  t0: number;
  ms: number;
}

interface Pointer {
  x: number;
  y: number;
  type: string;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function createKit(): GraphKit {
  return new LineArtKit();
}

export class LineArtKit implements GraphKit {
  private host: KitHost | null = null;
  private model: GraphModel | null = null;
  private vp: Viewport = { width: 800, height: 600 };
  private dpr = 1;
  private chrome: readonly Rect[] = [];
  private theme: LineArtTheme = lineArtTheme();

  private readonly client = new LayoutClient();
  private layout: IsoLayout | null = null;
  /** The model the layout was taken for: a newer one is laid out again. */
  private laidOut: GraphModel | null = null;
  /** A note's box, by note id: plates come first in the boxes, notes after them. */
  private boxOf = new Map<string, number>();
  private plateById = new Map<string, IsoPlate>();

  private three: {
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    boxes: BoxLayer;
    grid: GroundGrid;
    marks: LiftMarks;
  } | null = null;

  private cam: IsoCam = { tx: 0, ty: 0, tz: 0, az: snapAz(0, false), el: ISO_EL, ppu: 10 };
  private turns = 0;
  private plan = false;
  private tween: Tween | null = null;
  /** The plates the camera was last fitted to, by id, until the person moves it: a turn fits them again. */
  private fitted: string[] | null = null;
  /** The note a flight was last aimed at, until the camera is moved otherwise: aimed again if the preview comes up over it. */
  private aim: GraphNode | null = null;
  private framed = false;

  // What the controller showed last frame, and how the blocks were lit for it.
  private selected: GraphNode | null = null;
  private previewed: GraphNode | null = null;
  private matches: ReadonlySet<GraphNode> | null = null;
  /** The blocks lifted or settling back, by box: how far up they are and where they go. */
  private readonly lifts = new Map<number, { now: number; to: number }>();

  private readonly pointers = new Map<number, Pointer>();
  private drag: {
    id: number;
    grab: { x: number; y: number };
    x0: number;
    y0: number;
    moved: boolean;
    slop: number;
  } | null = null;
  private pinch: { d0: number; ppu0: number; grab: { x: number; y: number } } | null = null;

  /** Draw the next frame whatever else holds: something changed outside what a frame compares. */
  private dirty = true;
  private overlayClear = true;
  private drawnCam: IsoCam | null = null;
  private lastNow = 0;

  handles(view: GraphView): boolean {
    return LINEART_VIEWS.includes(view);
  }

  enter(host: KitHost, model: GraphModel, vp: Viewport, dpr: number): void {
    this.host = host;
    this.vp = vp;
    this.dpr = dpr;
    this.theme = lineArtTheme();
    if (!this.three) this.three = this.build();
    else this.three.boxes.setTheme(this.theme);
    this.model = model;
    // At once, so the first frame has the map; later changes come from the worker (setModel).
    if (!this.layout || this.laidOut !== model)
      this.adopt(this.client.layoutNow(...inputs(model)), model);
    this.overlayClear = true;
    this.dirty = true;
  }

  leave(): void {
    this.host = null;
    this.pointers.clear();
    this.drag = null;
    this.pinch = null;
    this.stopTween();
  }

  setModel(model: GraphModel): void {
    this.model = model;
    // Away from the map, laid out when it comes back; on it, off the main thread meanwhile.
    if (!this.host) return;
    void this.client.layout(...inputs(model)).then((layout) => {
      if (this.model === model && this.three) this.adopt(layout, model);
    });
  }

  resize(vp: Viewport, dpr: number): void {
    this.vp = vp;
    this.dpr = dpr;
    this.dirty = true;
  }

  frame(f: KitFrame): void {
    const three = this.three;
    if (!this.host || !three || !this.layout) return;
    if (f.vp.width < 1 || f.vp.height < 1) return;
    const dt = this.lastNow ? Math.min(64, f.now - this.lastNow) : 16;
    this.lastNow = f.now;
    this.vp = f.vp;
    this.dpr = f.dpr;
    if (f.chrome !== this.chrome) {
      this.chrome = f.chrome;
      // The preview came up, or went: a note just flown to is framed again beside it.
      if (this.aim && this.aim === f.selected) this.aimAt(this.aim, REAIM_MS);
    }
    if (!this.framed) {
      this.framed = true;
      const opening = this.opening();
      this.cam = this.fitCam(opening);
      this.fitted = opening.map((p) => p.id);
    }
    let moving = false;
    if (this.tween) {
      const t = clamp((f.now - this.tween.t0) / this.tween.ms, 0, 1);
      this.cam = interpolateIso(this.tween.from, this.tween.to, ease(t));
      if (t >= 1) this.tween = null;
      else moving = true;
    }
    if (
      f.selected !== this.selected ||
      f.previewed !== this.previewed ||
      f.matches !== this.matches
    ) {
      if (f.selected !== this.selected && this.aim !== f.selected) this.aim = null;
      this.selected = f.selected;
      this.previewed = f.previewed;
      this.matches = f.matches;
      this.light(f.model);
    }
    if (this.stepLifts(dt)) moving = true;
    const camMoved = !this.drawnCam || !sameCam(this.drawnCam, this.cam);
    const uploaded = three.boxes.flush();
    if (!this.dirty && !camMoved && !uploaded && !moving) return;
    this.dirty = false;
    this.draw();
  }

  // -- Pointer and keys ------------------------------------------------------------------

  pointerDown(e: PointerEvent, x: number, y: number): void {
    // A primary pointer is the first of its kind down: any of its kind still recorded is a ghost
    // whose lifting never reached the page (an app switch, a system gesture). Left, it would turn
    // the next touch into a pinch with a finger that is not there.
    if (e.isPrimary) {
      for (const [id, p] of this.pointers) if (p.type === e.pointerType) this.pointers.delete(id);
      this.pinch = null;
      this.drag = null;
    }
    this.pointers.set(e.pointerId, { x, y, type: e.pointerType });
    this.stopTween();
    if (this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    if (this.pointers.size > 2) return;
    this.drag = {
      id: e.pointerId,
      grab: isoUnproject(this.cam, this.vp, x, y, GRAB_Z),
      x0: x,
      y0: y,
      moved: false,
      slop: e.pointerType === 'mouse' ? SLOP.mouse : SLOP.touch,
    };
  }

  pointerMove(e: PointerEvent, x: number, y: number): void {
    const down = this.pointers.get(e.pointerId);
    if (!down) return;
    down.x = x;
    down.y = y;
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = this.firstTwo();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ppu = clamp(
        this.pinch.ppu0 * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d0),
        PPU_RANGE[0],
        PPU_RANGE[1],
      );
      const cam = { ...this.cam, ppu };
      this.cam = { ...cam, ...targetFor(cam, this.vp, { ...this.pinch.grab, z: GRAB_Z }, mid) };
      this.userCamera();
      return;
    }
    const drag = this.drag;
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) <= drag.slop) return;
    if (!drag.moved) this.host?.setCursor('grabbing');
    drag.moved = true;
    this.cam = {
      ...this.cam,
      ...targetFor(this.cam, this.vp, { ...drag.grab, z: GRAB_Z }, { x, y }),
    };
    this.userCamera();
  }

  pointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      // Of three fingers one lifted: the pinch goes on between the two left. Of two, the finger
      // left carries on as a drag from where it is.
      if (this.pointers.size >= 2) {
        this.startPinch();
        return;
      }
      this.pinch = null;
      const [entry] = [...this.pointers];
      this.drag = entry
        ? {
            id: entry[0],
            grab: isoUnproject(this.cam, this.vp, entry[1].x, entry[1].y, GRAB_Z),
            x0: entry[1].x,
            y0: entry[1].y,
            moved: true,
            slop: 0,
          }
        : null;
      return;
    }
    if (this.drag?.id === e.pointerId) {
      this.drag = null;
      this.host?.setCursor('grab');
    }
  }

  pointerLeave(): void {
    // Nothing is pointed at yet: picking comes with the labels.
  }

  wheel(e: WheelEvent, x: number, y: number): void {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // A trackpad's pinch comes as a wheel with ctrl held, in finer steps than a mouse's notches.
    const factor = clamp(Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.012 : 0.0016)), 1 / 1.5, 1.5);
    this.stopTween();
    this.cam = isoZoomAt(this.cam, this.vp, x, y, factor, GRAB_Z, PPU_RANGE);
    this.userCamera();
  }

  /** Its own keys: the turns and the plan. Zoom, Fit, Escape and the arrows are the controller's. */
  key(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'q':
      case 'Q':
        this.turn(-1);
        return true;
      case 'e':
      case 'E':
        this.turn(1);
        return true;
      case 'p':
      case 'P':
        this.togglePlan();
        return true;
    }
    return false;
  }

  // -- The camera, asked for ----------------------------------------------------------------

  fit(): void {
    const all = this.vaultPlates();
    if (!all.length) return;
    this.aim = null;
    this.fitted = all.map((p) => p.id);
    this.fly(this.fitCam(all));
  }

  zoom(factor: number): void {
    const free = this.free();
    const to = this.target();
    this.aim = null;
    this.fitted = null;
    this.fly(
      isoZoomAt(to, this.vp, free.x + free.w / 2, free.y + free.h / 2, factor, GRAB_Z, PPU_RANGE),
      260,
    );
  }

  reveal(node: GraphNode): void {
    this.aimAt(node, FLY_MS);
  }

  frameNotes(notes: readonly GraphNode[]): void {
    const plates = this.platesAround(notes);
    if (!plates.length) return;
    this.aim = null;
    this.fitted = plates.map((p) => p.id);
    this.fly(this.fitCam(plates));
  }

  screenOf(node: GraphNode): { x: number; y: number } | null {
    const at = this.cellOf(node);
    if (!at) return null;
    const i = this.boxOf.get(node.id)!;
    const p = isoProject(this.cam, this.vp)(at.x, at.y, at.z + (this.lifts.get(i)?.now ?? 0));
    const on = p.x >= 0 && p.y >= 0 && p.x <= this.vp.width && p.y <= this.vp.height;
    return on ? { x: p.x, y: p.y } : null;
  }

  invalidate(): void {
    this.dirty = true;
    this.overlayClear = true;
  }

  dispose(): void {
    this.leave();
    this.client.dispose();
    const three = this.three;
    if (!three) return;
    three.boxes.dispose();
    three.grid.dispose();
    three.marks.dispose();
    this.three = null;
  }

  // -- Internals ----------------------------------------------------------------------------

  private build() {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    const boxes = new BoxLayer(this.theme);
    const grid = new GroundGrid(this.theme);
    const marks = new LiftMarks(this.theme);
    scene.add(grid.mesh, boxes.mesh, marks.object);
    return { scene, camera, boxes, grid, marks };
  }

  /** Take a layout: boxes for its plates and notes, the lighting it shows, the camera kept. */
  private adopt(layout: IsoLayout, model: GraphModel): void {
    const three = this.three;
    if (!three) return;
    this.laidOut = model;
    if (layout === this.layout) {
      // The same notes in the same places (a layer that hides nothing here): only the lighting.
      this.light(model);
      this.dirty = true;
      return;
    }
    // What was lifted stays as high as it was, wherever its block is now.
    const was = new Map<string, { now: number; to: number }>();
    const old = this.layout;
    if (old) {
      for (const [i, l] of this.lifts) {
        const id = old.ids[i - old.plates.length];
        if (id) was.set(id, l);
      }
    }
    this.layout = layout;
    const { plates, ids, cells } = layout;
    const count = plates.length + ids.length;
    const bounds = new Float32Array(count * 6);
    const kinds = new Uint8Array(count);
    const flags = new Uint8Array(count);
    plates.forEach((p, i) => {
      bounds.set([p.x, p.y, p.z0, p.x + p.w, p.y + p.h, p.z1], i * 6);
      kinds[i] =
        p.kind === 'vault'
          ? KIND.vault
          : p.kind === 'project'
            ? KIND.project
            : p.depth >= 4
              ? KIND.sub
              : KIND.folder;
      flags[i] = p.kind === 'vault' && p.shared ? FLAG.dashed : 0;
    });
    const index = new Set(model.nodes.filter((n) => n.isIndex).map((n) => n.id));
    this.boxOf = new Map();
    this.plateById = new Map(plates.map((p) => [p.id, p]));
    ids.forEach((id, k) => {
      const i = plates.length + k;
      const x = cells[k * 3]!;
      const y = cells[k * 3 + 1]!;
      const z = cells[k * 3 + 2]!;
      bounds.set(
        [x - BLOCK / 2, y - BLOCK / 2, z, x + BLOCK / 2, y + BLOCK / 2, z + BLOCK_H],
        i * 6,
      );
      kinds[i] = KIND.note;
      flags[i] = index.has(id) ? FLAG.index : 0;
      this.boxOf.set(id, i);
    });
    three.boxes.setBoxes(bounds, kinds, flags);
    three.grid.setBounds(layout.bounds.x0, layout.bounds.y0, layout.bounds.x1, layout.bounds.y1);
    this.lifts.clear();
    for (const [id, l] of was) {
      const i = this.boxOf.get(id);
      if (i === undefined) continue;
      this.lifts.set(i, { ...l });
      three.boxes.setLift(i, l.now);
    }
    this.light(model);
    this.dirty = true;
  }

  /** Each block lit as what the controller shows: selected, linked to it, found, or neither. */
  private light(model: GraphModel): void {
    const three = this.three;
    if (!three || !this.layout) return;
    const linked = new Set<GraphNode>();
    if (this.selected)
      for (const { node } of model.adjacency.get(this.selected) ?? []) linked.add(node);
    const base = this.layout.plates.length;
    for (let k = 0; k < this.layout.ids.length; k++) three.boxes.setState(base + k, STATE.rest);
    const set = (n: GraphNode, state: number) => {
      const i = this.boxOf.get(n.id);
      if (i !== undefined) three.boxes.setState(i, state);
    };
    if (this.selected)
      for (const n of model.nodes) if (n !== this.selected && !linked.has(n)) set(n, STATE.dim);
    for (const n of this.matches ?? []) set(n, STATE.found);
    for (const n of linked) set(n, STATE.linked);
    if (this.previewed) set(this.previewed, STATE.hover);
    if (this.selected) set(this.selected, STATE.selected);
    const want = new Map<number, number>();
    const lift = (n: GraphNode | null, to: number) => {
      const i = n ? this.boxOf.get(n.id) : undefined;
      if (i !== undefined) want.set(i, Math.max(want.get(i) ?? 0, to));
    };
    lift(this.previewed, LIFT_PREVIEWED);
    lift(this.selected, LIFT_SELECTED);
    for (const [i, l] of this.lifts) if (!want.has(i)) l.to = 0;
    for (const [i, to] of want) {
      const l = this.lifts.get(i);
      if (l) l.to = to;
      else this.lifts.set(i, { now: 0, to });
    }
  }

  /** Ease the lifted blocks toward where they go; true while any is still on its way. */
  private stepLifts(dt: number): boolean {
    const three = this.three;
    if (!three || !this.lifts.size) return false;
    let moving = false;
    const k = this.host?.reduceMotion ? 1 : Math.min(1, dt / 70);
    for (const [i, l] of this.lifts) {
      if (l.now === l.to) continue;
      l.now += (l.to - l.now) * k;
      if (Math.abs(l.now - l.to) < 0.004) l.now = l.to;
      three.boxes.setLift(i, l.now);
      if (l.now !== l.to) moving = true;
    }
    for (const [i, l] of this.lifts) if (l.now === 0 && l.to === 0) this.lifts.delete(i);
    return moving;
  }

  private draw(): void {
    const host = this.host;
    const three = this.three;
    if (!host || !three) return;
    const { camera, boxes, grid, marks } = three;
    applyIsoCamera(camera, this.cam, this.vp, this.reach());
    boxes.setView([Math.cos(this.cam.az), Math.sin(this.cam.az)]);
    boxes.setScale(this.cam.ppu, this.dpr);
    grid.setScale(this.cam.ppu, this.dpr);
    marks.set(this.liftMarks(), this.cam.ppu);
    host.renderer.render(three.scene, camera);
    if (this.overlayClear) {
      // What the classic graph drew over the map: line art draws nothing on the overlay yet.
      const ctx = host.overlay;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      this.overlayClear = false;
    }
    this.drawnCam = { ...this.cam };
  }

  /**
   * How far the camera stands back, world units: past anything on the stage. A point on the
   * ground lies deeper the farther it is drawn from the middle, by cot(el) per unit up the
   * stage, so far out at a low zoom the edges of the map would be clipped at any fixed reach.
   */
  private reach(): number {
    const across = (this.vp.width + this.vp.height) / this.cam.ppu;
    return 50 + across / Math.max(Math.sin(this.cam.el), 0.25);
  }

  /** The dotted lines under each lifted block, down to where it stands. */
  private liftMarks(): LiftMark[] {
    const layout = this.layout;
    if (!layout) return [];
    const base = layout.plates.length;
    const out: LiftMark[] = [];
    for (const [i, l] of this.lifts) {
      if (l.now < 0.02) continue;
      const k = i - base;
      const x = layout.cells[k * 3]!;
      const y = layout.cells[k * 3 + 1]!;
      const z = layout.cells[k * 3 + 2]!;
      out.push({
        x0: x - BLOCK / 2,
        y0: y - BLOCK / 2,
        x1: x + BLOCK / 2,
        y1: y + BLOCK / 2,
        base: z,
        lifted: z + l.now,
        color: this.selected?.id === layout.ids[k] ? 'accent' : 'hover',
      });
    }
    return out;
  }

  private userCamera(): void {
    this.fitted = null;
    this.aim = null;
    this.host?.onUserCamera();
  }

  /** The turn and the elevation the camera stands at, or is turning to. */
  private orientation(): { az: number; el: number } {
    return { az: snapAz(this.turns, this.plan), el: this.plan ? PLAN_EL : ISO_EL };
  }

  /** Where the camera is going, at the orientation it is going to. */
  private target(): IsoCam {
    return { ...(this.tween?.to ?? this.cam), ...this.orientation() };
  }

  /**
   * End a flight where it is, but at the orientation it was turning to: a drag or the wheel
   * mid-turn would otherwise leave the map at an angle between two corners.
   */
  private stopTween(): void {
    if (!this.tween) return;
    this.cam = { ...this.cam, ...this.orientation() };
    this.tween = null;
  }

  private fly(to: IsoCam, ms = FLY_MS): void {
    if (this.host?.reduceMotion) {
      this.cam = to;
      this.tween = null;
      return;
    }
    this.tween = { from: { ...this.cam }, to, t0: performance.now(), ms };
  }

  /** Fly to a note, framed in the middle of the free stage, close enough to read its folder. */
  private aimAt(node: GraphNode, ms: number): void {
    const at = this.cellOf(node);
    if (!at) return;
    const free = this.free();
    const to = this.target();
    const cam = { ...to, ppu: Math.max(to.ppu, NOTE_PPU) };
    this.aim = node;
    this.fitted = null;
    this.fly(
      {
        ...cam,
        ...targetFor(cam, this.vp, at, { x: free.x + free.w / 2, y: free.y + free.h / 2 }),
      },
      ms,
    );
  }

  private turn(by: number): void {
    this.turns += by;
    this.reorient(TURN_MS);
  }

  private togglePlan(): void {
    this.plan = !this.plan;
    this.reorient(480);
  }

  /**
   * A new orientation, about what stays put: the selected note, if there is one; else what was
   * fitted, fitted again; else the middle of the free stage. The camera never turns on its own.
   */
  private reorient(ms: number): void {
    const turned = this.target();
    const fitted = (this.fitted ?? [])
      .map((id) => this.plateById.get(id))
      .filter((p): p is IsoPlate => !!p);
    this.host?.onUserCamera();
    if (fitted.length && !this.selected) {
      this.fly(this.fitCam(fitted, turned), ms);
      return;
    }
    const free = this.free();
    const middle = { x: free.x + free.w / 2, y: free.y + free.h / 2 };
    const at = (this.selected && this.cellOf(this.selected)) || {
      ...isoUnproject(this.tween?.to ?? this.cam, this.vp, middle.x, middle.y, GRAB_Z),
      z: GRAB_Z,
    };
    this.fly({ ...turned, ...targetFor(turned, this.vp, at, middle) }, ms);
  }

  private startPinch(): void {
    const [a, b] = this.firstTwo();
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      ppu0: this.cam.ppu,
      grab: isoUnproject(this.cam, this.vp, mid.x, mid.y, GRAB_Z),
    };
    this.drag = null;
  }

  private firstTwo(): [Pointer, Pointer] {
    const [a, b] = [...this.pointers.values()];
    return [a!, b!];
  }

  /** The stage less the chrome along its edges, and a little room. */
  private free(): Rect {
    const r = freeStage(this.vp.width, this.vp.height, this.chrome);
    const m = 12;
    return { x: r.x + m, y: r.y + m, w: Math.max(1, r.w - 2 * m), h: Math.max(1, r.h - 2 * m) };
  }

  private fitCam(plates: readonly IsoPlate[], from: IsoCam = this.target()): IsoCam {
    const boxes: Box3[] = plates.map((p) => ({
      x0: p.x,
      y0: p.y,
      z0: p.z0,
      x1: p.x + p.w,
      y1: p.y + p.h,
      z1: p.z1 + BLOCK_H + LIFT_SELECTED,
    }));
    return isoFit(from, this.vp, boxes, this.free(), { minPpu: PPU_RANGE[0] });
  }

  private vaultPlates(): IsoPlate[] {
    return this.layout?.plates.filter((p) => p.kind === 'vault') ?? [];
  }

  /** What the map opens on: all of it, or on a narrow stage the viewer's own vault. */
  private opening(): IsoPlate[] {
    const vaults = this.vaultPlates();
    if (this.vp.width >= NARROW || !vaults.length) return vaults;
    return [vaults.find((p) => !p.shared) ?? vaults[0]!];
  }

  /** Where a note's block stands: the centre of its top, before any lift. */
  private cellOf(node: GraphNode): { x: number; y: number; z: number } | null {
    const layout = this.layout;
    const i = this.boxOf.get(node.id);
    if (!layout || i === undefined) return null;
    const k = i - layout.plates.length;
    return {
      x: layout.cells[k * 3]!,
      y: layout.cells[k * 3 + 1]!,
      z: layout.cells[k * 3 + 2]! + BLOCK_H,
    };
  }

  /**
   * The smallest plate every one of these notes stands on or under; when they stand in more
   * than one vault, the vaults they stand in.
   */
  private platesAround(notes: readonly GraphNode[]): IsoPlate[] {
    const layout = this.layout;
    if (!layout) return [];
    const base = layout.plates.length;
    let common: number[] | null = null;
    const vaults = new Set<number>();
    for (const n of notes) {
      const i = this.boxOf.get(n.id);
      if (i === undefined) continue;
      const chain: number[] = [];
      for (let p = layout.plateOf[i - base]!; p >= 0; p = layout.plates[p]!.parent)
        chain.unshift(p);
      vaults.add(chain[0]!);
      common = common ? common.filter((p, d) => chain[d] === p) : chain;
    }
    const at = common?.at(-1);
    if (at !== undefined) return [layout.plates[at]!];
    return [...vaults].map((p) => layout.plates[p]!);
  }
}

function inputs(model: GraphModel) {
  const { notes, vaults } = layoutInput(model);
  return [notes, vaults] as const;
}

function sameCam(a: IsoCam, b: IsoCam): boolean {
  return (
    a.tx === b.tx &&
    a.ty === b.ty &&
    a.tz === b.tz &&
    a.az === b.az &&
    a.el === b.el &&
    a.ppu === b.ppu
  );
}
