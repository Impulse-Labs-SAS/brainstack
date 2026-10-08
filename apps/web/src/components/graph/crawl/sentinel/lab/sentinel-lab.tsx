'use client';

// The Sentinel lab: the creature over a stand-in for the graph, or alone on
// black, with every knob that shapes its look, motion and cost on a panel.
// It is where the look is approved before the Sentinel goes into Crawl, and
// where the values that ship are chosen ("export settings" copies them).
//
// Only the dev route /dev/sentinel renders it (a page.dev.tsx, which exists
// under `next dev` alone), so nothing here reaches a build. The work is in
// LabHost; this component gives it a box, and builds the panel with lil-gui,
// which ships with three and is imported here only, inside the effect.

import { useEffect, useRef, useState } from 'react';
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { TENTACLES } from '../anatomy';
import { PART_NAMES, type SentinelLook } from '../look';

import {
  BACKDROP_ORDERS,
  ENVIRONMENTS,
  LabHost,
  PRESETS,
  TIER_CHOICES,
  type EnvironmentPreset,
  type Preset,
  type TierChoice,
} from './lab-host';

const TONE_MAPPERS: readonly SentinelLook['toneMapping'][] = ['agx', 'neutral', 'aces'];

export function SentinelLab() {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = box.current;
    if (!container) return;
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
      host.dispose();
    };
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      {/* LabHost puts its own canvases in here: React renders nothing else into it. */}
      <div ref={box} className="absolute inset-0" />
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
  const p = host.motion.params;

  const walk = gui.addFolder('Walk');
  walk.add(c, 'playing').name('play');
  walk.add(c, 'speed', 0.25, 3, 0.05);
  walk.add({ replay: () => host.replayAgain() }, 'replay');
  walk.add(c, 'preset', PRESETS).onChange((v: Preset) => host.setPreset(v));
  walk
    .add(c, 'following')
    .name('follow')
    .listen()
    .onChange((v: boolean) => host.setFollowing(v));
  walk.add(p, 'followDistance', 4, 30, 0.5).name('follow distance');
  walk
    .add(c, 'reducedMotion')
    .name('reduced motion')
    .onChange((v: boolean) => host.setReducedMotion(v));
  walk.add(c, 'drift').name('layout drift');

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
  debug.add(c, 'backdrop');
  debug.add(c, 'backdropOrder', BACKDROP_ORDERS).name('backdrop order');
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
  show('programs', 'programs');
  show('memory', 'memory');
  show('renderer', 'renderer');
  show('status', 'status');
  show('rebuild', 'rebuild');
  s.add({ 'rebuild ×20': () => void host.rebuild(20) }, 'rebuild ×20');
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
