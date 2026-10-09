// The dormant network's shaders, as GLSL strings: the form's cage, the
// crystals, the dormant filaments, the walked tubes, and the halos and rings
// of found notes. Plain strings, no three: the GPU modules beside this one
// build their materials from them, all over one shared set of uniforms.
//
// What the shaders share:
//
//  - The state textures (state.ts) hold when things happened on the replay's
//    clock. A shader reads a stamp, and turns the time since into light — a
//    flare that settles, a trail that cools — so nothing is uploaded while it
//    does. "Never" is a time far in the future: everything is written as
//    `happened(t) · f(since(t))`, never as an exponential of a negative age,
//    which a stamp in the future would turn into infinity.
//  - The eye's pool (`eyePool`): the cone the Sentinel's eye lights, the same
//    angles as its spotlight, fading with distance, plus a little spill right
//    under the lens. It is the only thing that makes the dormant glass shine:
//    outside it there is no specular at all, so 1,600 flat facets never
//    glitter at once.
//  - The fades: near the camera everything dissolves — crystals, tubes and
//    filaments through alpha to coverage, sprites by their light — so nothing
//    blocks or near-clips the view from inside the volume; beyond the focus
//    things dim as the brain's `depthFade` dims them, so the volume reads
//    near to far instead of as a tangle; and far from where the camera looks,
//    dormant light falls off (`focusOf`). Lit things keep most of theirs. The
//    depth cue knob scales both. Crystals and filaments are opaque, so they
//    fade towards the background rather than to black: dimmed to black, a
//    far thread would draw darker than the canvas it crosses, a dark line
//    where the brain's additive ones simply recede.
//  - The output: colour is worked in linear light and only its highlights are
//    rolled off — the darks the dormant network lives in stay exactly as
//    they are — then encoded for the canvas and dithered, so the faint
//    gradients in the dark glass do not band. Every material says `toneMapped:
//    false`: the renderer's own tone mapping never applies, whatever it is
//    set to, so nothing here recompiles when it changes.
//
// Reduced motion (`uStill`) keeps every state and drops what moves on its
// own: no flares, pops, pulses, scan bands or rings. Wall-clock motion
// (`uTime`) — pulses, the slow breathing of found notes — runs on while the
// replay is paused; everything stamped runs on the replay's clock and stops.

import { STATE_WIDTH } from './state';

/** Uniforms and helpers every stage may use. */
const COMMON = /* glsl */ `
  #define STATE_W ${STATE_WIDTH}
  uniform highp sampler2D uNodes;
  uniform highp sampler2D uThreads;
  uniform float uClock;
  uniform float uTime;
  uniform float uStill;
  uniform float uUnit;
  uniform vec3 uAccent;
  uniform vec3 uWhy[4];

  // Seconds since a stamp, 0 before it; and whether it has happened. A stamp
  // of "never" lies in the future, so it has not.
  float since(float t) { return max(uClock - t, 0.0); }
  float happened(float t) { return step(t, uClock); }
`;

/** Reading the state textures, by a note's or a thread's index. */
const STATE = /* glsl */ `
  vec4 nodeTexel(float i) {
    int k = int(i + 0.5);
    return texelFetch(uNodes, ivec2(k % STATE_W, k / STATE_W), 0);
  }
  vec4 threadTexel(float t, int part) {
    int k = int(t + 0.5) * 2 + part;
    return texelFetch(uThreads, ivec2(k % STATE_W, k / STATE_W), 0);
  }
  // A vertex nothing should be drawn from: outside the clip volume.
  #define COLLAPSE { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
`;

/** The eye's pool of light, world space. */
const EYE = /* glsl */ `
  uniform vec3 uEyePos;
  uniform vec3 uEyeDir;
  // cos of the cone's edge, cos of its full-strength core, reach (world units), gain.
  uniform vec4 uEyeCone;
  // The spill right round the lens, world units.
  uniform float uEyeSpill;

  // How much the eye reveals at p, on a surface facing n: 0 outside its
  // reach, about 1 in the middle of its cone at rest.
  float eyePool(vec3 p, vec3 n) {
    vec3 toEye = uEyePos - p;
    float d = length(toEye);
    vec3 l = toEye / max(d, 1e-5);
    float cone = smoothstep(uEyeCone.x, uEyeCone.y, dot(-l, uEyeDir));
    float x = d / max(uEyeCone.z, 1e-5);
    float fall = (1.0 - smoothstep(0.6, 1.0, x)) / (1.0 + 8.0 * x * x);
    float s = clamp(1.0 - d / max(uEyeSpill, 1e-5), 0.0, 1.0);
    float lit = cone * fall + 0.5 * s * s;
    return min(lit * uEyeCone.w, 1.5) * (0.35 + 0.65 * max(dot(n, l), 0.0));
  }
`;

