import type { Mat4, Vec3 } from "./math3d";

export type { Mat4, Vec3 } from "./math3d";

/**
 * A single revolute joint in a kinematic chain.
 *
 * The joint rotates about `axis` (a unit vector in the joint's local frame).
 * `origin` is a fixed transform from the parent frame to this joint's frame,
 * applied before the joint rotation:
 *
 *   T_link_i(theta_i) = origin_i * Rot(axis_i, theta_i)
 *
 *   F_i = F_{i-1} * origin_i * Rot(axis_i, theta_i),  F_0 = base
 */
export interface KinematicJoint {
  name: string;
  /** Joint limits in radians. */
  min: number;
  max: number;
  /** Unit-ish rotation axis in the joint local frame. */
  axis: Vec3;
  /** Transform (column-major Mat4) from parent frame to this joint frame. */
  origin: Mat4;
}

/** A kinematic chain: a base transform, ordered joints, and a tool offset. */
export interface KinematicChain {
  name: string;
  base: Mat4;
  joints: KinematicJoint[];
  /** Transform from the last link frame to the end-effector frame. */
  tool: Mat4;
}

/** A full robot configuration: the chain plus the robot's real joint limits. */
export interface RobotKinematics {
  chain: KinematicChain;
}

/** End-effector pose: 4x4 column-major homogeneous transform in world/base frame. */
export type Pose = Mat4;

/** Joint state: a value per joint, in radians. */
export type JointState = number[];

export interface ForwardKinematics {
  /** End-effector pose in the base/world frame. */
  pose: Pose;
  /** Per-link frames (one per joint, plus base as index 0). */
  frames: Mat4[];
  /** Joint origin positions in the world frame (one per joint). */
  jointOrigins: Vec3[];
  /** Joint rotation axes in the world frame (one per joint). */
  jointAxes: Vec3[];
  /** Joint angles used. */
  q: JointState;
}

export interface IKTarget {
  /** EE position (x, y, z) in the base frame. */
  position: Vec3;
  /** Optional desired EE orientation as a 3x3 column-major rotation. */
  orientation?: Float64Array;
}

export interface IKResult {
  success: boolean;
  /** Joint state that reaches the target (best-effort). */
  q: JointState;
  /** Position error in mm at the solution. */
  error: number;
  /** Orientation error (rad). */
  orientationError: number;
  /** Number of iterations used. */
  iterations: number;
  /** True when the analytic solver found the solution. */
  analytic: boolean;
  /** Human-readable message when unsuccesful. */
  message?: string;
}

export interface IKSolverOptions {
  /** Position tolerance in mm (world units). */
  positionTolerance?: number;
  /** Orientation tolerance in radians. */
  orientationTolerance?: number;
  /** Maximum iterations. */
  maxIterations?: number;
  /** Damping term for the Levenberg-Marquardt step. */
  damping?: number;
  /** Initial guess (useful for warm-starts). */
  seed?: JointState;
  /**
   * Hard floor: the arm is forbidden from going below this plane.
   * `groundUpAxis` is the index of the vertical axis (0=x,1=y,2=z). Points on
   * the arm below `groundFloor` are pushed back above it as an active-set
   * constraint, and target positions are clamped to it.
   */
  groundFloor?: number;
  groundUpAxis?: number;
  groundWeight?: number;
  /**
   * End-effector reference offset, a point in the tool/end frame. The IK moves
   * this point to the target (e.g. the gripper tip) instead of the tool-frame
   * origin (the wrist). Default [0,0,0] = the tool-frame origin.
   */
  eeOffset?: Vec3;
  /**
   * Only commit a configuration that is collision-free and above the ground
   * plane. The solver tries several seeds (the arm's natural redundancy) and
   * returns the best safe one; if none is safe it returns `success: false`
   * with the seed (the current pose) so the caller holds rather than moving
   * the arm through itself or the floor. Default false.
   */
  avoidSelfCollision?: boolean;
  /** Radius (mm) per capsule. Length = joints.length + 1. Defaults to 38/24. */
  linkRadii?: number[];
  /** Extra clearance added to every collision radius (mm). Default 0. */
  clearance?: number;
  /**
   * Radius (mm) of the base mount as a static obstacle the moving links cannot
   * sweep through. Omit to disable the base check.
   */
  baseRadius?: number;
  /** Length (mm) removed from the base obstacle at the shoulder. Default 60. */
  baseObstacleSkip?: number;
  /** Number of extra seeds to try when `avoidSelfCollision` is set. Default 3. */
  restarts?: number;
  /**
   * Model of the gripper (palm plus two finger capsules). Use this to match a
   * particular hand. Omit to use the Panda hand defaults.
   */
  gripper?: GripperConfig;
}

/**
 * Geometry of the gripper hand capsules, in the tool frame. The tool frame has
 * +Z as the approach axis and +X as the opening axis.
 */
export interface GripperConfig {
  /** Half-distance between the two finger centre-lines on the X axis (mm). */
  fingerHalf?: number;
  /** Radius of each finger capsule (mm). */
  fingerRadius?: number;
  /** Tool-frame Z where the finger capsules start (mm). */
  fingerStart?: number;
  /** Tool-frame Z where the finger capsules end (mm). */
  fingerEnd?: number;
  /** Radius of the palm capsule (mm). */
  palmRadius?: number;
  /** Tool-frame Z where the palm capsule ends (mm). */
  palmEnd?: number;
}

export interface TrajectoryOptions {
  /** Velocity limit per joint (rad/s). */
  velocityLimit?: number;
  /** Acceleration limit per joint (rad/s^2). */
  accelerationLimit?: number;
  /** Time step for the trajectory (s). */
  timestep?: number;
}

export interface TrajectoryPoint {
  time: number;
  q: JointState;
}

/** Common interface for inverse-kinematics solvers. */
export interface FunctionalIK {
  solve(target: IKTarget, options?: IKSolverOptions): IKResult;
}
