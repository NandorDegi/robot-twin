import type { JointState } from "@robot/kinematics";
import type { RobotAdapter } from "./adapter";

/**
 * Software-only arm for the digital twin. No real motors.
 * Stores the joint state in memory and simulates motion.
 */
export class SimulatedAdapter implements RobotAdapter {
  readonly name = "simulated";

  constructor(
    private readonly jointCount: number,
    private q: JointState = Array.from({ length: jointCount }, () => 0),
    private gripperOpen = false,
    private enabled = false,
  ) {
    this.q = q.slice(0, jointCount);
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async setJointAngles(q: JointState): Promise<void> {
    this.q = q.slice();
  }

  async readJointAngles(): Promise<JointState> {
    return this.q.slice();
  }

  async setGripper(open: boolean): Promise<void> {
    this.gripperOpen = open;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  emergencyStop(): void {
    this.enabled = false;
  }

  get state(): JointState {
    return this.q.slice();
  }

  get gripOpen(): boolean {
    return this.gripperOpen;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}