/** The depth, near and focus fades. */
const FADE = /* glsl */ `
  uniform vec3 uTarget;
  uniform float uFocus;
  // The brain's depthFade: whole up to where the camera looks, then dimmer
  // over uDepthRange, never under the floor. World units.
  uniform float uDepthRange;
  uniform float uDepthFloor;
  // Nothing within uNearFade.x of the camera, whole beyond .y, world units; .y of 0 turns it off.
  uniform vec2 uNearFade;
  // How much of the dimming beyond the focus applies, 0–1: the depth cue knob.
  uniform float uCue;
  // The canvas's clear colour, linear: what an opaque dormant thing fades into.
  uniform vec3 uBackground;

  float depthOf(float depth) {
    return clamp(1.0 - (depth - uFocus) / max(uDepthRange, 1e-3), uDepthFloor, 1.0);
  }
  float nearOf(float d) { return uNearFade.y > 0.0 ? smoothstep(uNearFade.x, uNearFade.y, d) : 1.0; }
  // The light left at p: 1 near where the camera looks, falling off to low
  // further out — as much of that fall as the depth cue knob keeps.
  float focusOf(vec3 p, float low) {
    float d = distance(p, uTarget);
    float near = 1.0 - smoothstep(0.6 * uFocus, 1.6 * uFocus + 4.0 * uUnit, d);
    return 1.0 - uCue * (1.0 - low) * (1.0 - near);
  }
`;

/** Writing a pixel. */
const OUT = /* glsl */ `
  // Highlights roll off towards white; below the knee, colour is untouched.
  vec3 shoulder(vec3 c) {
    float peak = max(c.r, max(c.g, c.b));
    const float knee = 0.76;
    const float room = 1.0 - knee;
    if (peak <= knee) return c;
    float top = 1.0 - room * room / (peak + room - knee);
    c *= top / peak;
    float g = 1.0 - 1.0 / (0.15 * (peak - top) + 1.0);
    return mix(c, vec3(top), g);
  }
  // Interleaved gradient noise, ±half a step of the 8-bit canvas.
  float dither() {
    return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  }
  void finish(vec3 c, float alpha) {
    gl_FragColor = linearToOutputTexel(vec4(shoulder(max(c, 0.0)), alpha));
    gl_FragColor.rgb += dither() / 255.0;
  }
  // For light added on top: no dither, which would add up where nothing is.
  void finishAdded(vec3 c) {
    gl_FragColor = linearToOutputTexel(vec4(shoulder(max(c, 0.0)), 1.0));
  }
`;

/** A key light that rides with the camera, view space: from above and to the left. */
const KEY = /* glsl */ `
  const vec3 KEY = vec3(-0.3913, 0.6148, 0.6848);
`;

// -- The cage ---------------------------------------------------------------------

export const CAGE_VS = /* glsl */ `
  ${COMMON}
  varying vec3 vWorld;
  varying vec3 vView;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;
    vWorld = world.xyz;
    vView = mv.xyz;
  }
`;

export const CAGE_FS = /* glsl */ `
  ${COMMON}
  ${EYE}
  ${FADE}
  ${OUT}
  uniform vec3 uCage;
  // The depths over which the cage comes in whole, world units: 0.8 and 1.8
  // times the form's bounding radius, so from the overview all of it shows,
  // and from a chase inside the hub the walls near the walk do not.
  uniform vec2 uCageFar;
  varying vec3 vWorld;
  varying vec3 vView;
  void main() {
    float depth = -vView.z;
    // Whole from afar, where it is the form's outline.
    float afar = smoothstep(uCageFar.x, uCageFar.y, depth);
    // Close up only where the eye looks, and never brighter than a third of a
    // dormant link: its long straight edges must not read as threads. A wire
    // faces every way, so the pool's facing term is taken as full.
    float pool = eyePool(vWorld, normalize(uEyePos - vWorld));
    finishAdded(uCage * (afar + 0.35 * pool) * depthOf(depth) * nearOf(length(vView)));
  }
`;

