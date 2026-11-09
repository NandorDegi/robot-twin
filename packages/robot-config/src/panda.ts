import {
  InverseKinematicsSolver,
  defaultPandaGripper,
  forwardKinematics,
  mat4ToMat3,
  type JointState,
  type KinematicChain,
  type Vec3,
} from "@robot/kinematics";
import { PANDA_READY_POSE, PANDA_TCP_OFFSET_MM, buildChain, defaultArmConfig } from "./config";

/**
 * One place for the Panda IK and safety settings, so the server, the twin, the
 * calibration CLI and the tests all check the same thing.
 */
export const PANDA_SAFETY = {
  /** IK reference point: the Franka Hand TCP, in the flange frame (mm). */
  eeOffset: [0, 0, PANDA_TCP_OFFSET_MM] as Vec3,
  /** Base column treated as an obstacle (mm). */
  baseRadius: 55,
  gripper: defaultPandaGripper,
  /** Lowest allowed height of any link (mm, twin Y = robot base Z). */
  groundFloor: 0,
} as const;

/** Height (mm) above a pick/place target from which the hand descends vertically. */
export const APPROACH_HEIGHT_MM = 100;

export function createPandaSolver(chain: KinematicChain = buildChain(defaultArmConfig())): InverseKinematicsSolver {
  return new InverseKinematicsSolver(chain, {
    positionTolerance: 1.0,
    orientationTolerance: 0.01,
    maxIterations: 200,
    avoidSelfCollision: true,
    eeOffset: [...PANDA_SAFETY.eeOffset] as Vec3,
    baseRadius: PANDA_SAFETY.baseRadius,
    gripper: PANDA_SAFETY.gripper,
    groundFloor: PANDA_SAFETY.groundFloor,
  });
}

/**
 * "Hand points straight down" rotation in the twin frame, taken from the
 * Franka ready pose (so it is exactly reachable, with the ready-pose yaw).
 */
export function toolDownRotation(chain: KinematicChain = buildChain(defaultArmConfig())): Float64Array {
  return mat4ToMat3(forwardKinematics(chain, [...PANDA_READY_POSE]).pose);
}

/**
 * IK seed for a target: the ready pose, turned about joint1 toward the target.
 * Twin frame: base X = twin X, base Y = -twin Z.
 */
export function seedToward(position: Vec3): JointState {
  const seed = [...PANDA_READY_POSE];
  seed[0] = Math.atan2(-position[2], position[0]);
  return seed;
}
