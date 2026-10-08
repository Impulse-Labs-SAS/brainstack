// The Sentinel's own GPU time, from `EXT_disjoint_timer_query_webgl2`. Frame
// times alone cannot say whether the creature or the graph is the slow part;
// this can, and the governor only steps up, or gives way to the trail, on its
// word. Chrome on the desktop has the extension; where it is missing the
// governor falls back to counting missed frames.
//
// A query's result arrives frames after it ends, so queries go round a ring
// of eight and each frame reads whatever has finished. The classic
// WebGLRenderer never issues timer queries of its own, so one around the
// Sentinel's passes cannot nest with one of three's.

/** The two names the extension adds that the timer needs; lib.dom does not declare it. */
interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

const RING = 8;

export class GpuTimer {
  private readonly idle: WebGLQuery[];
  /** Ended and awaiting their result, oldest first; read in that order. */
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private disposed = false;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerQueryExt,
    queries: WebGLQuery[],
  ) {
    this.idle = queries;
  }

  /** A timer on this context, or null where the extension is missing. */
  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    if (!ext) return null;
    const queries: WebGLQuery[] = [];
    for (let i = 0; i < RING; i++) {
      const query = gl.createQuery();
      if (!query) {
        for (const q of queries) gl.deleteQuery(q);
        return null;
      }
      queries.push(query);
    }
    return new GpuTimer(gl, ext, queries);
  }

  /** Start timing; a no-op while a measurement is open or all eight await their result. */
  begin(): void {
    if (this.disposed || this.active) return;
    const query = this.idle.pop();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /**
   * The newest measurement that finished since the last poll, in ms, or null
   * when none did. Call it once a frame, outside `begin`/`end`.
   */
  poll(): number | null {
    if (this.disposed) return null;
    const gl = this.gl;
    // A disjoint event — the GPU changed clocks, or something else took it over —
    // makes every result still in flight meaningless. Reading the flag clears it.
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.idle.push(...this.pending.splice(0));
      return null;
    }
    let latest: number | null = null;
    while (this.pending.length > 0) {
      const query = this.pending[0]!;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      // Nanoseconds.
      latest = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
      this.pending.shift();
      this.idle.push(query);
    }
    return latest;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.idle.push(this.active);
      this.active = null;
    }
    for (const query of [...this.idle, ...this.pending]) this.gl.deleteQuery(query);
    this.idle.length = 0;
    this.pending.length = 0;
  }
}