// -- Crystals ---------------------------------------------------------------------

export const CRYSTAL_VS = /* glsl */ `
  ${COMMON}
  ${STATE}
  ${EYE}
  ${FADE}
  attribute vec3 aEdge;
  // The inner light's height and radius, and the keel's height: the same at every vertex of a kind.
  attribute vec3 aShape;
  attribute float aNode;
  // The project's tint, linear, and a seed.
  attribute vec4 aLook;
  uniform float uPx;
  uniform float uEmber;
  // The note being read: index, start, end.
  uniform vec3 uRead;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vEdge;
  varying vec3 vTint;
  varying vec3 vCore;
  varying float vCoreR;
  varying float vY;
  varying float vPx;
  varying float vReveal;
  varying float vFade;
  // How much of it the near fade leaves: alpha to coverage dissolves the rest.
  varying float vNear;
  // Found level, ember, reading, flash.
  varying vec4 vLight;
  varying float vWhy;
  varying float vBand;

  // The ignition's swell: to 1.3 in 0.12 s, then a damped settle.
  float popOf(float a) {
    if (a < 0.12) return 0.3 * a / 0.12;
    float t = a - 0.12;
    return 0.3 * exp(-t / 0.12) * cos(t * 9.0);
  }

  void main() {
    // The light inside, which sits on the note: the whole gem fades by how
    // near it is to the camera, and one the camera is about to pass through
    // is gone, never cut open by the near plane.
    vec3 core = vec3(0.0, aShape.x, 0.0);
    mat4 m = modelMatrix * instanceMatrix;
    vec3 coreWorld = (m * vec4(core, 1.0)).xyz;
    vec3 coreView = (viewMatrix * vec4(coreWorld, 1.0)).xyz;
    float near = nearOf(length(coreView));
    if (near < 0.004) COLLAPSE
    vNear = near;

    vec4 st = nodeTexel(aNode);
    float moving = 1.0 - uStill;
    float seed = aLook.w;

    // Found: a white flash and a swell, settling to the colour of why, then a slow breath.
    float found = happened(st.y);
    float age = since(st.y);
    float flash = found * moving * exp(-age / 0.12);
    float pop = 1.0 + found * moving * popOf(age);
    float breath = 1.0 + moving * 0.12 * sin(6.2831853 * (uTime / 3.2 + seed));
    float lit = found * (1.0 + moving * 1.4 * exp(-age / 0.25)) * breath;
    // Reached: a flare as the walk passes, settling to an ember.
    float ember = happened(st.x) * (uEmber + moving * 0.5 * exp(-since(st.x) / 0.6));
    // Read: the core rises while the Sentinel dwells over it, then fades as it leaves.
    float reading = 0.0;
    float band = -1.0;
    if (abs(aNode - uRead.x) < 0.5) {
      float tau = uClock - uRead.y;
      float span = max(uRead.z - uRead.y, 1e-3);
      if (tau >= 0.0 && uClock <= uRead.z) {
        reading = 0.22 + 0.33 * smoothstep(0.0, 1.0, clamp(3.0 * tau / span, 0.0, 1.0));
        band = moving > 0.5 ? fract(tau / 0.9) : -1.0;
      } else if (uClock > uRead.z) {
        reading = 0.55 * exp(-(uClock - uRead.z) / 0.3);
      }
    }
    vLight = vec4(lit, ember, reading, flash);
    vWhy = st.z;
    vBand = band;

    // Swollen about its light, so it grows in place.
    vec3 local = core + (position - core) * pop;
    vec4 mv = viewMatrix * (m * vec4(local, 1.0));
    gl_Position = projectionMatrix * mv;

    // Normals through the inverse transpose: the frame's axes are square, so
    // dividing by each axis's squared length is enough.
    vec3 c0 = instanceMatrix[0].xyz;
    vec3 c1 = instanceMatrix[1].xyz;
    vec3 c2 = instanceMatrix[2].xyz;
    vec3 n = mat3(instanceMatrix) * (normal / vec3(dot(c0, c0), dot(c1, c1), dot(c2, c2)));
    vNormal = normalize(normalMatrix * n);
    vView = mv.xyz;
    vEdge = aEdge;
    vTint = aLook.rgb;
    vCore = coreView;
    vCoreR = aShape.y * length(c0) * pop;
    vY = clamp(1.0 - position.y / aShape.z, 0.0, 1.0);

    // A gem faces every way: the pool's facing term is taken as full.
    vReveal = eyePool(coreWorld, normalize(uEyePos - coreWorld));
    vFade = depthOf(-coreView.z) * focusOf(coreWorld, 0.35);
    vPx = length(c0) * uPx / max(-vCore.z, 1e-3);
  }
`;

