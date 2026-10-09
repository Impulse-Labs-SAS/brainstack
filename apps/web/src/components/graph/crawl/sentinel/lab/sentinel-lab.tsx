'use client';

// The Sentinel lab: the creature walking the dormant network — the cluster of
// notes Crawl is meant to show, dark until the walk wakes it — or over a
// stand-in for the graph, or alone on black, with every knob that shapes its
// look, motion and cost on a panel, the space's own among them. It is where
// the look is approved before the Sentinel goes into Crawl, where the space
// it will walk is judged, and where the values that ship are chosen ("export
// settings" copies them).
//
// Over a space it opens on the prompt scene, as Crawl will: the input at the
// centre (CrawlPrompt, the component Crawl will use), the Sentinel clinging to
// the frame round it, the lab's crawls as recents under it; a send or a recent
// runs the transition into the crawl, and the placeholder side panel's "New
// search" runs it back. The Prompt folder tunes the frame, the pose, the glass
// and the timing.
//
// Only the dev route /dev/sentinel renders it (a page.dev.tsx, which exists
// under `next dev` alone), so nothing here reaches a build. The work is in
// LabHost; this component gives it a box, the prompt and the panel, and builds
// the knobs with lil-gui, which ships with three and is imported here only,
// inside the effect. The host tells it what the prompt and the panel show; the
// levels they fade and slide by it writes on the root as CSS variables, every
// frame, without React.

import { useEffect, useRef, useState } from 'react';
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import type { CrawlSnapshot } from '../../crawl-layer';
import { CrawlPrompt } from '../../prompt/crawl-prompt';
import { GAP_MIN } from '../../prompt/perch-geometry';
import { GAZES } from '../../prompt/prompt-scene';
import type { DirectionTimes } from '../../prompt/transition';
import { TENTACLES } from '../anatomy';
import { PART_NAMES, type SentinelLook } from '../look';

import {
  BACKDROP_ORDERS,
  ENVIRONMENTS,
  LabHost,
  PRESETS,
  SPACES,
  TIER_CHOICES,
  VAULTS,
  type EnvironmentPreset,
  type LabPromptUi,
  type Preset,
  type SpaceChoice,
  type TierChoice,
  type VaultChoice,
} from './lab-host';
import { LabPanel } from './lab-panel';
import { LAB_ASKED } from './lab-prompt';

const TONE_MAPPERS: readonly SentinelLook['toneMapping'][] = ['agx', 'neutral', 'aces'];

export function SentinelLab() {
  /** The page's root: the host writes the prompt's and the panel's levels on it. */
  const chrome = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  /** The prompt's box, which the frame is fitted to. */
  const promptBox = useRef<HTMLDivElement>(null);
  const hostRef = useRef<LabHost | null>(null);
  const [ui, setUi] = useState<LabPromptUi | null>(null);
  const [snap, setSnap] = useState<CrawlSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = box.current;
    const root = chrome.current;
    const prompt = promptBox.current;
    if (!container || !root || !prompt) return;
    let host: LabHost;
    try {
      host = new LabHost(container);
    } catch (e) {
      // No WebGL, most likely: three throws when the canvas gives it no context.
      // The host has freed whatever context it had; its canvases go with it.
      container.replaceChildren();
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    hostRef.current = host;
    host.onSnapshot = setSnap;
    host.attachPrompt({ box: prompt, chrome: root }, setUi);
    let gui: GUI | null = null;
    let gone = false;
    import('three/addons/libs/lil-gui.module.min.js')
      .then(({ default: Gui }) => {
        if (!gone) gui = buildPanel(Gui, host);
      })
      .catch((e: unknown) => console.error('Sentinel lab: the panel failed to load.', e));
    return () => {
      gone = true;
      gui?.destroy();
      hostRef.current = null;
      host.dispose();
      setUi(null);
    };
  }, []);

  return (
    <div ref={chrome} className="fixed inset-0 overflow-hidden bg-black">
      {/* LabHost puts its own canvases in here: React renders nothing else into it. */}
      <div ref={box} className="absolute inset-0" />
      <CrawlPrompt
        boxRef={promptBox}
        recents={ui?.recents ?? []}
        shown={!!ui?.available}
        interactive={!!ui?.interactive}
        focusKey={ui?.focus ?? 0}
        onSubmit={(text) => hostRef.current?.submit(text)}
        onRecent={(id) => hostRef.current?.playRecent(id)}
      />
      <LabPanel
        shown={ui?.scene === 'crawl'}
        asked={ui?.asked ?? ''}
        snapshot={snap}
        canGoBack={!!ui?.available}
        onNewSearch={() => hostRef.current?.newSearch()}
      />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[12px] text-red-400">
          The lab could not start: {error}
        </div>
      )}
    </div>
  );
}

