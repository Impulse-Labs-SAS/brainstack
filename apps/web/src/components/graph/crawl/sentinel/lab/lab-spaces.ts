// The spaces the Sentinel lab offers beside the brain stand-in, in the order
// its picker lists them — spaces of Crawl's own, built far enough to judge with
// the creature walking inside before the Sentinel view shows one — and the few
// pure pieces the lab needs to drive them.
//
// The lab drives a space through the CrawlSpace contract and a few things more
// the contract leaves out: the environment map it lends the Sentinel, so the
// metal reflects the space it walks in; the plain object its knobs live on,
// which the lab's "export settings" copies; a way to ask the lab to build it
// again when a knob changes the layout; and a line or two for the Stats
// folder. None of them belongs in the contract yet: the Sentinel view takes
// whatever the chosen space settles on.
//
// The rest is what the lab hands a space beside the eye (stage/eye.ts, which
// the Sentinel view shares), kept here and pure so the host stays about
// wiring: which notes record a decision. Crawl will take them from the data (a
// decision tag, the crawl's own flag), never from a title; the lab's vaults
// have no tags, so it stands in with what they do have — the large vault's
// Decisions folders, and every note a crawl flags.

import type * as THREE from 'three';

import { planCrawl } from '../../crawl-plan';
import type { SampleVault } from '../../sample-vault';
import {
  DORMANT_NETWORK,
  DormantNetwork,
  type DormantStats,
} from '../../space/dormant/dormant-network';
import type { CrawlSpace } from '../../space/space';

/** A space as the lab drives it: the contract, and the light it lends the Sentinel. */
export interface LabSpace extends CrawlSpace {
  /**
   * Its own light as a 256 PMREM, for `SentinelView.setEnvironment`, or null
   * when it lends none. Whoever lends it takes it back before the space is
   * disposed.
   */
  readonly environment: THREE.Texture | null;
  /**
   * Set by the lab: called when a knob that changes the layout settles, so
   * the lab builds the space again over the same notes and starts the crawl
   * over on it. A space whose knobs are all live never calls it.
   */
  onRebuild?: (() => void) | null;
}

/** What the Stats folder shows of a space, beyond the draws and times every space reports. */
export interface LabSpaceReport {
  /** Its shape in a line: for the dormant network, its form, sites, radius, regions and cost. */
  shape: string;
  /**
   * State uploads so far, which the lab turns into a rate: it must fall to 0
   * once nothing new happens. Null for a space that uploads nothing per frame.
   */
  uploads: number | null;
}

/** A space just made, not built yet. */
export interface LabSpaceMade {
  space: LabSpace;
  /** The object its knobs live on (plain values, read every frame). */
  knobs: object;
  /** Its report for the Stats folder; null before a build. */
  report?: () => LabSpaceReport | null;
}

export interface LabSpaceEntry {
  readonly name: string;
  create(): LabSpaceMade;
}

export const LAB_SPACES: readonly LabSpaceEntry[] = [
  {
    name: DORMANT_NETWORK,
    create: () => {
      const space = new DormantNetwork();
      return { space, knobs: space.knobs, report: () => dormantReport(space.stats) };
    },
  },
];

/** The space the lab opens on: the one Crawl is meant to walk. */
export const DEFAULT_SPACE: string = DORMANT_NETWORK;

function dormantReport(s: DormantStats | null): LabSpaceReport | null {
  if (!s) return null;
  const form = `${s.lobes} ${s.lobes === 1 ? 'lobe' : 'lobes'}${s.satellite ? ' + satellite' : ''}`;
  const notes = `${s.notes.toLocaleString('en-US')} notes on ${s.sites.toLocaleString('en-US')} sites`;
  const radius = `R ${s.radius.toFixed(0)} (${(s.radius / s.unit).toFixed(1)}u)`;
  const split = s.pieces === 0 ? 'no region split' : `${s.pieces} region pieces apart`;
  const lost = s.unplaced === 0 ? '' : ` · ${s.unplaced.toLocaleString('en-US')} notes unplaced`;
  const cost = `layout ${s.layoutMs.toFixed(0)} / build ${s.buildMs.toFixed(0)} ms`;
  return {
    shape: `${form} · ${notes} · ${radius} · ${split}${lost} · ${cost}`,
    uploads: s.uploads,
  };
}

// -- Decisions -------------------------------------------------------------------

/** The folder the large vault files decisions in: the lab's stand-in for a decision tag. */
const DECISIONS_FOLDER = 'Decisions';

/**
 * The notes of a lab vault that record a decision, by id: every note filed
 * under a Decisions folder, and every note any of its crawls hands over as a
 * decision — resolved exactly as the replay resolves it (planCrawl), so a note
 * found as a decision always stands as one. Deterministic, as the vaults are.
 */
export function labDecisions(vault: SampleVault): Set<string> {
  const ids = new Set<string>();
  for (const n of vault.model.nodes) {
    if (n.kind === 'note' && n.path.split('/').slice(0, -1).includes(DECISIONS_FOLDER)) {
      ids.add(n.id);
    }
  }
  for (const crawl of Object.values(vault.crawls)) {
    for (const step of planCrawl(crawl, vault.model).steps) {
      if (step.kind !== 'visit') continue;
      for (const r of step.reach) if (r.kind === 'decision') ids.add(r.node.id);
    }
  }
  return ids;
}