export const CRYSTAL_FS = /* glsl */ `
  ${COMMON}
  ${OUT}
  ${KEY}
  uniform vec3 uGlass;
  uniform vec3 uBackground;
  uniform float uPip;
  uniform float uRim;
  uniform vec3 uRimTint;
  uniform float uSpec;
  uniform float uCoreLit;
  uniform vec3 uReadColour;
  uniform vec3 uEyeView;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vEdge;
  varying vec3 vTint;
  varying vec3 vCore;
  varying float vCoreR;
  varying float vY;
  varying float vPx;
  varying float vReveal;
  varying float vFade;
  varying float vNear;
  varying vec4 vLight;
  varying float vWhy;
  varying float vBand;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(-vView);
    float ndv = clamp(dot(n, v), 0.0, 1.0);

    // Dark glass: a little of the key light, a rim in the project's tint.
    vec3 c = uGlass * (0.3 + 0.7 * max(dot(n, KEY), 0.0));
    float rim = pow(1.0 - ndv, 4.0);
    c += mix(uRimTint, vTint, 0.55) * rim * uRim * (1.0 + 6.0 * vReveal);
    // The eye: a highlight and lit edges, only inside its pool.
    vec3 l = normalize(uEyeView - vView);
    float spec = pow(max(dot(n, normalize(l + v)), 0.0), 40.0);
    float e = min(min(vEdge.x, vEdge.y), vEdge.z);
    float edge = (1.0 - smoothstep(0.0, 1.5 * fwidth(e), e)) * smoothstep(4.0, 10.0, vPx);
    c += uAccent * vReveal * (spec * uSpec + 0.04 + 0.3 * edge);
    // Further off, towards the background: an opaque gem dimmed towards
    // black would stand out from afar as a hole in it.
    c = mix(uBackground, c, mix(0.3, 1.0, vFade));

    // The light inside: a sphere seen through the glass, the chord the eye's ray cuts through it.
    vec3 rd = normalize(vView);
    float tc = dot(vCore, rd);
    float d2 = max(dot(vCore, vCore) - tc * tc, 0.0);
    float rc2 = max(vCoreR * vCoreR, 1e-8);
    float core = sqrt(max(1.0 - d2 / rc2, 0.0));
    core = 0.65 * pow(core, 1.5) + 0.35 * exp(-d2 / (3.2 * rc2));

    // Asleep, a faint light in its project's tint: from afar, where the gem
    // is a few pixels and its glass and rim are lost, the whole of it glows a
    // little so the notes still read as points of the network; close up only
    // its heart does.
    c += vTint * uPip * mix(1.0, core, smoothstep(3.0, 12.0, vPx)) * mix(0.4, 1.0, vFade);

    float lit = vLight.x;
    float ember = vLight.y;
    float reading = vLight.z;
    vec3 light;
    float level;
    if (lit > 0.0) {
      vec3 why = uWhy[int(clamp(vWhy, 0.0, 3.0) + 0.5)];
      light = mix(why, vec3(1.0), 0.6 * vLight.w);
      level = lit * uCoreLit;
    } else if (reading > ember) {
      light = uReadColour;
      level = reading;
    } else {
      light = uAccent;
      level = ember;
    }
    c += light * level * (core + 0.4 * edge) * mix(0.7, 1.0, vFade);
    // Being read: a soft band rising up the gem, again and again.
    if (vBand >= 0.0) {
      float b = (vY - vBand) / 0.14;
      c += uReadColour * 0.6 * exp(-b * b) * (0.5 + 0.5 * edge);
    }
    // Near the camera, dimmed and dissolved by alpha to coverage.
    finish(c * vNear, vNear);
  }
`;

// -- Filaments --------------------------------------------------------------------