function buildPanel(Gui: typeof GUI, host: LabHost): GUI {
  const gui = new Gui({ title: 'Sentinel lab', width: 300 });
  const { controls: c, stats, look, grip } = host;
  // The panel's params: the motion reads a copy with the prompt's idle life blended in.
  const p = host.params;

  // Listened to: a switch ×10, or a space that fails to build, changes them from inside.
  gui
    .add(c, 'space', SPACES)
    .listen()
    .onChange((v: SpaceChoice) => host.setSpace(v));
  gui
    .add(c, 'vault', VAULTS)
    .listen()
    .onChange((v: VaultChoice) => host.setVault(v));

  // The stage's own knobs, refilled whenever it changes; the folder keeps its place.
  const space = gui.addFolder('Space');
  const fillSpace = () => {
    for (const controller of [...space.controllers]) controller.destroy();
    for (const folder of [...space.folders]) folder.destroy();
    space.title(`Space · ${c.space}`);
    const labSpace = host.space;
    if (!labSpace) {
      space.add(c, 'backdrop');
      space.add(c, 'backdropOrder', BACKDROP_ORDERS).name('backdrop order');
      return;
    }
    labSpace.gui?.(space);
    if (labSpace.environment) space.add(c, 'lendEnvironment').name('Sentinel reflects it');
    space.add(c, 'spaceHalos').name('2D found halos');
  };
  fillSpace();
  host.onStageChange = fillSpace;

  buildPrompt(gui, host);

  const walk = gui.addFolder('Walk');
  // Off, a space walks alone, woken by a stand-in eye: Crawl without the creature.
  walk.add(c, 'sentinel').name('Sentinel');
  walk.add(c, 'playing').name('play');
  walk.add(c, 'speed', 0.25, 3, 0.05);
  walk.add({ replay: () => host.replayAgain() }, 'replay');
  // Listened to: a recent touched at the prompt picks its crawl from inside.
  walk
    .add(c, 'preset', PRESETS)
    .listen()
    .onChange((v: Preset) => host.setPreset(v));
  walk
    .add(c, 'following')
    .name('follow')
    .listen()
    .onChange((v: boolean) => host.setFollowing(v));
  // Each space suggests its own; listened to, so a change of space shows here.
  walk.add(p, 'followDistance', 4, 30, 0.5).name('follow distance').listen();
  walk
    .add(c, 'reducedMotion')
    .name('reduced motion')
    .onChange((v: boolean) => host.setReducedMotion(v));
  walk.add(c, 'drift').name('layout drift (brain)');

  const tentacles = gui.addFolder('Tentacles').close();
  // Fourteen at every tier, by design: tiers change detail, never the count.
  tentacles.add({ count: TENTACLES }, 'count').disable();
  tentacles.add(stats, 'segments').name('segments (tier)').listen().disable();
  tentacles.add(p, 'dragScale', 0.25, 3, 0.05).name('lag / drag');
  tentacles.add(p, 'waveAmplitude', 0, 3, 0.05).name('wave amplitude');
  tentacles.add(p, 'waveFrequency', 0, 3, 0.05).name('wave frequency');
  tentacles.add(p, 'waveLength', 0.25, 3, 0.05).name('wavelength');
  tentacles.add(c, 'twist', 0, 3, 0.05);
  tentacles.add(p, 'restStiffness', 0, 3, 0.05).name('stiffness');
  tentacles.add(p, 'coneLimitScale', 0.25, 2, 0.05).name('cones');
  tentacles.add(p, 'maxStretchScale', 0.5, 1.5, 0.01).name('telescoping');
  tentacles.add(p, 'explorerLead', 0.5, 2.5, 0.05).name('explorer lead');
  tentacles.add(p, 'recoil', 0, 3, 0.05);
  // The grip planner reads these when a leg begins: they show from the next leg.
  tentacles.add(grip, 'reach', 0.3, 1.5, 0.01).name('grip reach');
  tentacles.add(grip, 'hysteresis', 0, 1, 0.01);

  const body = gui.addFolder('Body').close();
  body.add(p, 'bodyScale', 0.8, 2, 0.05).name('body scale');
  body.add(p, 'hover', 0.2, 1, 0.01);
  body.add(p, 'breathing', 0, 0.02, 0.0005);
  body.add(p, 'bob', 0, 0.1, 0.005);
  body.add(p, 'humAmplitude', 0, 0.03, 0.001).name('hum');

  const material = gui.addFolder('Material').close();
  material.add(look, 'wear', 0, 1, 0.01);
  for (const name of PART_NAMES) {
    const part = look.parts[name];
    const folder = material.addFolder(name).close();
    folder.addColor(part, 'color');
    folder.add(part, 'roughness', 0, 1, 0.01);
    folder.add(part, 'metalness', 0, 1, 0.01);
    folder.add(part, 'clearcoat', 0, 1, 0.01);
  }

  const light = gui.addFolder('Light').close();
  light
    .add(c, 'environment', ENVIRONMENTS)
    .onChange((v: EnvironmentPreset) => host.setEnvironment(v));
  light.add(look, 'envIntensity', 0, 3, 0.01).name('env intensity');
  light.add(look, 'envYawOffset', -Math.PI, Math.PI, 0.01).name('env yaw');
  light.add(look, 'rimIntensity', 0, 6, 0.05).name('rim');
  light.addColor(look, 'rimColor').name('rim colour');
  light.add(look, 'eyeLightIntensity', 0, 20, 0.1).name('eye light');
  light.add(look, 'eyeGain', 0, 20, 0.1).name('lens glow');
  light.add(p, 'eyeBase', 0, 1, 0.01).name('eye base');
  light.add(p, 'eyePulse', 0, 0.3, 0.005).name('eye pulse');
  light.add(p, 'eyeFlare', 0, 3, 0.05).name('eye flare');
  light.add(look, 'exposure', 0.2, 3, 0.01);
  light.add(look, 'toneMapping', TONE_MAPPERS).name('tone mapper');

  const glow = gui.addFolder('Glow').close();
  glow.add(look, 'bloomStrength', 0, 3, 0.01).name('bloom strength');
  glow.add(look, 'bloomRadius', 0, 0.3, 0.005).name('bloom radius');
  glow.add(look, 'glowGain', 0, 10, 0.05).name('glow gain');

  const quality = gui.addFolder('Quality');
  quality.add(c, 'tier', TIER_CHOICES).onChange((v: TierChoice) => host.setTier(v));
  quality.add(stats, 'tier').name('drawn at').listen().disable();
  quality.add(stats, 'governor').listen().disable();
  quality.add({ 'print log': () => host.printGovernorLog() }, 'print log');
  quality.add(c, 'slowCpuMs', 0, 20, 0.5).name('slow CPU (ms)');

  const debug = gui.addFolder('Debug').close();
  debug.add(c, 'overlay').name('crawl overlay');
  debug.add(c, 'debug').name('joints · targets · slots');

  const s = gui.addFolder('Stats');
  const show = (key: keyof typeof stats, name: string) =>
    s.add(stats, key).name(name).listen().disable();
  show('fps', 'fps');
  show('dt', 'dt p50 / p95');
  show('cpu', 'CPU p50');
  show('sim', 'motion p50');
  show('gpu', 'GPU p50');
  show('draws', 'draw calls');
  show('triangles', 'triangles');
  // The stage apart from the Sentinel: the governor never sees it, as in Crawl.
  show('space', 'space');
  show('spaceCost', 'space draws');
  show('spaceTime', 'space CPU · GPU p50');
  show('shape', 'space shape');
  // 0 at rest is the promise: nothing new happened, nothing goes up.
  show('uploads', 'state uploads');
  s.add(c, 'splitGpu').name('split GPU time (sync)');
  show('programs', 'programs');
  show('memory', 'memory');
  show('renderer', 'renderer');
  show('status', 'status');
  show('rebuild', 'rebuild');
  s.add({ 'rebuild ×20': () => void host.rebuild(20) }, 'rebuild ×20');
  show('cycle', 'switch space');
  s.add({ 'switch space ×10': () => void host.cycleSpaces(10) }, 'switch space ×10');
  show('vaultCycle', 'switch vault');
  s.add({ 'switch vault ×10': () => void host.cycleVaults(10) }, 'switch vault ×10');
  show('promptCycle', 'prompt ↔ crawl');
  s.add({ 'prompt ↔ crawl ×20': () => void host.cyclePrompt(20) }, 'prompt ↔ crawl ×20');
  const exported = { exported: '—' };
  s.add(
    {
      'export settings': () => {
        const json = host.exportSettings();
        // Outside a secure context there is no clipboard at all.
        const copied = navigator.clipboard
          ? navigator.clipboard.writeText(json)
          : Promise.reject(new Error('No clipboard'));
        copied.then(
          () => (exported.exported = 'copied to the clipboard'),
          () => {
            console.info(json);
            exported.exported = 'clipboard blocked: printed to the console';
          },
        );
      },
    },
    'export settings',
  );
  s.add(exported, 'exported').listen().disable();
  return gui;
}

