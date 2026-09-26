// d3-force-3d ships no types. This covers the part of its API the graph uses;
// it mirrors @types/d3-force with a z axis.
declare module 'd3-force-3d' {
  export interface SimulationNodeDatum {
    index?: number;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface Force<N> {
    (alpha: number): void;
    initialize?(nodes: N[], random: () => number, numDimensions: number): void;
  }

  export interface Simulation<N extends SimulationNodeDatum> {
    stop(): this;
    tick(iterations?: number): this;
    nodes(): N[];
    nodes(nodes: N[]): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaMin(min: number): this;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    alphaTarget(): number;
    alphaTarget(target: number): this;
    velocityDecay(): number;
    velocityDecay(decay: number): this;
    numDimensions(): number;
    numDimensions(n: 1 | 2 | 3): this;
    force(name: string): Force<N> | undefined;
    force(name: string, force: Force<N> | null): this;
  }
  export function forceSimulation<N extends SimulationNodeDatum>(nodes?: N[], numDimensions?: 1 | 2 | 3): Simulation<N>;

  export interface ForceLink<N, L> extends Force<N> {
    links(): L[];
    links(links: L[]): this;
    distance(distance: number | ((link: L) => number)): this;
    strength(strength: number | ((link: L) => number)): this;
  }
  export function forceLink<N, L>(links?: L[]): ForceLink<N, L>;

  export interface ForceManyBody<N> extends Force<N> {
    strength(strength: number | ((node: N) => number)): this;
    theta(theta: number): this;
    distanceMax(distance: number): this;
  }
  export function forceManyBody<N>(): ForceManyBody<N>;

  export interface ForceCollide<N> extends Force<N> {
    strength(strength: number): this;
  }
  export function forceCollide<N>(radius?: number | ((node: N) => number)): ForceCollide<N>;

  export interface ForcePosition<N> extends Force<N> {
    strength(strength: number | ((node: N) => number)): this;
  }
  export function forceX<N>(x?: number | ((node: N) => number)): ForcePosition<N>;
  export function forceY<N>(y?: number | ((node: N) => number)): ForcePosition<N>;
  export function forceZ<N>(z?: number | ((node: N) => number)): ForcePosition<N>;
}
