import type { JointState } from "@robot/kinematics";
import type { MotionResult, RobotAdapter } from "./adapter";

interface BridgeState {
  q: number[];
  connected: boolean;
  dryRun?: boolean;
  moving?: boolean;
  lastMotion?: { id: string | null; ok: boolean | null; error: string };
  error?: string;
}

interface BridgeResult {
  ok: boolean;
  error?: string;
  token?: string;
}

export interface FrankaAdapterOptions {
  baseUrl?: string;
  /** Heartbeat period (ms). Must be well under the bridge lease timeout (1 s). */
  heartbeatMs?: number;
  /** Longest single move (ms) before the adapter stops it. */
  motionTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Goal-based adapter for the Franka Panda through the FCI bridge
 * (`apps/franka/franka_bridge.py`, panda-py / libfranka 0.9.2).
 *
 * - It holds the bridge's single command lease and sends a heartbeat. When
 *   this process dies or hangs, the heartbeat stops and the bridge stops the
 *   arm by itself.
 * - It sends only complete goals (`moveToJoints`), never trajectory samples.
 *   The bridge validates each goal again and moves with panda-py's
 *   time-parameterised joint motion at a capped speed factor.
 * - setJointAngles (streaming) is refused on purpose.
 */
export class FrankaAdapter implements RobotAdapter {
  readonly name = "franka";
  readonly isReal = true;
  private enabled = false;
  private token: string | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private lostListeners: ((reason: string) => void)[] = [];
  private seq = 0;
  private readonly baseUrl: string;
  private readonly heartbeatMs: number;
  private readonly motionTimeoutMs: number;
  private readonly f: typeof fetch;
  dryRun = false;

  constructor(opts: FrankaAdapterOptions | string = {}) {
    const o = typeof opts === "string" ? { baseUrl: opts } : opts;
    this.baseUrl = o.baseUrl ?? process.env.FRANKA_BRIDGE_URL ?? "http://127.0.0.1:3002";
    this.heartbeatMs = o.heartbeatMs ?? 250;
    this.motionTimeoutMs = o.motionTimeoutMs ?? 60000;
    this.f = o.fetchImpl ?? fetch;
  }

  async connect(): Promise<void> {
    const st = await this.getState();
    if (!st.connected) {
      throw new Error(`FrankaAdapter: the bridge at ${this.baseUrl} has no robot connection (${st.error ?? "unreachable"})`);
    }
    this.dryRun = Boolean(st.dryRun);
    const lease = await this.post("/lease", { owner: `robot-server pid ${process.pid}` }, false);
    if (!lease.ok || !lease.token) {
      throw new Error(`FrankaAdapter: cannot get the command lease: ${lease.error ?? "unknown"}. Only one process may command the arm.`);
    }
    this.token = lease.token;
    this.hb = setInterval(() => void this.heartbeat(), this.heartbeatMs);
  }

  async disconnect(): Promise<void> {
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
    if (this.token) await this.post("/release", {});
    this.token = null;
  }

  onConnectionLost(fn: (reason: string) => void): void {
    this.lostListeners.push(fn);
  }

  async setJointAngles(_q: JointState): Promise<void> {
    throw new Error("FrankaAdapter is goal-based: use moveToJoints (streaming samples to the Panda is not allowed)");
  }

  async moveToJoints(q: JointState): Promise<MotionResult> {
    if (!this.enabled) return { ok: false, error: "disabled" };
    if (!this.token) return { ok: false, error: "no lease" };
    const id = `m${++this.seq}`;
    const start = await this.post("/move", { q, id });
    if (!start.ok) return { ok: false, error: start.error ?? "move rejected" };
    const t0 = Date.now();
    for (;;) {
      await sleep(50);
      const st = await this.getState();
      if (!st.connected) {
        void this.post("/stop", {}, false);
        return { ok: false, error: `robot connection lost: ${st.error ?? ""}` };
      }
      if (!this.enabled) {
        void this.post("/stop", {}, false);
      }
      if (!st.moving && st.lastMotion?.id === id && st.lastMotion.ok !== null) {
        return { ok: Boolean(st.lastMotion.ok), error: st.lastMotion.error || undefined };
      }
      if (Date.now() - t0 > this.motionTimeoutMs) {
        await this.post("/stop", {}, false);
        return { ok: false, error: "motion timeout" };
      }
    }
  }

  async readJointAngles(): Promise<JointState> {
    const st = await this.getState();
    if (!st.connected || !Array.isArray(st.q) || st.q.length !== 7) {
      throw new Error(`FrankaAdapter: cannot read state. ${st.error ?? "not connected"}`);
    }
    return st.q;
  }

  async setGripper(open: boolean): Promise<MotionResult> {
    if (!this.enabled) return { ok: false, error: "disabled" };
    const r = await this.post("/gripper", { open }, true, 15000);
    return { ok: r.ok, error: r.error || undefined };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) void this.post("/stop", {}, false);
  }

  emergencyStop(): void {
    this.enabled = false;
    void this.post("/stop", {}, false);
  }

  private async heartbeat(): Promise<void> {
    const r = await this.post("/heartbeat", {});
    if (!r.ok) {
      if (this.hb) clearInterval(this.hb);
      this.hb = null;
      this.token = null;
      this.enabled = false;
      for (const fn of this.lostListeners) fn(`bridge lease lost: ${r.error ?? ""}`);
    }
  }

  private async getState(): Promise<BridgeState> {
    try {
      const res = await this.f(`${this.baseUrl}/state`, { signal: AbortSignal.timeout(2000) });
      return (await res.json()) as BridgeState;
    } catch (err) {
      return { q: [], connected: false, error: String(err) };
    }
  }

  private async post(path: string, body: unknown, withLease = true, timeoutMs = 2000): Promise<BridgeResult> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (withLease && this.token) headers["X-Lease"] = this.token;
      const res = await this.f(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return (await res.json()) as BridgeResult;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
