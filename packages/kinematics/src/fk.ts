import {
  Mat4,
  Vec3,
  mat4Identity,
  mat4Mul,
  mat4TranslationOf,
  mat4TransformDir,
  vec3Cross,
  vec3Normalize,
} from "./math3d";
import type { ForwardKinematics, JointState, KinematicChain } from "./types";

/**
 * Forward kinematics for a revolute chain.
 *
 * For each joint i: F_i = F_{i-1} * origin_i * Rot(axis_i, q_i).
 * The end-effector pose is F_n * tool.
 */
export function forwardKinematics(chain: KinematicChain, q: JointState): ForwardKinematics {
  if (q.length !== chain.joints.length) {
    throw new Error(
      `FK: expected ${chain.joints.length} joint values, got ${q.length}`,
    );
  }

  const frames: Mat4[] = [mat4Identity()];
  let f = chain.base;

  const jointOrigins: Vec3[] = [];
  const jointAxes: Vec3[] = [];

  for (let i = 0; i < chain.joints.length; i++) {
    const joint = chain.joints[i];
    const jointFrame = mat4Mul(f, joint.origin);
    // World-space rotation centre and axis for this joint.
    jointOrigins.push(mat4TranslationOf(jointFrame));
    jointAxes.push(vec3Normalize(mat4TransformDir(jointFrame, joint.axis)));
    // Apply the joint rotation about its local axis.
    f = mat4Mul(jointFrame, rotAboutAxis(joint.axis, q[i]));
    frames.push(f);
  }

  const pose = mat4Mul(f, chain.tool);
  return { pose, frames, jointOrigins, jointAxes, q: q.slice() };
}

function rotAboutAxis(axis: Vec3, theta: number): Mat4 {
  // Build a rotation matrix about a possibly-non-unit axis using Rodrigues.
  const x = axis[0], y = axis[1], z = axis[2];
  const len = Math.hypot(x, y, z);
  if (len < 1e-12) return mat4Identity();
  const ux = x / len, uy = y / len, uz = z / len;
  const c = Math.cos(theta), s = Math.sin(theta), t = 1 - c;
  const m = new Float64Array(16);
  m[0] = t * ux * ux + c;
  m[1] = t * ux * uy + s * uz;
  m[2] = t * ux * uz - s * uy;
  m[4] = t * ux * uy - s * uz;
  m[5] = t * uy * uy + c;
  m[6] = t * uy * uz + s * ux;
  m[8] = t * ux * uz + s * uy;
  m[9] = t * uy * uz - s * ux;
  m[10] = t * uz * uz + c;
  m[15] = 1;
  return m;
}

/**
 * Analytic geometric Jacobian.
 *
 * The EE position block for revolute joint i is a_i x (p_ee - o_i); the
 * orientation block is a_i. a_i and o_i are the joint's world axis and
 * world origin. Returns a 6 x n column-major matrix (row-major internally
 * as a flat 6*n array where J[row * n + col]).
 */
export function jacobian(fk: ForwardKinematics, n: number): Float64Array {
  const J = new Float64Array(6 * n);
  const p = mat4TranslationOf(fk.pose);
  for (let i = 0; i < n; i++) {
    const a = fk.jointAxes[i];
    const o = fk.jointOrigins[i];
    const pv = vec3Cross(a, [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
    // Position block (rows 0-2)
    J[0 * n + i] = pv[0];
    J[1 * n + i] = pv[1];
    J[2 * n + i] = pv[2];
    // Orientation block (rows 3-5)
    J[3 * n + i] = a[0];
    J[4 * n + i] = a[1];
    J[5 * n + i] = a[2];
  }
  return J;
}

/** Position only (3 x n) Jacobian. */
export function positionJacobian(fk: ForwardKinematics, n: number): Float64Array {
  const J = new Float64Array(3 * n);
  const p = mat4TranslationOf(fk.pose);
  for (let i = 0; i < n; i++) {
    const a = fk.jointAxes[i];
    const o = fk.jointOrigins[i];
    const pv = vec3Cross(a, [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
    J[0 * n + i] = pv[0];
    J[1 * n + i] = pv[1];
    J[2 * n + i] = pv[2];
  }
  return J;
}


