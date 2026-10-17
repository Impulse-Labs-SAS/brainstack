// Line art for Network: the notes as short columns on one board, each where the graph's own forces
// put it. The engine settles the layout under it, as it does for the classic view (`usesEngine`),
// so a note stands in the same place in either style and the views still flow into each other.
//
// At rest everything lies flat: links are thin lines on the board, and a link between two projects
// arcs over it. Selecting a note lifts it to a second level and what it links to to a first, and
// only those links run as orthogonal wires between the levels, in the accent; the rest fades. A path
// lifts its ends and its steps the same way and wires them in order.
//
// It draws only when something changed, as the Territories kit does: a camera moving, the layout
// settling, a block lifting, a new selection.

import * as THREE from 'three';

import type { Viewport } from '@/lib/graph-camera';
import type { GraphModel, GraphNode, GraphPath, GraphView } from '@/lib/graph-model';
import { lineArtTheme, type LineArtTheme } from '@/lib/graph-theme';

import type { GraphKit, KitFrame, KitHost } from '../../graph-kit';
import { freeStage } from '../../labels/chrome';
import { LabelSpace, type Rect } from '../../labels/placer';
import { BLOCK, BLOCK_H } from '../block';
import { LABEL_COLORS } from '../labels';
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
} from '../math/camera';
import { BoxLayer, KIND, STATE } from '../render/boxes';
import { CABLE, CableLayer, GROW_MS, type CableSet } from '../render/cables';
import { GroundGrid } from '../render/grid';
import { LiftMarks, type LiftMark } from '../render/marks';
import { applyIsoCamera } from '../render/ortho';
import type { Route, Vec3 } from '../routes';

/** Engine units to a world unit: neighbours a few blocks apart. */
const SCALE = 12;
/** Room round the notes on the board, world units, and its thickness. */
const BOARD_MARGIN = 3;
const BOARD_DEPTH = 0.25;
/** The levels a focus lifts to: what it links to, and the note itself. */
const LEVEL_LINKED = 1.2;
const LEVEL_SELECTED = 2.4;
/** The lift of a block the pointer is on. */
const LIFT_POINTED = 0.36;
/** An arc between two projects: its height, a share of its length, and its pieces. */
const ARC_RISE = 0.22;
const ARC_STEPS = 12;
/** A hair above the board, so a flat link does not fight its top for depth. */
const ON_BOARD = 0.01;
/** Pixels per unit, the closest and the farthest the camera goes, and the least a note is flown to. */
const PPU_RANGE: readonly [number, number] = [0.5, 150];
const NOTE_PPU = 28;
/** How near the pointer must come to a note's top, CSS pixels: a finger reaches less precisely. */
const PICK_PX = { mouse: 10, touch: 22 };
/** How far a pointer moves before a press is a drag, CSS pixels. */
const SLOP = { mouse: 4, touch: 10 };
const FLY_MS = 520;
const TURN_MS = 420;
/** A flight aimed again because the preview came up over where it was going. */
const REAIM_MS = 360;
/** A second press this soon and this near the first is the rest of a double click: it picks nothing. */
const DOUBLE_MS = 500;
const REPEAT_PX = 6;
/** The board's top, a hair under the dot grid at z 0, so the two never fight for depth. */
const BOARD_TOP = -0.004;
/** Notes named past the key ones at most, and the zoom from which any note may be named. */
const REST_TRIED = 140;
const NAMES_PPU = 22;
/** Search results bracketed at the most, and on the minimap. */
const FOUND_MARKS = 200;
/** The faded strength of links out of focus. */
const OUT_OF_FOCUS = 0.32;
/** Label metrics, as Territories' labels have them. */
const INSET = 6;
const MARGIN = 4;
const MINI_MARGIN = 0.1;
const MINI_VEIL = 'rgba(9, 9, 11, 0.35)';

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

interface Tween {
  from: IsoCam;
  to: IsoCam;
  t0: number;
  ms: number;
}

export class NetworkKit implements GraphKit {
  private host: KitHost | null = null;
  private model: GraphModel | null = null;
  private vp: Viewport = { width: 800, height: 600 };
  private dpr = 1;
  private chrome: readonly Rect[] = [];
  private theme: LineArtTheme = lineArtTheme();
  private three: {
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    boxes: BoxLayer;
    grid: GroundGrid;
    marks: LiftMarks;
    /** The links at rest, flat and arced: no dashes where a column hides them. */
    board: CableLayer;
    /** The focus's wires, dashed where something stands in front. */
    focus: CableLayer;
  } | null = null;

  /** By note index, as the boxes hold them after the board's (box 0). */
  private nodes: GraphNode[] = [];
  private index = new Map<GraphNode, number>();
  /** Where each note stands, world units, as last drawn; NaN before it has a place. */
  private pos = new Float32Array(0);
  /** 1 for each note on the board now: placed, and come in (not before the layout settles). */
  private shown = new Uint8Array(0);
  private links: { a: number; b: number; across: boolean }[] = [];
  private bounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** The positions or what shows changed since the cables were laid. */
  private moved = true;
  private focusLaid: unknown = null;
  private grown = 1;

  private selected: GraphNode | null = null;
  private previewed: GraphNode | null = null;
  private matches: ReadonlySet<GraphNode> | null = null;
  private path: GraphPath | null = null;
  private hovered: number | null = null;
  /** By note index: how far up it is now, and where it goes. */
  private readonly lifts = new Map<number, { now: number; to: number }>();
  private labelHits: { rect: Rect; note: number }[] = [];

