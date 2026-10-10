// The dormant network's knobs: plain values, read every frame, so the lab can
// turn them live and its "export settings" can copy them as they are. Pure.
//
// Distances are in creature units (the Sentinel's scale, ten world units in
// the cluster), so a tuned value holds for any vault. Three knobs change the
// layout — spacing, neck width and bow — and take effect on the next build;
// every other one is a uniform or a matrix, and changes nothing but numbers
// on the GPU.

import { NECK_WIDTH, VOLUME_BOW, VOLUME_SPACING } from '../volume/layout';

export interface DormantKnobs {
  /** Creature units between neighbouring sites. Changes the layout: the space builds again. */
  spacing: number;
  /** The least a neck is across, spacings. Changes the layout. */
  neck: number;
  /** How far a thread bows off its chord, a share of its length. Changes the layout. */
  bow: number;
  /** The cage's brightness; 0 hides it. */
  cage: number;
  /** Every crystal's footprint, as a share of its kind's. */
  crystalSize: number;
  /** How much light the dark glass gives back: its key light and its rim. */
  glass: number;
  /** How far the eye reveals, creature units. */
  eyeReach: number;
  /** How brightly it reveals, at the eye's resting intensity. */
  eyeGain: number;
  /** The light a note keeps once the walk has passed it. */
  ember: number;
  /** A found note's halo, radius in creature units. */
  halo: number;
  /** A dormant thread's width, creature units; it never draws under a pixel. */
  filamentWidth: number;
  /** A dormant thread's brightness, as a share of the brain's own lines. */
  filamentGlow: number;
  /** A walked thread's radius, creature units. */
  tubeWidth: number;
  /** The light a walked thread keeps. */
  tubeGlow: number;
  /** How fast pulses run along the trail, creature units a second. */
  pulseSpeed: number;
  /**
   * Creature units from the camera: whole beyond it, gone within half of it,
   * so nothing blocks the view from inside the cluster — but never so far
   * that what the camera looks at fades. 0: off.
   */
  nearFade: number;
  /**
   * How much what lies beyond the focus, or far to the side of it, dims, 0–1:
   * 1 is the brain's depth fade (down to 0.2) with the full fall-off round
   * the focus; 0 turns both off.
   */
  depthCue: number;
}

export function defaultKnobs(): DormantKnobs {
  return {
    spacing: VOLUME_SPACING,
    neck: NECK_WIDTH,
    bow: VOLUME_BOW,
    cage: 1,
    crystalSize: 1,
    glass: 1,
    eyeReach: 5,
    eyeGain: 1,
    ember: 0.12,
    halo: 0.9,
    filamentWidth: 0.012,
    filamentGlow: 1,
    tubeWidth: 0.028,
    tubeGlow: 0.55,
    pulseSpeed: 3,
    nearFade: 2,
    depthCue: 1,
  };
}
