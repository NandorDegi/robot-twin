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
 * Franka Emika Panda (7-DOF) model.
 *
 * Kinematics are the official Franka values (identical for the Panda and the
 * FR3): every joint rotates about its local Z axis, and the joint origins are
 * the official URDF origins. Values are in millimetres. Each joint axis is
 * `z`; the alternating yaw/pitch comes from each origin's roll (the local
 * frame is re-oriented). The base rotation maps the URDF's Z-up frame to the
 * twin's Y-up world so the arm stands vertically.
 *
 * Joint limits are the Panda's (from the official joint_limits.yaml).
 */
export function defaultArmConfig(): RobotConfig {
  return {
    name: "franka-panda",
    description: "Franka Emika Panda 7-DOF. Dimensions in mm, official kinematics.",
    // RotX(-90) converts the URDF Z-up frame to the twin's Y-up world.
    base: { orientation: { x: -90 } },
    joints: [
      { name: "joint1", axis: "z", minDeg: -166.2, maxDeg: 166.2, origin: { position: [0, 0, 333] } },
      { name: "joint2", axis: "z", minDeg: -105.2, maxDeg: 105.2, origin: { position: [0, 0, 0], orientation: { x: -90 } } },
      { name: "joint3", axis: "z", minDeg: -166.2, maxDeg: 166.2, origin: { position: [0, -316, 0], orientation: { x: 90 } } },
      { name: "joint4", axis: "z", minDeg: -176.3, maxDeg: -6.7, origin: { position: [82.5, 0, 0], orientation: { x: 90 } } },
      { name: "joint5", axis: "z", minDeg: -164.8, maxDeg: 164.8, origin: { position: [-82.5, 384, 0], orientation: { x: -90 } } },
      { name: "joint6", axis: "z", minDeg: 25.2, maxDeg: 264.8, origin: { position: [0, 0, 0], orientation: { x: 90 } } },
      { name: "joint7", axis: "z", minDeg: -174.8, maxDeg: 174.8, origin: { position: [88, 0, 0], orientation: { x: 90 } } },
    ],
    // Flange-to-finger tool offset (Panda hand).
    tool: { position: [0, 0, 107] },
  };
}