  private cam: IsoCam = { tx: 0, ty: 0, tz: 0, az: snapAz(0, false), el: ISO_EL, ppu: 10 };
  private turns = 0;
  private plan = false;
  private tween: Tween | null = null;
  private framed = false;
  /** Until the camera is moved, by hand or to a note, it keeps the whole board in view as it settles. */
  private autoFit = true;
  /** The note last flown to, until the camera is moved otherwise: aimed again if the preview comes up over it. */
  private aim: GraphNode | null = null;
  /** The last tap, and what it picked: a double click opens that, wherever the camera has gone since. */
  private lastTap: { note: number | null; x: number; y: number; t: number; type: string } | null =
    null;
  private readonly pointers = new Map<number, { x: number; y: number; type: string }>();
  private drag: {
    id: number;
    grab: { x: number; y: number };
    x0: number;
    y0: number;
    moved: boolean;
    slop: number;
    /** The second press of a double click: lifted, it picks nothing again. */
    repeat?: boolean;
  } | null = null;
  private pinch: { d0: number; ppu0: number; grab: { x: number; y: number } } | null = null;
  private dirty = true;
  private drawnCam: IsoCam | null = null;
  private lastNow = 0;

  handles(view: GraphView): boolean {
    return view === 'network';
  }

  usesEngine(): boolean {
    return true;
  }

  enter(host: KitHost, model: GraphModel, vp: Viewport, dpr: number): void {
    this.host = host;
    this.vp = vp;
    this.dpr = dpr;
    this.theme = lineArtTheme();
    if (!this.three) this.three = this.build();
    else {
      this.three.boxes.setTheme(this.theme);
      this.three.board.setTheme(this.theme);
      this.three.focus.setTheme(this.theme);
    }
    this.adopt(model);
    // No places on a board: the breadcrumb is Territories'.
    host.onPlace([]);
    this.dirty = true;
  }

  leave(): void {
    this.host = null;
    this.lastTap = null;
    this.pointers.clear();
    this.drag = null;
    this.pinch = null;
    this.hovered = null;
    this.tween = null;
  }

  setModel(model: GraphModel): void {
    this.model = model;
    if (this.host) this.adopt(model);
  }

  resize(vp: Viewport, dpr: number): void {
    this.vp = vp;
    this.dpr = dpr;
    this.dirty = true;
  }

  frame(f: KitFrame): void {
    const three = this.three;
    if (!this.host || !three || f.vp.width < 1 || f.vp.height < 1) return;
    const dt = this.lastNow ? Math.min(64, f.now - this.lastNow) : 16;
    this.lastNow = f.now;
    this.vp = f.vp;
    this.dpr = f.dpr;
    if (f.chrome !== this.chrome) {
      this.chrome = f.chrome;
      this.dirty = true;
      // The preview came up, or went: a note just flown to is framed again beside it.
      if (this.aim && this.aim === f.selected) this.reveal(this.aim, REAIM_MS);
    }
    if (f.model !== this.model) this.adopt(f.model);
    const placed = this.readPositions(f.now);
    if (!this.framed && this.bounds) {
      this.framed = true;
      this.cam = this.fitCam();
    } else if (placed && this.autoFit && !this.tween && this.bounds) {
      // The notes still coming in or settling: the camera follows, eased, so nothing jumps.
      const fit = this.fitCam();
      this.cam = this.host.reduceMotion ? fit : interpolateIso(this.cam, fit, 0.15);
    }
    let moving = placed;
    if (this.tween) {
      const t = clamp((f.now - this.tween.t0) / this.tween.ms, 0, 1);
      this.cam = interpolateIso(this.tween.from, this.tween.to, ease(t));
      if (t >= 1) this.tween = null;
      else moving = true;
    }
    if (
      f.selected !== this.selected ||
      f.previewed !== this.previewed ||
      f.matches !== this.matches ||
      f.path !== this.path
    ) {
      this.selected = f.selected;
      this.previewed = f.previewed;
      this.matches = f.matches;
      this.path = f.path;
      this.light();
    } else if (placed) this.light();
    this.layCables();
    if (this.stepGrowth(dt)) moving = true;
    if (this.stepLifts(dt)) moving = true;
    const camMoved = !this.drawnCam || !sameCam(this.drawnCam, this.cam);
    const uploaded = three.boxes.flush();
    if (!this.dirty && !camMoved && !uploaded && !moving) return;
    this.dirty = false;
    this.draw();
  }

  // -- Pointer and keys --------------------------------------------------------------------

  pointerDown(e: PointerEvent, x: number, y: number): void {
    if (e.isPrimary) {
      this.pointers.clear();
      this.pinch = null;
      this.drag = null;
    }
    this.pointers.set(e.pointerId, { x, y, type: e.pointerType });
    // The second press of a double click: the flight the first one started goes on, so the note
    // it picked is the one the double click opens.
    const last = this.lastTap;
    const repeat =
      !!last &&
      last.type === e.pointerType &&
      performance.now() - last.t < DOUBLE_MS &&
      Math.hypot(x - last.x, y - last.y) <= REPEAT_PX;
    if (!repeat) this.tween = null;
    if (this.pointers.size >= 2) {
      this.startPinch();
      return;
    }
    this.drag = {
      id: e.pointerId,
      grab: isoUnproject(this.cam, this.vp, x, y, 0),
      x0: x,
      y0: y,
      moved: false,
      slop: e.pointerType === 'mouse' ? SLOP.mouse : SLOP.touch,
      repeat,
    };
  }