/**
 * The Prompt folder: the frame and the creature on it, the glass, the idle
 * life, the bezel's look and every span of the transition. Generous ranges:
 * the look is judged at the gate, and most defaults are guesses until then.
 */
function buildPrompt(gui: GUI, host: LabHost): void {
  const k = host.scene.knobs;
  const folder = gui.addFolder('Prompt');
  folder.add(host.stats, 'prompt').name('frame').listen().disable();
  folder.add({ 'back to the prompt': () => host.newSearch() }, 'back to the prompt');
  folder.add(
    { 'send (plays the preset)': () => host.submit(LAB_ASKED[host.controls.preset]) },
    'send (plays the preset)',
  );
  // Each moves the frame or the creature on it: the scene is laid out again and the claws take hold anew.
  const relayout = () => host.promptChanged();
  folder.add(k, 'size', 0.25, 1, 0.01).name('box height (u)').onChange(relayout);
  folder.add(k, 'margin', 0.05, 0.5, 0.005).name('rails beyond the box (u)').onChange(relayout);
  folder.add(k, 'band', 0.03, 0.3, 0.005).name('bezel band (u)').onChange(relayout);
  folder.add(k, 'thickness', 0.02, 0.3, 0.005).name('bezel depth (u)').onChange(relayout);
  folder.add(k, 'railForward', -1, 1, 0.05).name('claws on the face').onChange(relayout);
  folder.add(k, 'tilt', 0, 90, 1).name('lean over the top (°)').onChange(relayout);
  folder.add(k, 'bodyX', -1.5, 1.5, 0.01).name('body right (u)').onChange(relayout);
  folder.add(k, 'bodyY', -1, 1, 0.01).name('body up (u)').onChange(relayout);
  folder.add(k, 'bodyBehind', 0, 1.5, 0.01).name('behind the box (u)').onChange(relayout);
  folder.add(k, 'frameReach', 0.5, 1.5, 0.01).name('grip reach on the frame').onChange(relayout);
  folder.add(k, 'gap', GAP_MIN, 40, 0.5).name('gap to the cluster (u)').onChange(relayout);
  folder.add(k, 'release', 0, 1.5, 0.05).name('letting go (s)');
  folder.add(k, 'gaze', GAZES).name('eye on');

  const glass = folder.addFolder('Glass');
  const glassChanged = () => host.glassChanged();
  glass.add(host.glass, 'alpha', 0, 1, 0.01).name('box alpha').onChange(glassChanged);
  glass.add(host.glass, 'blur', 0, 32, 0.5).name('box blur (px)').onChange(glassChanged);

  const idle = folder.addFolder('Idle').close();
  idle.add(k.idle, 'breathing', 0, 0.02, 0.0005);
  idle.add(k.idle, 'humAmplitude', 0, 0.03, 0.001).name('hum');
  idle.add(k.idle, 'bob', 0, 0.1, 0.005);

  const bezel = folder.addFolder('Bezel').close();
  const look = host.bezel.look;
  bezel.addColor(look, 'colour').name('glass');
  bezel.addColor(look, 'rimColour').name('rim colour');
  bezel.add(look, 'rim', 0, 2, 0.01);
  bezel.add(look, 'sheen', 0, 2, 0.01);
  bezel.add(look, 'glint', 0, 5, 0.05).name('eye glint');
  bezel.add(look, 'eyeReach', 0.5, 10, 0.1).name('eye reach (u)');

  // Read when a transition starts: a change shows from the next one.
  const timing = folder.addFolder('Timing').close();
  const direction = (name: string, t: DirectionTimes, order: readonly SpanName[]) => {
    const f = timing.addFolder(name);
    for (const channel of order) {
      f.add(t[channel], 'start', 0, 3, 0.05).name(`${channel} start (s)`);
      f.add(t[channel], 'duration', 0, 4, 0.05).name(`${channel} (s)`);
    }
    f.add(t.crossing, 'speed', 4, 40, 0.5).name('crossing (u/s)');
    f.add(t.crossing, 'min', 0.2, 6, 0.1).name('crossing at least (s)');
    f.add(t.crossing, 'max', 0.5, 8, 0.1).name('crossing at most (s)');
  };
  direction('to the crawl', k.times.enter, ['prompt', 'panel', 'cluster', 'camera']);
  direction('back', k.times.leave, ['panel', 'cluster', 'camera', 'prompt']);
  timing.add(k.times, 'handoff', 0, 2, 0.05).name('camera hand-off (s)');
}

/** The channels of a transition that run on a span of their own. */
type SpanName = Exclude<keyof DirectionTimes, 'crossing'>;
