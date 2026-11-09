import type { JointState } from "@robot/kinematics";
import type { RobotAdapter } from "./adapter";

interface BridgeState {
  q: number[];
  connected: boolean;
  error?: string;
}

interface BridgeResult {
  ok: boolean;
  error?: string;
}

/**
 * Adapter that talks to the Franka Panda through the FCI bridge
 * (`apps/franka/franka_bridge.py`, which uses panda-py / libfranka).
 *
 * The bridge exposes a small HTTP API on localhost:3002. This adapter turns
 * the controller's joint commands into bridge calls. Motion is level-position
 * control (move_to_joint_position); command rate is throttled so the robot is
 * not hammered on every control tick.
 */
export class FrankaAdapter implements RobotAdapter {
  readonly name = "franka";
  private enabled = false;
  private lastSent: JointState | null = null;
  private lastSentAt = 0;
  private connected = false;
  private lastError = "";

  constructor(private readonly baseUrl = process.env.FRANKA_BRIDGE_URL ?? "http://localhost:3002") {}

  async connect(): Promise<void> {
    const st = await this.getState();
    if (!st.connected) {
      throw new Error(
        `FrankaAdapter: no Panda reachable at ${this.baseUrl}. ` +
          `Run apps/franka/franka_bridge.py on the FCI workstation first. ` +
          (st.error ? `(${st.error})` : ""),
      );
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async setJointAngles(q: JointState): Promise<void> {
    if (!this.connected) return;
    const now = Date.now();
    const changed =
      !this.lastSent || q.some((v, i) => Math.abs(v - (this.lastSent![i] ?? 0)) > 0.01);
    // Throttle to ~20 Hz and only when the goal moved.
    if (changed && now - this.lastSentAt >= 50) {
      this.lastSentAt = now;
      this.lastSent = q.slice();
      await this.post("/command", { q });
    }
  }

  async readJointAngles(): Promise<JointState> {
    const st = await this.getState();
    if (!st.connected || !Array.isArray(st.q)) {
      throw new Error(`FrankaAdapter: cannot read state. ${st.error ?? "not connected"}`);
    }
    return st.q;
  }

  async setGripper(open: boolean): Promise<void> {
    if (!this.connected) return;
    await this.post("/gripper", { open });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  emergencyStop(): void {
    this.enabled = false;
    void this.post("/estop", {}).catch(() => {});
  }

  private async getState(): Promise<BridgeState> {
    try {
      const res = await fetch(`${this.baseUrl}/state`, { signal: AbortSignal.timeout(2000) });
      const data = (await res.json()) as BridgeState;
      this.connected = Boolean(data.connected);
      this.lastError = data.error ?? "";
      return data;
    } catch (err) {
      this.connected = false;
      this.lastError = String(err);
      return { q: [], connected: false, error: String(err) };
    }
  }

  private async post(path: string, body: unknown): Promise<BridgeResult> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      });
      const data = (await res.json()) as BridgeResult;
      this.lastError = data.error ?? "";
      return data;
    } catch (err) {
      this.lastError = String(err);
      return { ok: false, error: String(err) };
    }
  }
}