  /** A pinch between the first two fingers down, measured from where they are now. */
  private startPinch(): void {
    const [a, b] = this.firstTwo();
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.tween = null;
    this.pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      ppu0: this.cam.ppu,
      grab: isoUnproject(this.cam, this.vp, mid.x, mid.y, 0),
    };
    this.drag = null;
  }

  pointerMove(e: PointerEvent, x: number, y: number): void {
    const down = this.pointers.get(e.pointerId);
    if (!down) {
      if (e.pointerType === 'mouse' && !this.pointers.size) this.hoverAt(x, y);
      return;
    }
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
      this.cam = { ...cam, ...targetFor(cam, this.vp, { ...this.pinch.grab, z: 0 }, mid) };
      this.handMoved();
      return;
    }
    const drag = this.drag;
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) <= drag.slop) return;
    if (!drag.moved) this.host?.setCursor('grabbing');
    drag.moved = true;
    this.cam = { ...this.cam, ...targetFor(this.cam, this.vp, { ...drag.grab, z: 0 }, { x, y }) };
    this.handMoved();
  }

  pointerUp(e: PointerEvent, x: number, y: number, cancelled: boolean): void {
    const drag = this.drag;
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      // A finger of a pinch lifted: the two left pinch afresh, or the last one drags on.
      if (this.pointers.size >= 2) this.startPinch();
      else {
        this.pinch = null;
        const [id, p] = [...this.pointers.entries()][0] ?? [];
        if (id !== undefined && p)
          this.drag = {
            id,
            grab: isoUnproject(this.cam, this.vp, p.x, p.y, 0),
            x0: p.x,
            y0: p.y,
            moved: true,
            slop: 0,
          };
      }
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    this.drag = null;
    this.host?.setCursor('grab');
    if (cancelled || drag.moved || drag.repeat) return;
    const touch = e.pointerType !== 'mouse';
    const k = this.pickAt(x, y, touch);
    this.lastTap = { note: k, x, y, t: performance.now(), type: e.pointerType };
    if (k === null) {
      if (this.selected || this.path) this.host?.clearSelection();
      return;
    }
    const note = this.nodes[k];
    if (note) this.host?.pick(note, e.shiftKey);
  }

  pointerLeave(): void {
    if (this.hovered === null) return;
    this.hovered = null;
    this.light();
    this.dirty = true;
  }

  wheel(e: WheelEvent, x: number, y: number): void {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const factor = clamp(Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.012 : 0.0016)), 1 / 1.5, 1.5);
    this.tween = null;
    this.cam = isoZoomAt(this.cam, this.vp, x, y, factor, 0, PPU_RANGE);
    this.handMoved();
  }

  /** Open what the first click of the double click picked, wherever its flight has taken it since. */
  doubleClick(x: number, y: number): void {
    const last = this.lastTap;
    this.lastTap = null;
    const k =
      last && Math.hypot(x - last.x, y - last.y) <= REPEAT_PX * 2
        ? last.note
        : this.pickAt(x, y, false);
    const note = k !== null ? this.nodes[k] : null;
    if (note) this.host?.open(note);
  }

  /** Its own keys: the turns and the plan. The arrows, Enter and Escape are the controller's. */
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
        this.plan = !this.plan;
        this.reorient(480);
        return true;
      default:
        return false;
    }
  }

  fit(): void {
    this.fly(this.fitCam());
    this.host?.onUserCamera();
    this.autoFit = true;
    this.aim = null;
  }

  zoom(factor: number): void {
    const target = this.tween?.to ?? this.cam;
    this.fly(
      isoZoomAt(target, this.vp, this.vp.width / 2, this.vp.height / 2, factor, 0, PPU_RANGE),
      240,
    );
    this.handMoved();
  }

  reveal(node: GraphNode, ms = FLY_MS): void {
    const k = this.index.get(node);
    if (k === undefined || !this.shown[k]) return;
    this.autoFit = false;
    this.aim = node;
    const free = this.free();
    const to = this.target();
    const cam = { ...to, ppu: Math.max(to.ppu, NOTE_PPU) };
    const at = { x: this.pos[k * 2]!, y: this.pos[k * 2 + 1]!, z: 0 };
    this.fly(
      {
        ...cam,
        ...targetFor(cam, this.vp, at, { x: free.x + free.w / 2, y: free.y + free.h / 2 }),
      },
      ms,
    );
  }

  frameNotes(notes: readonly GraphNode[]): void {
    const boxes = notes
      .map((n) => this.index.get(n))
      .filter((k): k is number => k !== undefined && !!this.shown[k])
      .map((k) => this.blockBox(k, LEVEL_SELECTED + BLOCK_H));
    if (!boxes.length) return;
    this.autoFit = false;
    this.aim = null;
    this.fly(isoFit(this.target(), this.vp, boxes, this.free(), { maxPpu: NOTE_PPU * 1.5 }));
  }

  /** Escape with nothing selected: the whole board again, once the camera was moved off it. */
  up(): boolean {
    if (this.autoFit && !this.tween) return false;
    this.fit();
    return true;
  }

  focusPlace(): void {}

  screenOf(node: GraphNode): { x: number; y: number } | null {
    const k = this.index.get(node);
    if (k === undefined || !this.shown[k]) return null;
    const p = this.project()(this.pos[k * 2]!, this.pos[k * 2 + 1]!, this.lifts.get(k)?.now ?? 0);
    return p.x >= 0 && p.y >= 0 && p.x <= this.vp.width && p.y <= this.vp.height
      ? { x: p.x, y: p.y }
      : null;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /**
   * The engine replays Network's growth, and the board shows its notes as they come: the camera
   * follows the board as it grows, as the classic view's does.
   */
  startGrowth(): boolean {
    this.autoFit = true;
    this.aim = null;
    this.tween = null;
    return false;
  }
  stopGrowth(): void {}
  growthStatus(): { at: number; count: number } | null {
    return null;
  }

  minimapPoint(x: number, y: number): void {
    const mini = this.mini;
    if (!mini || !this.host) return;
    const at = isoUnproject(mini.cam, mini.vp, x, y, 0);
    const free = this.free();
    this.tween = null;
    this.cam = {
      ...this.cam,
      ...targetFor(
        this.cam,
        this.vp,
        { ...at, z: 0 },
        { x: free.x + free.w / 2, y: free.y + free.h / 2 },
      ),
    };
    this.handMoved();
    this.dirty = true;
  }

  dispose(): void {
    this.leave();
    const three = this.three;
    if (!three) return;
    three.boxes.dispose();
    three.grid.dispose();
    three.marks.dispose();
    three.board.dispose();
    three.focus.dispose();
    this.three = null;
  }

  // -- Internals ----------------------------------------------------------------------------

  private build() {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    const boxes = new BoxLayer(this.theme);
    const grid = new GroundGrid(this.theme);
    const marks = new LiftMarks(this.theme);
    const board = new CableLayer(this.theme, 2048);
    // The board's links lie under the columns: a dash for every one a column covers is noise.
    board.setHiddenVisible(false);
    const focus = new CableLayer(this.theme);
    scene.add(
      grid.mesh,
      boxes.mesh,
      marks.object,
      board.hidden,
      board.visible,
      focus.hidden,
      focus.visible,
    );
    return { scene, camera, boxes, grid, marks, board, focus };
  }

  /** The notes and links of a model, by index: the board box first, a column per note. */
  private adopt(model: GraphModel): void {
    const three = this.three;
    this.model = model;
    if (!three) return;
    const nodes = model.nodes.filter((n) => n.kind === 'note');
    const same = nodes.length === this.nodes.length && nodes.every((n, i) => n === this.nodes[i]);
    if (!same) {
      this.pos = new Float32Array(nodes.length * 2).fill(Number.NaN);
      this.shown = new Uint8Array(nodes.length);
      const n = nodes.length + 1;
      const kinds = new Uint8Array(n).fill(KIND.note);
      kinds[0] = KIND.vault;
      // What was lifted stays as high as it was, at its new index.
      const was = new Map<GraphNode, { now: number; to: number }>();
      for (const [k, l] of this.lifts) {
        const node = this.nodes[k];
        if (node) was.set(node, l);
      }
      this.nodes = nodes;
      this.index = new Map(nodes.map((m, i) => [m, i]));
      three.boxes.setBoxes(new Float32Array(n * 6), kinds, new Uint8Array(n));
      this.lifts.clear();
      for (const [node, l] of was) {
        const k = this.index.get(node);
        if (k === undefined) continue;
        this.lifts.set(k, { ...l });
        three.boxes.setLift(k + 1, l.now);
      }
      this.hovered = null;
      this.labelHits = [];
      this.lastTap = null;
      this.bounds = null;
      this.mini = null;
    }
    // What a person wrote: links and an index's members, not topics shared by chance.
    this.links = [];
    for (const e of model.edges) {
      if (e.kind !== 'link' && e.kind !== 'structure') continue;
      const a = this.index.get(e.source);
      const b = this.index.get(e.target);
      if (a === undefined || b === undefined || a === b) continue;
      this.links.push({ a, b, across: e.source.project?.id !== e.target.project?.id });
    }
    // No board yet (the first layout settles unseen): no dot grid either.
    three.grid.setVisible(!!this.bounds);
    this.moved = true;
    this.light();
    this.dirty = true;
  }

  /** A note's links as the board draws them: what a person wrote, not topics shared by chance. */
  private linksOf(node: GraphNode): number[] {
    const out: number[] = [];
    for (const { node: other, edge } of this.model?.adjacency.get(node) ?? []) {
      if (edge.kind !== 'link' && edge.kind !== 'structure') continue;
      const k = this.index.get(other);
      if (k !== undefined) out.push(k);
    }
    return out;
  }

  /**
   * Where the engine has the notes now, world units: true when any moved, came in or went. A note
   * shows once it has a place and the layout has let it in (the first layout settles unseen; the
   * growth replay brings notes in one by one).
   */
  private readPositions(now: number): boolean {
    const three = this.three;
    if (!three) return false;
    let changed = false;
    let shownChanged = false;
    for (let k = 0; k < this.nodes.length; k++) {
      const n = this.nodes[k]!;
      const ok = Number.isFinite(n.x) && Number.isFinite(n.y) && n.bornAt <= now;
      if ((ok ? 1 : 0) !== this.shown[k]) {
        this.shown[k] = ok ? 1 : 0;
        shownChanged = true;
      }
      if (!ok) continue;
      const x = n.x / SCALE;
      const y = n.y / SCALE;
      if (
        Math.abs(x - this.pos[k * 2]!) > 1e-4 ||
        Math.abs(y - this.pos[k * 2 + 1]!) > 1e-4 ||
        Number.isNaN(this.pos[k * 2]!)
      ) {
        this.pos[k * 2] = x;
        this.pos[k * 2 + 1] = y;
        changed = true;
      }
    }
    if (!changed && !shownChanged) return false;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < this.nodes.length; k++) {
      if (!this.shown[k]) continue;
      x0 = Math.min(x0, this.pos[k * 2]!);
      y0 = Math.min(y0, this.pos[k * 2 + 1]!);
      x1 = Math.max(x1, this.pos[k * 2]!);
      y1 = Math.max(y1, this.pos[k * 2 + 1]!);
    }
    this.bounds =
      x0 <= x1
        ? {
            x0: x0 - BOARD_MARGIN,
            y0: y0 - BOARD_MARGIN,
            x1: x1 + BOARD_MARGIN,
            y1: y1 + BOARD_MARGIN,
          }
        : null;
    const b = this.bounds;
    const all = new Float32Array((this.nodes.length + 1) * 6);
    if (b) all.set([b.x0, b.y0, -BOARD_DEPTH, b.x1, b.y1, BOARD_TOP], 0);
    for (let k = 0; k < this.nodes.length; k++) {
      const x = this.pos[k * 2]!;
      const y = this.pos[k * 2 + 1]!;
      if (Number.isNaN(x)) continue;
      all.set(
        [x - BLOCK / 2, y - BLOCK / 2, 0, x + BLOCK / 2, y + BLOCK / 2, BLOCK_H],
        (k + 1) * 6,
      );
    }
    three.boxes.moveBoxes(all);
    if (b) three.grid.setBounds(b.x0, b.y0, b.x1, b.y1);
    three.grid.setVisible(!!b);
    three.boxes.setState(0, b ? STATE.rest : STATE.hidden);
    this.moved = true;
    this.mini = null;
    return true;
  }

  /** Each column lit as what the controller shows, lifted to its level; what has not come, hidden. */
  private light(): void {
    const three = this.three;
    if (!three) return;
    const model = this.model;
    const sel = this.selected ? this.index.get(this.selected) : undefined;
    const steps = (this.path?.nodes ?? [])
      .map((n) => this.index.get(n))
      .filter((k): k is number => k !== undefined);
    const linked = new Set<number>(this.selected && model ? this.linksOf(this.selected) : []);
    const focus = sel !== undefined || steps.length > 0;
    const onPath = new Set(steps);
    const found = new Set<number>();
    for (const n of this.matches ?? []) {
      const k = this.index.get(n);
      if (k !== undefined) found.add(k);
    }
    const preview = this.previewed ? this.index.get(this.previewed) : undefined;
    const want = new Map<number, number>();
    for (let k = 0; k < this.nodes.length; k++) {
      let state: number = focus ? STATE.dim : STATE.rest;
      if (found.has(k)) state = STATE.found;
      if (linked.has(k)) state = STATE.linked;
      if (onPath.has(k))
        state = k === steps[0] || k === steps[steps.length - 1] ? STATE.selected : STATE.linked;
      if (k === preview || k === this.hovered) state = STATE.hover;
      if (k === sel) state = STATE.selected;
      if (!this.shown[k]) state = STATE.hidden;
      three.boxes.setState(k + 1, state);
      // Lifted to their level: a focus's own two, a path's ends and steps; a pointed block a little.
      let to = 0;
      if (k === preview || k === this.hovered) to = LIFT_POINTED;
      if (linked.has(k)) to = LEVEL_LINKED;
      if (onPath.has(k))
        to = k === steps[0] || k === steps[steps.length - 1] ? LEVEL_SELECTED : LEVEL_LINKED;
      if (k === sel) to = LEVEL_SELECTED;
      if (to > 0 && this.shown[k]) want.set(k, to);
    }
    for (const [k, l] of this.lifts) if (!want.has(k)) l.to = 0;
    for (const [k, to] of want) {
      const l = this.lifts.get(k);
      if (l) l.to = to;
      else this.lifts.set(k, { now: 0, to });
    }
    this.dirty = true;
  }

  private stepLifts(dt: number): boolean {
    const three = this.three;
    if (!three || !this.lifts.size) return false;
    let moving = false;
    const k = this.host?.reduceMotion ? 1 : Math.min(1, dt / 70);
    for (const [i, l] of this.lifts) {
      if (l.now === l.to) continue;
      l.now += (l.to - l.now) * k;
      if (Math.abs(l.now - l.to) < 0.004) l.now = l.to;
      three.boxes.setLift(i + 1, l.now);
      if (l.now !== l.to) moving = true;
    }
    for (const [i, l] of this.lifts) if (l.now === 0 && l.to === 0) this.lifts.delete(i);
    return moving;
  }

  /**
   * The links: flat on the board inside a project, arced over it between two; and the focus's
   * wires, orthogonal between its two levels. Laid again when the notes moved or the focus changed.
   */
  private layCables(): void {
    const three = this.three;
    if (!three) return;
    const sel = this.selected ? this.index.get(this.selected) : undefined;
    const focusKey = `${this.selected?.id ?? ''}|${(this.path?.nodes ?? []).map((n) => n.id).join('\n')}`;
    const newFocus = focusKey !== this.focusLaid;
    if (!this.moved && !newFocus) return;
    this.moved = false;
    if (newFocus) {
      this.focusLaid = focusKey;
      this.grown = this.host?.reduceMotion || focusKey === '|' ? 1 : 0;
    }
    const at = (k: number): [number, number] => [this.pos[k * 2]!, this.pos[k * 2 + 1]!];
    const steps = (this.path?.nodes ?? [])
      .map((n) => this.index.get(n))
      .filter((k): k is number => k !== undefined);
    const inFocus = (a: number, b: number) => sel !== undefined && (a === sel || b === sel);
    const flat: Route[] = [];
    const arcs: Route[] = [];
    for (const { a, b, across } of this.links) {
      if (!this.shown[a] || !this.shown[b] || inFocus(a, b)) continue;
      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      if (!across) {
        flat.push(
          route([
            [ax, ay, ON_BOARD],
            [bx, by, ON_BOARD],
          ]),
        );
        continue;
      }
      const len = Math.hypot(bx - ax, by - ay);
      const pts: Vec3[] = [];
      for (let i = 0; i <= ARC_STEPS; i++) {
        const t = i / ARC_STEPS;
        pts.push([
          ax + (bx - ax) * t,
          ay + (by - ay) * t,
          ON_BOARD + Math.sin(Math.PI * t) * len * ARC_RISE,
        ]);
      }
      arcs.push(route(pts));
    }
    const board: CableSet[] = [
      { kind: CABLE.route, routes: flat, widths: flat.map(() => 1) },
      { kind: CABLE.route, routes: arcs, widths: arcs.map(() => 1.25) },
    ];
    three.board.set(board);
    three.board.setFade(sel !== undefined || steps.length ? OUT_OF_FOCUS : 1);
    // The focus: from the note on its level down to its links on theirs, square on the way.
    const wires: Route[] = [];
    const wire = (a: number, la: number, b: number, lb: number) => {
      // Out of the higher column's bottom, into the lower one's top; between two at one level,
      // top to top over a step above both.
      if (la < lb) [a, la, b, lb] = [b, lb, a, la];
      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      if (la === lb) {
        const over = la + BLOCK_H + 0.3;
        wires.push(
          route([
            [ax, ay, la + BLOCK_H],
            [ax, ay, over],
            [bx, ay, over],
            [bx, by, over],
            [bx, by, lb + BLOCK_H],
          ]),
        );
        return;
      }
      const mid = (la + lb + BLOCK_H) / 2;
      wires.push(
        route([
          [ax, ay, la],
          [ax, ay, mid],
          [bx, ay, mid],
          [bx, by, mid],
          [bx, by, lb + BLOCK_H],
        ]),
      );
    };
    if (sel !== undefined && this.shown[sel]) {
      for (const k of this.linksOf(this.selected!))
        if (k !== sel && this.shown[k]) wire(sel, LEVEL_SELECTED, k, LEVEL_LINKED);
    }
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1]!;
      const b = steps[i]!;
      if (!this.shown[a] || !this.shown[b]) continue;
      const level = (k: number) =>
        k === steps[0] || k === steps[steps.length - 1] ? LEVEL_SELECTED : LEVEL_LINKED;
      wire(a, level(a), b, level(b));
    }
    three.focus.set([{ kind: CABLE.link, routes: wires }]);
    three.focus.setProgress(easeOut(this.grown));
    this.dirty = true;
  }

  private stepGrowth(dt: number): boolean {
    if (this.grown >= 1) return false;
    this.grown = this.host?.reduceMotion ? 1 : Math.min(1, this.grown + dt / GROW_MS);
    this.three?.focus.setProgress(easeOut(this.grown));
    return true;
  }

  private draw(): void {
    const host = this.host;
    const three = this.three;
    if (!host || !three) return;
    const { camera, boxes, grid, marks, board, focus } = three;
    applyIsoCamera(camera, this.cam, this.vp, this.reach());
    boxes.setView([Math.cos(this.cam.az), Math.sin(this.cam.az)]);
    boxes.setScale(this.cam.ppu, this.dpr);
    grid.setScale(this.cam.ppu, this.dpr);
    board.setScale(this.cam.ppu, this.dpr, this.vp);
    focus.setScale(this.cam.ppu, this.dpr, this.vp);
    marks.set(this.liftMarks(), this.cam.ppu);
    host.renderer.render(three.scene, camera);
    const ctx = host.overlay;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.drawFound(ctx);
    this.labelHits = this.drawLabels(ctx);
    this.drawMinimap();
    this.drawnCam = { ...this.cam };
  }

  private reach(): number {
    const across = (this.vp.width + this.vp.height) / this.cam.ppu;
    return 50 + across / Math.max(Math.sin(this.cam.el), 0.25);
  }

  private project() {
    return isoProject(this.cam, this.vp);
  }

  private liftMarks(): LiftMark[] {
    const out: LiftMark[] = [];
    const sel = this.selected ? this.index.get(this.selected) : undefined;
    const ends = this.path
      ? [this.path.nodes[0], this.path.nodes.at(-1)].map((n) => (n ? this.index.get(n) : undefined))
      : [];
    for (const [k, l] of this.lifts) {
      if (l.now < 0.02 || !this.shown[k]) continue;
      const x = this.pos[k * 2]!;
      const y = this.pos[k * 2 + 1]!;
      out.push({
        x0: x - BLOCK / 2,
        y0: y - BLOCK / 2,
        x1: x + BLOCK / 2,
        y1: y + BLOCK / 2,
        base: 0,
        lifted: l.now,
        color: k === sel || ends.includes(k) || l.to >= LEVEL_LINKED ? 'accent' : 'hover',
      });
    }
    return out;
  }

  private blockBox(k: number, top = BLOCK_H): Box3 {
    const x = this.pos[k * 2]!;
    const y = this.pos[k * 2 + 1]!;
    return {
      x0: x - BLOCK / 2,
      y0: y - BLOCK / 2,
      z0: 0,
      x1: x + BLOCK / 2,
      y1: y + BLOCK / 2,
      z1: top,
    };
  }

  /** The note nearest the pointer, where its top is drawn: a label first, which picks what it names. */
  private pickAt(x: number, y: number, touch: boolean): number | null {
    for (let i = this.labelHits.length - 1; i >= 0; i--) {
      const { rect: r, note } = this.labelHits[i]!;
      if (x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h) return note;
    }
    const project = this.project();
    const reach = Math.max(touch ? PICK_PX.touch : PICK_PX.mouse, (this.cam.ppu * BLOCK) / 1.4);
    let best: number | null = null;
    let score = reach * reach;
    for (let k = 0; k < this.nodes.length; k++) {
      if (!this.shown[k]) continue;
      const p = project(
        this.pos[k * 2]!,
        this.pos[k * 2 + 1]!,
        (this.lifts.get(k)?.now ?? 0) + BLOCK_H / 2,
      );
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < score) {
        score = d;
        best = k;
      }
    }
    return best;
  }

  private hoverAt(x: number, y: number): void {
    const k = this.pickAt(x, y, false);
    this.host?.setCursor(k !== null ? 'pointer' : 'grab');
    if (k === this.hovered) return;
    this.hovered = k;
    this.light();
  }

  // -- Camera ---------------------------------------------------------------------------------

  /** The person moved the camera: it stays where they put it. */
  private handMoved(): void {
    this.autoFit = false;
    this.aim = null;
    this.host?.onUserCamera();
  }

  private orientation(): { az: number; el: number } {
    return { az: snapAz(this.turns, this.plan), el: this.plan ? PLAN_EL : ISO_EL };
  }

  private target(): IsoCam {
    return { ...(this.tween?.to ?? this.cam), ...this.orientation() };
  }

  private fly(to: IsoCam, ms = FLY_MS): void {
    if (this.host?.reduceMotion) {
      this.cam = to;
      this.tween = null;
      this.dirty = true;
      return;
    }
    // On the frames' own clock, which the flight is stepped by.
    this.tween = { from: { ...this.cam }, to, t0: this.lastNow || performance.now(), ms };
  }

  private fitCam(from: IsoCam = this.target()): IsoCam {
    const b = this.bounds;
    if (!b) return from;
    return isoFit(
      from,
      this.vp,
      [{ x0: b.x0, y0: b.y0, z0: -BOARD_DEPTH, x1: b.x1, y1: b.y1, z1: BLOCK_H }],
      this.free(),
    );
  }

  private turn(by: number): void {
    this.turns += by;
    this.reorient(TURN_MS);
  }

  /** A new orientation about the selected note, or the middle of the free stage. */
  private reorient(ms: number): void {
    const turned = this.target();
    const free = this.free();
    const middle = { x: free.x + free.w / 2, y: free.y + free.h / 2 };
    const k = this.selected ? this.index.get(this.selected) : undefined;
    const at =
      k !== undefined && this.shown[k]
        ? { x: this.pos[k * 2]!, y: this.pos[k * 2 + 1]!, z: 0 }
        : { ...isoUnproject(this.tween?.to ?? this.cam, this.vp, middle.x, middle.y, 0), z: 0 };
    this.handMoved();
    this.fly({ ...turned, ...targetFor(turned, this.vp, at, middle) }, ms);
  }

  private firstTwo(): [{ x: number; y: number }, { x: number; y: number }] {
    const [a, b] = [...this.pointers.values()];
    return [a!, b!];
  }

  private free(): Rect {
    const r = freeStage(this.vp.width, this.vp.height, this.chrome, 'bands');
    const m = 12;
    return { x: r.x + m, y: r.y + m, w: Math.max(1, r.w - 2 * m), h: Math.max(1, r.h - 2 * m) };
  }

  // -- The overlay ------------------------------------------------------------------------------

  /** Names: the focus's, a path's steps numbered, what a search found, the projects, then any note with room. */
  private drawLabels(ctx: CanvasRenderingContext2D): { rect: Rect; note: number }[] {
    const host = this.host;
    if (!host) return [];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const space = new LabelSpace({
      x: MARGIN,
      y: MARGIN,
      w: this.vp.width - 2 * MARGIN,
      h: this.vp.height - 2 * MARGIN,
    });
    for (const r of this.chrome) space.reserve(r);
    const project = this.project();
    const px = host.labelPx;
    const hits: { rect: Rect; note: number }[] = [];
    const named = new Set<number>();
    const top = (k: number) =>
      project(this.pos[k * 2]!, this.pos[k * 2 + 1]!, (this.lifts.get(k)?.now ?? 0) + BLOCK_H);
    const onStage = (k: number) => {
      if (!this.shown[k]) return false;
      const p = top(k);
      return p.x >= 0 && p.y >= 0 && p.x <= this.vp.width && p.y <= this.vp.height;
    };
    const steps = (this.path?.nodes ?? [])
      .map((n) => this.index.get(n))
      .filter((k): k is number => k !== undefined);
    const sel = this.selected ? this.index.get(this.selected) : undefined;
    const note = (k: number, strong: boolean, force: boolean) => {
      if (named.has(k) || !onStage(k)) return;
      const step = steps.indexOf(k) + 1;
      const title = this.nodes[k]?.label ?? this.nodes[k]?.title ?? '';
      if (!title) return;
      const name =
        title.length > (strong ? 46 : 30) ? `${title.slice(0, strong ? 45 : 29)}…` : title;
      const text = step ? `${step} · ${name}` : name;
      const font = strong ? `600 ${px + 1}px ${host.fonts.sans}` : `500 ${px}px ${host.fonts.sans}`;
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(text).width) + 2 * INSET;
      const h = px + (strong ? 11 : 9);
      const p = top(k);
      const half = (this.cam.ppu * BLOCK) / 2;
      const slots = [
        { x: p.x - w / 2, y: p.y + half + 6, w, h },
        { x: p.x - w / 2, y: p.y - half - 6 - h, w, h },
        { x: p.x + half + 6, y: p.y - h / 2, w, h },
        { x: p.x - half - 6 - w, y: p.y - h / 2, w, h },
      ];
      let rect = space.place(slots);
      if (!rect && force) {
        rect = slots[0]!;
        space.take(rect);
      }
      if (!rect) return;
      named.add(k);
      const active = strong || step > 0 || k === sel;
      this.tag(
        ctx,
        rect,
        text,
        font,
        active ? LABEL_COLORS.strong : LABEL_COLORS.body,
        active ? this.theme.accent : LABEL_COLORS.tagEdge,
        strong ? 1.5 : 1,
      );
      hits.push({ rect, note: k });
    };
    if (sel !== undefined) note(sel, true, true);
    if (steps.length) {
      note(steps[0]!, true, true);
      note(steps[steps.length - 1]!, true, true);
    }
    if (this.hovered !== null) note(this.hovered, false, true);
    for (const k of steps) note(k, false, false);
    if (this.selected) for (const k of this.linksOf(this.selected)) note(k, false, false);
    let found = 0;
    for (const n of this.matches ?? []) {
      const k = this.index.get(n);
      if (k === undefined || !onStage(k)) continue;
      note(k, false, false);
      if (++found >= 40) break;
    }
    // The projects, at the middle of their notes, in spaced mono capitals.
    if (this.model)
      for (const group of this.model.projects) {
        let sx = 0;
        let sy = 0;
        let count = 0;
        for (const n of group.nodes) {
          const k = this.index.get(n);
          if (k === undefined || !this.shown[k]) continue;
          sx += this.pos[k * 2]!;
          sy += this.pos[k * 2 + 1]!;
          count++;
        }
        if (count < 2) continue;
        const p = project(sx / count, sy / count, 0);
        const text = group.label.toUpperCase();
        const font = `600 ${px}px ${host.fonts.mono}`;
        ctx.font = font;
        const w = Math.ceil(ctx.measureText(text).width) + 2 * INSET;
        const h = px + 9;
        const rect = space.place([{ x: p.x - w / 2, y: p.y - h / 2, w, h }]);
        if (rect) this.tag(ctx, rect, text, font, LABEL_COLORS.strong, LABEL_COLORS.tagEdge, 1);
      }
    // Any other note there is room for, the most linked first, once close enough to read.
    if (this.cam.ppu >= NAMES_PPU && this.model) {
      const degree = (k: number) => this.model!.adjacency.get(this.nodes[k]!)?.length ?? 0;
      const rest = this.nodes
        .map((_, k) => k)
        .filter((k) => !named.has(k) && onStage(k))
        .sort((a, b) => degree(b) - degree(a) || a - b);
      for (const k of rest.slice(0, REST_TRIED)) note(k, false, false);
    }
    return hits;
  }

  private tag(
    ctx: CanvasRenderingContext2D,
    r: Rect,
    text: string,
    font: string,
    ink: string,
    edge: string,
    edgeWidth: number,
  ): void {
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 3);
    ctx.fillStyle = LABEL_COLORS.tag;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(r.x + edgeWidth / 2, r.y + edgeWidth / 2, r.w - edgeWidth, r.h - edgeWidth, 3);
    ctx.strokeStyle = edge;
    ctx.lineWidth = edgeWidth;
    ctx.stroke();
    ctx.font = font;
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, r.x + INSET, r.y + r.h / 2 + 0.5);
  }

  /** What a search found, bracketed wherever it stands on the stage. */
  private drawFound(ctx: CanvasRenderingContext2D): void {
    if (!this.matches?.size) return;
    const project = this.project();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    let drawn = 0;
    for (const n of this.matches) {
      const k = this.index.get(n);
      if (k === undefined || !this.shown[k]) continue;
      const lift = this.lifts.get(k)?.now ?? 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      const b = this.blockBox(k);
      for (const x of [b.x0, b.x1])
        for (const y of [b.y0, b.y1])
          for (const z of [lift, lift + BLOCK_H]) {
            const p = project(x, y, z);
            x0 = Math.min(x0, p.x);
            y0 = Math.min(y0, p.y);
            x1 = Math.max(x1, p.x);
            y1 = Math.max(y1, p.y);
          }
      if (x1 < 0 || y1 < 0 || x0 > this.vp.width || y0 > this.vp.height) continue;
      const pad = 4;
      const l = 6;
      for (const [cx, cy, sx, sy] of [
        [x0 - pad, y0 - pad, 1, 1],
        [x1 + pad, y0 - pad, -1, 1],
        [x1 + pad, y1 + pad, -1, -1],
        [x0 - pad, y1 + pad, 1, -1],
      ] as const) {
        ctx.moveTo(cx, cy + sy * l);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * l, cy);
      }
      if (++drawn >= FOUND_MARKS) break;
    }
    if (!drawn) return;
    ctx.strokeStyle = this.theme.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private mini: { cam: IsoCam; vp: Viewport } | null = null;

  /** The board from straight above, north up: its notes as dots, the stage's view on it. */
  private drawMinimap(): void {
    const canvas = this.host?.minimap;
    const b = this.bounds;
    if (!canvas || !b) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 1 || h < 1) {
      this.mini = null;
      return;
    }
    const bw = Math.round(w * this.dpr);
    const bh = Math.round(h * this.dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const vp = { width: w, height: h };
    if (!this.mini || this.mini.vp.width !== w || this.mini.vp.height !== h) {
      const plan: IsoCam = { tx: 0, ty: 0, tz: 0, az: snapAz(0, true), el: PLAN_EL, ppu: 1 };
      const cam = isoFit(
        plan,
        vp,
        [{ x0: b.x0, y0: b.y0, z0: 0, x1: b.x1, y1: b.y1, z1: 0 }],
        { x: 0, y: 0, w, h },
        { margin: MINI_MARGIN, minPpu: 1e-4, maxPpu: 1e4 },
      );
      this.mini = { cam, vp };
    }
    const project = isoProject(this.mini.cam, vp);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = LABEL_COLORS.tag;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = this.theme.blockEdge;
    for (let k = 0; k < this.nodes.length; k++) {
      if (!this.shown[k]) continue;
      const q = project(this.pos[k * 2]!, this.pos[k * 2 + 1]!, 0);
      ctx.fillRect(q.x - 0.75, q.y - 0.75, 1.5, 1.5);
    }
    const free = this.free();
    const view = [
      [free.x, free.y],
      [free.x + free.w, free.y],
      [free.x + free.w, free.y + free.h],
      [free.x, free.y + free.h],
    ].map(([sx, sy]) => {
      const g = isoUnproject(this.cam, this.vp, sx!, sy!, 0);
      return project(g.x, g.y, 0);
    });
    const outline = () => {
      view.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
    };
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    outline();
    ctx.fillStyle = MINI_VEIL;
    ctx.fill('evenodd');
    if (view.every((q) => q.x >= -1 && q.y >= -1 && q.x <= w + 1 && q.y <= h + 1)) {
      ctx.beginPath();
      outline();
      ctx.strokeStyle = LABEL_COLORS.hoverEdge;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = this.theme.accent;
    let found = 0;
    for (const n of this.matches ?? []) {
      const k = this.index.get(n);
      if (k === undefined || !this.shown[k]) continue;
      const q = project(this.pos[k * 2]!, this.pos[k * 2 + 1]!, 0);
      ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
      if (++found >= FOUND_MARKS) break;
    }
    const sel = this.selected ? this.index.get(this.selected) : undefined;
    if (sel !== undefined && this.shown[sel]) {
      const q = project(this.pos[sel * 2]!, this.pos[sel * 2 + 1]!, 0);
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A cable through these points, measured. */
function route(points: Vec3[]): Route {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return { points, length };
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