export const FILAMENT_VS = /* glsl */ `
  ${COMMON}
  ${STATE}
  ${EYE}
  ${FADE}
  attribute vec3 aA;
  attribute vec3 aB;
  attribute float aThread;
  // Where along its thread the chord starts and ends, from the key's first note, world units.
  attribute vec2 aS;
  attribute vec3 aTint;
  uniform float uPx;
  uniform vec2 uViewport;
  uniform float uNear;
  // Full width in world units, and the least in device pixels.
  uniform float uFilWidth;
  uniform float uFilMinPx;
  uniform float uFilGlow;
  varying float vAcross;
  varying float vHalf;
  varying vec3 vColour;
  // How far from the last grip along the thread, in glint widths; and the flash.
  varying float vFromGrip;
  varying float vFlash;
  // The end's view position, interpolated along the chord: the near fade per fragment.
  varying vec3 vEye;

  // A grip's glint along the thread: a third of a creature unit either side of the claw.
  #define GLINT 0.35
  float glint(float d) { return exp(-d * d); }

  void main() {
    vec4 a = modelViewMatrix * vec4(aA, 1.0);
    vec4 b = modelViewMatrix * vec4(aB, 1.0);
    // Cut at the near plane, so a chord passing beside the camera still projects.
    float zn = -uNear * 1.001;
    if (a.z > zn && b.z > zn) COLLAPSE
    if (a.z > zn) a = mix(a, b, (a.z - zn) / (a.z - b.z));
    else if (b.z > zn) b = mix(b, a, (b.z - zn) / (b.z - a.z));
    vec4 ca = projectionMatrix * a;
    vec4 cb = projectionMatrix * b;
    vec2 half_ = 0.5 * uViewport;
    vec2 sa = ca.xy / ca.w * half_;
    vec2 sb = cb.xy / cb.w * half_;
    vec2 dir = sb - sa;
    float l = length(dir);
    dir = l > 1e-6 ? dir / l : vec2(1.0, 0.0);
    vec2 across = vec2(-dir.y, dir.x);

    bool atB = position.x > 0.5;
    vec4 clip = atB ? cb : ca;
    float depth = max(atB ? -b.z : -a.z, 1e-3);
    // A grip closing on it: a flash that dies away, brightest round the claw.
    vec4 t0 = threadTexel(aThread, 0);
    vec4 t1 = threadTexel(aThread, 1);
    float flash = happened(t0.w) * (1.0 - uStill) * exp(-since(t0.w) / 0.7);
    float fromGrip = ((atB ? aS.y : aS.x) - t1.w * t1.y) / (GLINT * uUnit);
    // Its true width while that is more than the least; then the least, never thinner.
    float halfPx = max(0.5 * uFilWidth * uPx / depth, 0.5 * uFilMinPx) * (1.0 + 0.8 * flash * glint(fromGrip)) + 0.5;
    vec2 shift = across * position.y * halfPx + dir * (atB ? 1.0 : -1.0) * halfPx;
    clip.xy += shift / half_ * clip.w;
    gl_Position = clip;
    vAcross = position.y * halfPx;
    vHalf = halfPx;

    vec3 p = atB ? aB : aA;
    // A thread faces every way: the pool's facing term is taken as full.
    float reveal = eyePool(p, normalize(uEyePos - p));
    float fade = depthOf(depth) * focusOf(p, 0.3);
    // Opaque, so faded towards the background, as the brain's additive lines
    // recede into it, not drawn darker than the canvas it crosses.
    vColour = mix(uBackground, aTint * uFilGlow, fade) + uAccent * 0.15 * reveal;
    vFromGrip = fromGrip;
    vFlash = flash;
    vEye = (atB ? b : a).xyz;
  }
`;

export const FILAMENT_FS = /* glsl */ `
  ${COMMON}
  ${FADE}
  ${OUT}
  varying float vAcross;
  varying float vHalf;
  varying vec3 vColour;
  varying float vFromGrip;
  varying float vFlash;
  varying vec3 vEye;
  void main() {
    // Coverage across the ribbon, for alpha to coverage: solid in the middle,
    // a pixel of fringe — and less of it near the camera, per fragment, so a
    // long chord passing the camera fades where it passes, not by its ends.
    float cover = clamp(vHalf - abs(vAcross), 0.0, 1.0) * nearOf(length(vEye));
    if (cover <= 0.0) discard;
    // The whole thread flashes faintly; round the claw, brightly.
    float g = vFlash * (0.06 + 0.94 * exp(-vFromGrip * vFromGrip));
    finish(vColour * (1.0 + 2.0 * g) + uAccent * 0.5 * g, cover);
  }
`;

// -- Tubes ------------------------------------------------------------------------

