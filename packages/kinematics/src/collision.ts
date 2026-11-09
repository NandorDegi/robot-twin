import { forwardKinematics } from "./fk";
import { mat4TranslationOf, mat4TransformPoint, vec3Subtract, vec3Add, vec3Scale, vec3Dot, vec3Length, vec3Normalize } from "./math3d";
import type { KinematicChain, JointState, Vec3, GripperConfig } from "./types";

/**
 * A capsule that approximates one arm link: the rigid segment between two
 * consecutive joint origins (or the base/pedestal, or the tool tip), plus a
 * radius that models its thickness. Non-adjacent capsules must not overlap.
 */
export interface ArmSegment {
  a: Vec3;
  b: Vec3;
  radius: number;
  /** Index of the link in the chain (0 = base-to-first-joint, n = tool). */
  index: number;
}

/** Options that tune the collision and floor check. */
export interface SafetyOptions {
  /**
   * Radius (mm) per capsule. Length must be `joints.length + 1`:
   * one for each arm link plus one for the tool/tip. Arm links default to 38mm
   * (matches the twin's procedural link meshes); the tool segment to 24mm.
   */
  linkRadii?: number[];
  /** Extra clearance added to every radius (mm). Default 0. */
  clearance?: number;
  /** The arm may not go below this plane. Default 0. */
  groundFloor?: number;
  /** Index of the vertical axis (0=x, 1=y, 2=z). Default 1. */
  groundUpAxis?: number;
  /** End-effector reference point in the tool frame (the gripper tip). */
  eeOffset?: Vec3;
  /**
   * Radius (mm) of the base mount, treated as a static obstacle so the moving
   * links cannot sweep through it. Omit to disable the base check. Default: off.
   */
  baseRadius?: number;
  /**
   * Length (mm) of the base obstacle removed at the shoulder end. The arm
   * attaches at the shoulder, so that region is not a collision. Default 60.
   */
  baseObstacleSkip?: number;
  /**
   * Model of the gripper (palm plus two fingers) as extra capsules. The
   * fingers are wider and longer than the tool capsule alone, so without this
   * model the hand can pass through the forearm or links. Omit to use the
   * Panda hand defaults.
   */
  gripper?: GripperConfig;
}

/**
 * Geometry of the gripper hand capsules, in the tool frame. The tool frame
 * has +Z as the approach axis and +X as the opening axis (matches the twin's
 * procedurally built Panda hand). Defaults model the Panda hand.
 */

const DEFAULT_GRIPPER: Required<GripperConfig> = {
  // Franka Hand, in the flange (panda_link8) frame, mm. The hand body ends at
  // about 58 mm, the finger pads at about 103 mm (the official TCP, 0.1034 m)
  // and the finger tips at about 113 mm. The capsules add some margin.
  fingerHalf: 20,
  fingerRadius: 12,
  fingerStart: 58,
  fingerEnd: 106,
  palmRadius: 30,
  palmEnd: 58,
};

/**
 * The gripper model for the Panda hand. Pass this as `gripper` when you
 * construct a solver for the Panda chain.
 */
export const defaultPandaGripper: Required<GripperConfig> = DEFAULT_GRIPPER;

export function defaultLinkRadii(n: number): number[] {
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(38);
  radii.push(24);
  return radii;
}

/**
 * Build the arm segments (capsules) for a configuration, in the world frame.
 * Adjacent segments share a joint so they are always in contact; the check
 * only treats non-adjacent pairs as potential collisions.
 */
export function armSegments(
  chain: KinematicChain,
  q: JointState,
  options: SafetyOptions = {},
): ArmSegment[] {
  const n = chain.joints.length;
  const fk = forwardKinematics(chain, q);
  const radii = options.linkRadii ?? defaultLinkRadii(n);

  // Raw nodes: one per joint, plus the base and the end-effector. Some robots
  // have co-located joints (zero-length links), e.g. the Panda's shoulder and
  // wrist. Two links that meet at a co-located pivot do not really collide, so
  // we collapse coincident nodes into a single pivot before building capsules.
  const pts: Vec3[] = [mat4TranslationOf(chain.base)];
  for (let i = 0; i < n; i++) pts.push(fk.jointOrigins[i]!);
  const eeOffset = options.eeOffset;
  const ee =
    eeOffset && (eeOffset[0] || eeOffset[1] || eeOffset[2])
      ? mat4TransformPoint(fk.pose, eeOffset)
      : mat4TranslationOf(fk.pose);
  pts.push(ee);

  // First occurrence index of each distinct pivot in `pts`.
  const pivots: number[] = [0];
  for (let k = 1; k < pts.length; k++) {
    const last = pivots[pivots.length - 1]!;
    if (vec3Length(vec3Subtract(pts[k]!, pts[last]!)) >= 1e-6) pivots.push(k);
  }

  const segments: ArmSegment[] = [];
  for (let p = 0; p < pivots.length - 1; p++) {
    const s = pivots[p]!;
    const e = pivots[p + 1]!;
    let radius = 0;
    for (let k = s; k < e; k++) radius = Math.max(radius, radii[k] ?? 38);
    segments.push({ a: pts[s]!, b: pts[e]!, radius, index: p });
  }

  // The gripper hand. The generic tool capsule (the last segment, from the
  // wrist to the fingertip) is thin (radius 24mm), but the real hand is a palm
  // plus two long fingers spread across the X axis. When the gripper geometry
  // is known, replace that generic capsule with a palm capsule and two finger
  // capsules, so the hand cannot pass through the forearm or other links. This
  // is opt-in so chains without a measured hand keep the old behaviour. The
  // palm carries the index of the removed tool capsule and the fingers the next
  // one, so the palm stays adjacent to the forearm (skipped) while the fingers
  // are checked against the forearm and every earlier link.
  if (options.gripper) {
    segments.pop();
    const g = { ...DEFAULT_GRIPPER, ...options.gripper };
    const toolIndex = segments.length;
    const toolPose = fk.pose;
    const tf = (x: number, y: number, z: number): Vec3 => mat4TransformPoint(toolPose, [x, y, z]);
    // Palm (wrist coupling + palm housing).
    segments.push({
      a: tf(0, 0, 0),
      b: tf(0, 0, g.palmEnd),
      radius: g.palmRadius,
      index: toolIndex,
    });
    // Two parallel fingers.
    for (const fx of [-g.fingerHalf, g.fingerHalf]) {
      segments.push({
        a: tf(fx, 0, g.fingerStart),
        b: tf(fx, 0, g.fingerEnd),
        radius: g.fingerRadius,
        index: toolIndex + 1,
      });
    }
  }
  return segments;
}

