import { mat4Identity, mat4Mul, mat4RotX, mat4RotY, mat4RotZ, mat4Translation } from "@robot/kinematics";
import type { KinematicChain, KinematicJoint, Mat4 } from "@robot/kinematics";

/** Axis of a joint or base, written in config as 'x' | 'y' | 'z'. */
export type AxisName = "x" | "y" | "z";
export type Axis = AxisName | [number, number, number];

export interface VecLike {
  x: number;
  y: number;
  z: number;
}

export interface OriginSpec {
  /** Translation from the parent frame (metres). */
  position?: VecLike | [number, number, number];
  /** Optional rotation of the joint frame, Euler XYZ (degrees). */
  orientation?: { x?: number; y?: number; z?: number };
}

export interface JointSpec {
  name: string;
  /** Rotation axis in the local frame: 'x' | 'y' | 'z' | a vector. */
  axis: Axis;
  /** Joint travel limits in degrees. */
  minDeg: number;
  maxDeg: number;
  /** Origin transform from the parent frame to this joint frame. */
  origin?: OriginSpec;
}

export interface RobotConfig {
  name: string;
  /** Base frame transform (optional, defaults to identity). */
  base?: OriginSpec;
  /** Joint chain, ordered from the base to the wrist. */
  joints: JointSpec[];
  /** Tool / end-effector offset from the last link (metres). */
  tool?: OriginSpec;
  /** Human-readable description (optional). */
  description?: string;
}

export function resolveAxis(axis: Axis): [number, number, number] {
  if (typeof axis === "string") {
    if (axis === "x") return [1, 0, 0];
    if (axis === "y") return [0, 1, 0];
    if (axis === "z") return [0, 0, 1];
    throw new Error(`Unknown axis ${axis}`);
  }
  return axis;
}

function toVec(v?: OriginSpec["position"]): [number, number, number] {
  if (!v) return [0, 0, 0];
  if (Array.isArray(v)) return v;
  return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
}

function originToMat(o: OriginSpec = {}): Mat4 {
  const p = toVec(o.position);
  const rot = o.orientation ?? {};
  const rx = ((rot.x ?? 0) * Math.PI) / 180;
  const ry = ((rot.y ?? 0) * Math.PI) / 180;
  const rz = ((rot.z ?? 0) * Math.PI) / 180;
  const r = mat4Mul(mat4Mul(mat4RotX(rx), mat4RotY(ry)), mat4RotZ(rz));
  return mat4Mul(mat4Translation(p[0], p[1], p[2]), r);
}

/** Build a KinematicChain from a friendly RobotConfig. */
export function buildChain(config: RobotConfig): KinematicChain {
  const joints: KinematicJoint[] = config.joints.map((j) => ({
    name: j.name,
    min: (Math.min(j.minDeg, j.maxDeg) * Math.PI) / 180,
    max: (Math.max(j.minDeg, j.maxDeg) * Math.PI) / 180,
    axis: resolveAxis(j.axis),
    origin: originToMat(j.origin),
  }));
  return {
    name: config.name,
    base: originToMat(config.base),
    joints,
    tool: originToMat(config.tool),
  };
}

/**
 * Official Franka Emika Panda (FER) limits, from the Franka "Robot and
 * interface specifications" page for the Panda (NOT the FR3, whose limits
 * differ). Radians, rad/s, rad/s^2, rad/s^3. Index 0 = joint1.
 *
 * The values here are the hardware limits. The kinematics package plans inside
 * them with a margin (PANDA_LIMIT_MARGIN_DEG); MoveIt uses the limits from the
 * franka_description URDF, which are the same numbers.
 */
export const PANDA_LIMITS = {
  qMin: [-2.8973, -1.7628, -2.8973, -3.0718, -2.8973, -0.0175, -2.8973],
  qMax: [2.8973, 1.7628, 2.8973, -0.0698, 2.8973, 3.7525, 2.8973],
  dqMax: [2.175, 2.175, 2.175, 2.175, 2.61, 2.61, 2.61],
  ddqMax: [15, 7.5, 10, 12.5, 15, 20, 20],
  dddqMax: [7500, 3750, 5000, 6250, 7500, 10000, 10000],
} as const;

/**
 * Margin (degrees) kept from each hardware position limit by the twin IK and
 * the joint-goal check. libfranka raises a joint-position-limit reflex close
 * to the limit, so do not plan right up to it.
 */
export const PANDA_LIMIT_MARGIN_DEG = 2;

/**
 * Franka "ready" pose (radians). This is the pose that franka_ros2 / Desk use
 * as the neutral start: arm upright, hand pointing down. Use it for "home".
 * Do NOT use the midpoint of the joint ranges: that is not a meaningful pose.
 */
export const PANDA_READY_POSE: readonly number[] = [0, -Math.PI / 4, 0, (-3 * Math.PI) / 4, 0, Math.PI / 2, Math.PI / 4];

/**
 * Distance (mm) from the flange (panda_link8) to the Franka Hand TCP, along
 * the flange +Z axis. This is the official F_T_EE translation (0.1034 m) for
 * the Franka Hand. The hand is also rotated -45 deg about Z; this model does
 * not need that rotation because the tool-down goal leaves the yaw free.
 */
export const PANDA_TCP_OFFSET_MM = 103.4;

const RAD2DEG = 180 / Math.PI;

/**
 * Franka Emika Panda (7-DOF) model.
 *
 * Kinematics are the official Franka URDF joint origins (identical for the
 * Panda and the FR3): every joint rotates about its local Z axis. Values are in
 * millimetres. The base rotation maps the URDF's Z-up frame to the twin's Y-up
 * world so the arm stands vertically: T = RotX(-90) * B.
 *
 * Joint limits are the Panda (FER) hardware limits minus `marginDeg`.
 * The tool is the flange (panda_link8, 107 mm after joint7). The TCP of the
 * Franka Hand is a further PANDA_TCP_OFFSET_MM along the tool +Z axis; callers
 * pass that as the IK `eeOffset`.
 */
export function defaultArmConfig(marginDeg = PANDA_LIMIT_MARGIN_DEG): RobotConfig {
  const lim = (i: number) => ({
    minDeg: PANDA_LIMITS.qMin[i]! * RAD2DEG + marginDeg,
    maxDeg: PANDA_LIMITS.qMax[i]! * RAD2DEG - marginDeg,
  });
  return {
    name: "franka-panda",
    description: "Franka Emika Panda (FER) 7-DOF. Dimensions in mm, official kinematics and limits.",
    // RotX(-90) converts the URDF Z-up frame to the twin's Y-up world.
    base: { orientation: { x: -90 } },
    joints: [
      { name: "joint1", axis: "z", ...lim(0), origin: { position: [0, 0, 333] } },
      { name: "joint2", axis: "z", ...lim(1), origin: { position: [0, 0, 0], orientation: { x: -90 } } },
      { name: "joint3", axis: "z", ...lim(2), origin: { position: [0, -316, 0], orientation: { x: 90 } } },
      { name: "joint4", axis: "z", ...lim(3), origin: { position: [82.5, 0, 0], orientation: { x: 90 } } },
      { name: "joint5", axis: "z", ...lim(4), origin: { position: [-82.5, 384, 0], orientation: { x: -90 } } },
      { name: "joint6", axis: "z", ...lim(5), origin: { position: [0, 0, 0], orientation: { x: 90 } } },
      { name: "joint7", axis: "z", ...lim(6), origin: { position: [88, 0, 0], orientation: { x: 90 } } },
    ],
    // joint7 -> flange (panda_link8): 107 mm along +Z. Not the finger tip.
    tool: { position: [0, 0, 107] },
  };
}