export const TUBE_VS = /* glsl */ `
  ${COMMON}
  ${STATE}
  ${FADE}
  attribute vec3 aA;
  attribute vec3 aB;
  // Thread, and where along it the chord starts and ends from the key's first note.
  attribute vec3 aTube;
  uniform float uPx;
  uniform float uTubeR;
  uniform float uTubeMinPx;
  // The walk's thread and how far along it, the way it goes.
  uniform vec2 uHead;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vS;
  varying float vHeadS;
  varying vec3 vPassage;
  varying float vFade;

  void main() {
    vec4 t0 = threadTexel(aTube.x, 0);
    vec4 t1 = threadTexel(aTube.x, 1);
    float way = t0.z;
    float len = t1.y;
    if (way == 0.0) COLLAPSE
    // Drawn as far as the walk has gone along it: the walk's own place on the
    // thread it is on, else the passage's stamps; whole once gone along before.
    float frac = abs(aTube.x - uHead.x) < 0.5
      ? uHead.y
      : clamp((uClock - t0.x) / max(t0.y - t0.x, 1e-4), 0.0, 1.0);
    if (t1.z > 0.5) frac = 1.0;
    float headS = frac * len;
    float s0 = way > 0.0 ? aTube.y : len - aTube.y;
    float s1 = way > 0.0 ? aTube.z : len - aTube.z;
    if (min(s0, s1) > headS) COLLAPSE

    vec3 axis = aB - aA;
    vec3 mid = 0.5 * (aA + aB);
    vec3 t = normalize(axis);
    // The frame from world up, so it stays put along a thread; a chord
    // straight up takes x instead.
    vec3 side = cross(vec3(0.0, 1.0, 0.0), t);
    if (dot(side, side) < 1e-8) side = cross(vec3(1.0, 0.0, 0.0), t);
    // (p1, t, p2) right-handed, as the tube's local (x, y, z): its facets stay wound outwards.
    vec3 p1 = normalize(side);
    vec3 p2 = cross(p1, t);
    // Its true radius while that is more than the least; then the least.
    float depth = max(-(modelViewMatrix * vec4(mid, 1.0)).z, 1e-3);
    float r = max(uTubeR, uTubeMinPx * depth / uPx);
    // Each piece runs on a little past both its ends, so where a route bends
    // the pieces overlap rather than leave a gap on the outside of the bend.
    float over = 0.6 * r / max(length(axis), 1e-6);
    float y = mix(-over, 1.0 + over, position.y);
    vec3 ring = p1 * position.x + p2 * position.z;
    vec4 mv = modelViewMatrix * vec4(mix(aA, aB, y) + ring * r, 1.0);
    gl_Position = projectionMatrix * mv;
    vNormal = normalize(normalMatrix * ring);
    vView = mv.xyz;
    vS = mix(s0, s1, y);
    vHeadS = headS;
    // When it left the thread, the way and why it went, and the trail before it.
    vPassage = vec3(t0.y, way, t1.x);
    vFade = depthOf(depth);
  }
`;

export const TUBE_FS = /* glsl */ `
  ${COMMON}
  ${FADE}
  ${OUT}
  uniform float uTubeFloor;
  uniform float uPulseSpeed;
  uniform float uPulseGap;
  uniform float uPulseGain;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vS;
  varying float vHeadS;
  varying vec3 vPassage;
  varying float vFade;

  void main() {
    if (vS > vHeadS) discard;
    // Near the camera, dissolved by alpha to coverage.
    float near = nearOf(length(vView));
    if (near <= 0.0) discard;
    float ndv = abs(dot(normalize(vNormal), normalize(-vView)));
    float moving = 1.0 - uStill;
    float leave = vPassage.x;
    int why = int(abs(vPassage.y) - 0.5);
    // Heat behind the head while it walks, cooling once it has left the thread.
    float cooling = uClock < leave ? 1.0 : exp(-(uClock - leave) / 1.2);
    float heat = moving * exp(-max(vHeadS - vS, 0.0) / (1.5 * uUnit)) * cooling;
    // Pulses running the way it went, carried on from the thread before.
    float x = mod(vPassage.z + vS - uTime * uPulseSpeed, uPulseGap);
    float p = (x - 0.5 * uPulseGap) / (0.3 * uUnit);
    float pulse = moving * exp(-p * p);
    float floor_ = why == 0 ? uTubeFloor : min(1.0, uTubeFloor * 1.8);
    float level = floor_ * (1.0 + uPulseGain * pulse) + 1.2 * heat;
    vec3 colour = why == 0 ? uAccent : uWhy[clamp(why, 0, 3)];
    colour = mix(colour, vec3(1.0), 0.5 * min(heat, 1.0));
    // A glass rod with a hot wire down its middle.
    float i = level * (0.35 + 0.65 * ndv * ndv) + 0.8 * level * pow(ndv, 8.0);
    finish(colour * i * mix(0.6, 1.0, vFade) * near, near);
  }
`;

