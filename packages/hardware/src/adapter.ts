import type { JointState } from "@robot/kinematics";

/**
 * Minimal interface to a robot's low-level controller.
 *
 * The digital twin talks to the arm only through this interface, so the
 * physical hardware can swap in later (serial/UART, USB, network) without
 * touching the twin, IK, or vision code.
 */
export interface RobotAdapter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Command the joint angles (radians). */
  setJointAngles(q: JointState): Promise<void>;
  /** Read the current joint angles (radians). */
  readJointAngles(): Promise<JointState>;
  setGripper(open: boolean): Promise<void>;
  /** Enable/disable motion. Safety gate. */
  setEnabled(enabled: boolean): void;
  /** Immediately stop all motion. */
  emergencyStop(): void;
}
