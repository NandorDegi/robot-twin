import type { JointState } from "@robot/kinematics";
import type { RobotAdapter } from "./adapter";

/**
 * Placeholder for a real serial (UART/USB) link to the arm's control board.
 *
 * The arm's controller is a "complete kit" with an unknown firmware, so the
 * exact frame protocol is not known yet. This class documents the interface
 * and reports a clear "not implemented" until the board is identified.
 *
 * Wiring the real board later means:
 *   1. Identify the board and its firmware (Arduino / ESP32 / STM32 / kit).
 *   2. Implement `readJointAngles` and `setJointAngles` with its protocol.
 *   3. Plug in the `SerialAdapter` in apps/server in place of the simulator.
 */
export class SerialAdapter implements RobotAdapter {
  readonly name = "serial";

  constructor(private readonly port = "/dev/ttyUSB0") {}

  async connect(): Promise<void> {
    throw new Error(
      `SerialAdapter: no controller identified yet. Wire the real board in ` +
        `packages/hardware/src/serial.ts once you know its firmware (port ${this.port}).`,
    );
  }

  async disconnect(): Promise<void> {
    throw new Error("SerialAdapter: not connected.");
  }

  async setJointAngles(_q: JointState): Promise<void> {
    throw new Error("SerialAdapter: not connected.");
  }

  async readJointAngles(): Promise<JointState> {
    throw new Error("SerialAdapter: not connected.");
  }

  async setGripper(_open: boolean): Promise<void> {
    throw new Error("SerialAdapter: not connected.");
  }

  setEnabled(_enabled: boolean): void {}

  emergencyStop(): void {}
}
