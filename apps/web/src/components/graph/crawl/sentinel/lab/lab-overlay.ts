// What the lab draws in 2D over the Sentinel besides the crawl itself, which
// crawl-draw.ts draws as the Sentinel view does — above the creature, so the
// composition is judged with the walk on top. When asked, the motion's
// insides: every joint, each tentacle's target and the six grip slots; and at
// the prompt the frame the Sentinel clings to: the rails its claws hold, the
// perch's node the grip planner plans from, and where the body floats. Last,
// a few lines of text on what the lab is doing.

import type { Project } from '../../crawl-draw';
import type { PerchShot } from '../../prompt/perch-geometry';
import type { ReplayView } from '../../replay-view';
import type { Vec3 } from '../../vec';
import { GRIP_SLOTS, TENTACLES, TENTACLE_SPECS } from '../anatomy';
import type { SentinelPose } from '../pose';

/** What the motion exposes for debugging, in creature space like the pose. */
export interface MotionDebug {
  joints: Float32Array;
  jointCount: number;
  targets: Float32Array;
}

const ROLE_COLOR = { gripper: '#5eead4', crown: '#9aa3a6', explorer: '#fbbf24' } as const;

/**
 * Joints as dots, each tentacle's target as a cross in its role's colour, and
 * per grip slot its natural spot (a ring, numbered) tied to what it holds.
 */
export function drawDebug(
  ctx: CanvasRenderingContext2D,
  P: Project,
  pose: SentinelPose,
  debug: MotionDebug,
  view: ReplayView,
  font: string,
): void {
  const [ax, ay, az] = pose.anchor;
  const u = pose.unit;
  const world = (x: number, y: number, z: number): Vec3 => [ax + x * u, ay + y * u, az + z * u];

  ctx.fillStyle = 'rgba(235,240,245,0.7)';
  for (let q = 0; q < debug.jointCount * 3; q += 3) {
    const p = P(world(debug.joints[q]!, debug.joints[q + 1]!, debug.joints[q + 2]!));
    if (!p) continue;
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  }

  ctx.lineWidth = 1.2;
  for (let i = 0; i < TENTACLES; i++) {
    const k = i * 3;
    const p = P(world(debug.targets[k]!, debug.targets[k + 1]!, debug.targets[k + 2]!));
    if (!p) continue;
    ctx.strokeStyle = ROLE_COLOR[TENTACLE_SPECS[i]!.role];
    ctx.beginPath();
    ctx.moveTo(p.x - 4, p.y - 4);
    ctx.lineTo(p.x + 4, p.y + 4);
    ctx.moveTo(p.x + 4, p.y - 4);
    ctx.lineTo(p.x - 4, p.y + 4);
    ctx.stroke();
  }

  // The hull's matrix carries the body frame (x right, y up, z forward) and its centre.
  const h = pose.hull;
  const held: Vec3 = [0, 0, 0];
  ctx.font = `500 10px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  GRIP_SLOTS.forEach((slot, s) => {
    const [x, y, z] = slot.natural;
    const natural = P(
      world(
        h[12]! + h[0]! * x + h[4]! * y + h[8]! * z,
        h[13]! + h[1]! * x + h[5]! * y + h[9]! * z,
        h[14]! + h[2]! * x + h[6]! * y + h[10]! * z,
      ),
    );
    if (!natural) return;
    const hold = view.holds[s];
    const color = slot.side < 0 ? '#f472b6' : '#60a5fa';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (hold && view.field.point(hold.key, hold.u, held)) {
      const p = P(held);
      if (p) {
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(natural.x, natural.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.beginPath();
    ctx.arc(natural.x, natural.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(String(s), natural.x, natural.y + 0.5);
  });
}

const PERCH_COLOUR = '#fbbf24';

/**
 * The frame round the prompt as the grip planner sees it: each rail dashed,
 * corner to corner, the corner nodes as dots, the perch's node as a cross and
 * the body as a ring where it floats. At `alpha`, the prompt's level.
 */
export function drawPerch(
  ctx: CanvasRenderingContext2D,
  P: Project,
  shot: PerchShot,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = PERCH_COLOUR;
  ctx.fillStyle = PERCH_COLOUR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const rail of shot.rails) {
    ctx.beginPath();
    let started = false;
    for (const point of rail) {
      const p = P(point);
      if (!p) {
        started = false;
        continue;
      }
      if (started) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
      started = true;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const corner of shot.corners) {
    const p = P(corner);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const node = P(shot.perch.node);
  if (node) {
    ctx.beginPath();
    ctx.moveTo(node.x - 5, node.y);
    ctx.lineTo(node.x + 5, node.y);
    ctx.moveTo(node.x, node.y - 5);
    ctx.lineTo(node.x, node.y + 5);
    ctx.stroke();
  }
  const body = P(shot.perch.body);
  if (body) {
    ctx.beginPath();
    ctx.arc(body.x, body.y, Math.max(3, 0.3 * shot.unit * body.scale), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** A few lines of text at the bottom left: what the lab is doing, and what is wrong. */
export function drawNotes(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  height: number,
  font: string,
): void {
  ctx.font = `500 11px ${font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(200,205,210,0.75)';
  lines.forEach((line, i) => ctx.fillText(line, 14, height - 14 - (lines.length - 1 - i) * 16));
}