/**
 * True when the configuration is collision-free (no non-adjacent link overlaps)
 * and stays above the ground plane. Assumes the arm is a set of capsules.
 */
export function isConfigSafe(
  chain: KinematicChain,
  q: JointState,
  options: SafetyOptions = {},
): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const clearance = options.clearance ?? 0;
  const floor = options.groundFloor ?? 0;
  const up = options.groundUpAxis ?? 1;
  const segments = armSegments(chain, q, options);

  // Floor: the lowest point of a capsule (an endpoint minus its radius) may
  // not go below the plane. The base-anchored segment (index 0) is the fixed
  // mount, which sits on the floor, so it is not counted.
  for (const seg of segments) {
    if (seg.index === 0) continue;
    const low = Math.min(seg.a[up], seg.b[up]) - (seg.radius + clearance);
    if (low < floor) {
      reasons.push(`link ${seg.index} below floor (${low.toFixed(1)} < ${floor})`);
    }
  }

  // Static base obstacle: the base-to-shoulder pedestal, from the floor up to
  // just below the shoulder (the arm attaches there). Moving links must keep
  // clear of it, so the arm cannot sweep over or through the base mount.
  const baseSeg = baseMountObstacle(segments, options);
  if (baseSeg) {
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i]!;
      const d = segmentDistance(seg.a, seg.b, baseSeg.a, baseSeg.b);
      if (d < seg.radius + baseSeg.radius + clearance) {
        reasons.push(`link ${seg.index} hits the base (${d.toFixed(1)} < ${(seg.radius + baseSeg.radius + clearance).toFixed(1)})`);
      }
    }
  }

  // Self-collision: any pair of non-adjacent capsules that overlaps. Two
  // capsules are adjacent when their link indices differ by one (they share a
  // joint pivot, so they always meet there). The fingers share one index, so
  // the palm and the fingers do not collide with each other, while the fingers
  // keep a distance of two or more from the forearm and earlier links.
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const si = segments[i]!;
      const sj = segments[j]!;
      if (sj.index - si.index <= 1) continue;
      const d = segmentDistance(si.a, si.b, sj.a, sj.b);
      if (d < si.radius + sj.radius + clearance) {
        reasons.push(`links ${i} and ${j} collide (${d.toFixed(1)} < ${(si.radius + sj.radius + clearance).toFixed(1)})`);
      }
    }
  }

  return { safe: reasons.length === 0, reasons };
}

/**
 * The static base-mount obstacle: the pedestal from the floor up to just below
 * the shoulder. Returns null when the chain has no visible base link.
 */
function baseMountObstacle(segments: ArmSegment[], options: SafetyOptions): ArmSegment | null {
  const first = segments[0];
  if (!first) return null;
  const radius = options.baseRadius;
  if (radius === undefined) return null;
  const skip = options.baseObstacleSkip ?? 100;
  const dir = vec3Subtract(first.b, first.a);
  const len = vec3Length(dir);
  if (len < 1e-6) return null;
  const unit = vec3Scale(dir, 1 / len);
  const topLen = Math.max(len - skip, 0);
  return {
    a: first.a,
    b: vec3Add(first.a, vec3Scale(unit, topLen)),
    radius,
    index: -1,
  };
}

/** Minimum distance between two line segments in 3D. */
export function segmentDistance(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3): number {
  const d1 = vec3Subtract(p2, p1);
  const d2 = vec3Subtract(p4, p3);
  const r = vec3Subtract(p1, p3);
  const a = vec3Dot(d1, d1);
  const e = vec3Dot(d2, d2);
  const f = vec3Dot(d2, r);
  let s: number;
  let t: number;
  const c = vec3Dot(d1, r);
  const b = vec3Dot(d1, d2);
  const denom = a * e - b * b;

  if (denom > 1e-12) {
    s = clamp((b * f - c * e) / denom, 0, 1);
  } else {
    s = 0;
  }
  if (e < 1e-12) {
    t = 0;
    s = a < 1e-12 ? 0 : clamp(-c / a, 0, 1);
  } else {
    t = (b * s + f) / e;
    if (t < 0) {
      t = 0;
      s = a < 1e-12 ? 0 : clamp(-c / a, 0, 1);
    } else if (t > 1) {
      t = 1;
      s = a < 1e-12 ? 0 : clamp((b - c) / a, 0, 1);
    }
  }
  const c1 = vec3Add(p1, vec3Scale(d1, s));
  const c2 = vec3Add(p3, vec3Scale(d2, t));
  return vec3Length(vec3Subtract(c1, c2));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
