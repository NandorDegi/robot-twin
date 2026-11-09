import type { JointState } from "@robot/kinematics";

export interface MotionResult {
  ok: boolean;
  error?: string;
}

/**
 * Minimal interface to a robot's low-level controller.
 *
 * The digital twin talks to the arm only through this interface, so the
 * physical hardware can swap in later without touching the twin, IK, or
 * vision code.
 *
 * Two kinds of adapter exist:
 *  - streaming (the simulator): the controller samples its own trajectory and
 *    calls setJointAngles at the control rate;
 *  - goal-based (the real Panda): the adapter implements `moveToJoints` and
 *    executes the whole move itself. The controller then never streams
 *    samples to it; it only sends validated goals and mirrors the real state.
 */
export interface RobotAdapter {
  readonly name: string;
  /** True when this adapter moves a real robot. */
  readonly isReal: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Command the joint angles (radians). Streaming adapters only. */
  setJointAngles(q: JointState): Promise<void>;
  /** Read the current joint angles (radians). */
  readJointAngles(): Promise<JointState>;
  /** Open or close (grasp) the gripper. Resolves when done. */
  setGripper(open: boolean): Promise<MotionResult | void>;
  /** Enable/disable motion. Safety gate. */
  setEnabled(enabled: boolean): void;
  /** Stop all motion now. Not a safety function on a real robot. */
  emergencyStop(): void;
  /** Goal-based adapters: execute a full joint-space move, resolve when done. */
  moveToJoints?(q: JointState): Promise<MotionResult>;
  /** Called when the adapter loses its link to the robot. */
  onConnectionLost?(fn: (reason: string) => void): void;
}
