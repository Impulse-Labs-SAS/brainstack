// Which pass the Sentinel view's stage draws first, before the creature, from
// where the prompt scene is and whether the space's shaders are compiled.
// Pure, so the choice is tested apart from the WebGL that follows it.
//
//  - 'bare': a clear, colour and depth, and the creature and the frame in the
//    frame's planes. At rest at the prompt the cluster is not drawn at all —
//    nothing of it shows there — and while the frame shows over a space that
//    cannot draw yet, the creature still clings or crosses in front of it.
//  - 'space': the dormant network, which clears and writes the depth the
//    creature draws into (under a veil while the cluster is below full).
//  - 'clear': nothing to draw it in yet — a space still compiling, the frame
//    gone — so a clear, and the creature on its own.

import type { PromptFrame } from '../prompt/prompt-scene';

export type StagePass = 'bare' | 'space' | 'clear';

/** The first pass for a frame where the scene is `scene` (null: none to show) and the space is `spaceWarm`. */
export function stagePass(
  scene: Pick<PromptFrame, 'atRest' | 'levels'> | null,
  spaceWarm: boolean,
): StagePass {
  if (scene && (scene.atRest || (!spaceWarm && scene.levels.prompt > 0))) return 'bare';
  return spaceWarm ? 'space' : 'clear';
}
