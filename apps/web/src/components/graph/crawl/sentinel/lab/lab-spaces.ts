// The spaces the Sentinel lab offers beside the brain stand-in, in the order
// its picker lists them: spaces of Crawl's own, built far enough to judge with
// the creature walking inside before the Crawl view shows one.
//
// The lab drives a space through the CrawlSpace contract and two things more
// the contract leaves out: the environment map it lends the Sentinel, so the
// metal reflects the space it walks in, and the plain object its knobs live
// on, which the lab's "export settings" copies. Neither belongs in the
// contract yet: the Crawl view takes whatever the chosen space settles on.

import type * as THREE from 'three';

import type { CrawlSpace } from '../../space/space';

/** A space as the lab drives it: the contract, and the light it lends the Sentinel. */
export interface LabSpace extends CrawlSpace {
  /**
   * Its own light as a 256 PMREM, for `SentinelView.setEnvironment`, or null
   * when it lends none. Whoever lends it takes it back before the space is
   * disposed.
   */
  readonly environment: THREE.Texture | null;
}

export interface LabSpaceEntry {
  readonly name: string;
  /** A new space, not built yet, and the object its knobs live on (plain values, read every frame). */
  create(): { space: LabSpace; knobs: object };
}

export const LAB_SPACES: readonly LabSpaceEntry[] = [];