// -- Halos and rings --------------------------------------------------------------

export const HALO_VS = /* glsl */ `
  ${COMMON}
  ${STATE}
  ${FADE}
  attribute vec3 aPos;
  attribute float aNode;
  attribute float aSeed;
  uniform float uPx;
  uniform float uDpr;
  uniform float uHaloR;
  uniform float uHaloGain;
  varying vec2 vUv;
  varying vec3 vColour;

  void main() {
    vec4 st = nodeTexel(aNode);
    if (happened(st.y) < 0.5 || uHaloR <= 0.0) COLLAPSE
    vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
    // Near the camera it fades with the gem it lights, and is gone with it.
    float near = nearOf(length(mv.xyz));
    if (near <= 0.0) COLLAPSE
    float moving = 1.0 - uStill;
    float grow = moving > 0.5 ? smoothstep(0.0, 0.25, since(st.y)) : 1.0;
    float breath = 1.0 + moving * 0.12 * sin(6.2831853 * (uTime / 3.2 + aSeed));
    float depth = max(-mv.z, 1e-3);
    // As wide as its radius says, but never a speck from afar nor a fog close up.
    float px = clamp(uHaloR * uPx / depth, 6.0 * uDpr, 48.0 * uDpr);
    // Brought forward by its radius, so the threads and crystals beside it
    // never cut it in half; depth-tested still, so a gem in front hides it.
    float k = max(0.5, 1.0 - px / uPx);
    mv.xyz *= k;
    mv.xy += position.xy * px * (depth * k) / uPx;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy;
    vColour = uWhy[int(clamp(st.z, 0.0, 3.0) + 0.5)] * uHaloGain * grow * breath * depthOf(depth) * near;
  }
`;

export const HALO_FS = /* glsl */ `
  ${COMMON}
  ${OUT}
  varying vec2 vUv;
  varying vec3 vColour;
  void main() {
    float d2 = dot(vUv, vUv);
    if (d2 >= 1.0) discard;
    finishAdded(vColour * exp(-d2 * 4.0) * (1.0 - d2));
  }
`;

export const RING_VS = /* glsl */ `
  ${COMMON}
  ${STATE}
  ${FADE}
  attribute vec3 aPos;
  attribute float aNode;
  uniform float uRingGain;
  varying vec2 vUv;
  varying vec2 vRing;
  varying vec3 vColour;

  void main() {
    vec4 st = nodeTexel(aNode);
    float age = since(st.y);
    if (happened(st.y) < 0.5 || uStill > 0.5 || age > 0.9) COLLAPSE
    vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
    float near = nearOf(length(mv.xyz));
    if (near <= 0.0) COLLAPSE
    float t = age / 0.9;
    float eased = 1.0 - pow(1.0 - t, 3.0);
    float radius = mix(0.2, 1.8, eased) * uUnit;
    float width = (0.05 + 0.05 * t) * uUnit;
    // A shock wave round the note, facing the camera: in a volume there is no
    // surface to run over, and a ring seen edge-on would be a line.
    float extent = radius + width;
    float depth = max(-mv.z, 1e-3);
    mv.xy += position.xy * extent;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy * extent;
    vRing = vec2(radius, width);
    vColour = uWhy[int(clamp(st.z, 0.0, 3.0) + 0.5)] * uRingGain * (1.0 - t) * (1.0 - t) * near * depthOf(depth);
  }
`;

export const RING_FS = /* glsl */ `
  ${COMMON}
  ${OUT}
  varying vec2 vUv;
  varying vec2 vRing;
  varying vec3 vColour;
  void main() {
    float d = abs(length(vUv) - vRing.x);
    if (d >= vRing.y) discard;
    finishAdded(vColour * (1.0 - smoothstep(0.0, vRing.y, d)));
  }
`;
