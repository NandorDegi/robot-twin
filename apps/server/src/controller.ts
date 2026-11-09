import {
  generateTrajectory,
  type InverseKinematicsSolver,
  type JointState,
  type KinematicChain,
  type TrajectoryPoint,
  type Vec3,
} from "@robot/kinematics";
import type { MotionResult, RobotAdapter } from "@robot/hardware";
import { PANDA_LIMITS, PANDA_READY_POSE, createPandaSolver, seedToward, toolDownRotation } from "@robot/robot-config";

export interface ControllerOptions {
  controlHz?: number;
  broadcastHz?: number;
  /**
   * Fraction (0..1] of the Panda joint velocity/acceleration limits used by
   * the SIMULATED motion. Real motion speed is set by the Franka bridge
   * (FRANKA_SPEED_FACTOR, capped there).
   */
  speedScaling?: number;
  /** @deprecated kept for old callers: rad/s for all joints (simulation only). */
  velocityLimit?: number;
  /** Simulation only: run simulated time this many times faster (tests). */
  simTimeScale?: number;
}

/**
 * Orchestrates the digital-twin loop. It is the single source of truth that
 * the twin mirrors.
 *
 * Safety rules enforced here:
 *  - starts DISABLED; only an explicit setEnabled(true) allows motion;
 *  - with a real adapter, the start state is the robot's measured state
 *    (never an assumed pose), and the state shown to the twin is the robot's;
 *  - every goal is validated before it is sent: 7 finite values, inside the
 *    joint limits (with margin), no self-collision, nothing under the floor,
 *    and the straight joint-space path to it is checked sample by sample
 *    (that is the path the Panda follows for a joint move);
 *  - an IK target that is not reached exactly is NOT executed;
 *  - real adapters get whole goals only, one at a time; a failed or stopped
 *    motion disables the controller (a person must re-enable it).
 */
export class RobotController {
  private q: JointState;
  private qGoal: JointState;
  private path: TrajectoryPoint[] = [];
  private pathTime = 0;
  private pathDuration = 0;
  private pathDone: ((r: MotionResult) => void) | null = null;
  private gripperOpen = false;
  private enabled = false;
  private mode = "sim";
  private fault = "";
  private goalInFlight = false;
  private lastTarget: Vec3 | null = null;
  private lastTargetSuccess = false;
  private lastTargetError = Number.POSITIVE_INFINITY;
  private lastMotion: MotionResult = { ok: true };

  private readonly solver: InverseKinematicsSolver;
  private readonly toolDown: Float64Array;
  private readonly controlHz: number;
  private readonly broadcastHz: number;
  private readonly vel: number[];
  private readonly acc: number[];
  private readonly jerk: number[];
  private readonly tick: number;
  private readonly simTimeScale: number;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    public readonly chain: KinematicChain,
    private readonly adapter: RobotAdapter,
    options: ControllerOptions = {},
  ) {
    this.controlHz = options.controlHz ?? 120;
    this.broadcastHz = options.broadcastHz ?? 30;
    this.tick = 1 / this.controlHz;
    this.simTimeScale = options.simTimeScale ?? 1;
    const k = Math.min(Math.max(options.speedScaling ?? 1, 0.01), 1);
    const n = chain.joints.length;
    const pick = (arr: readonly number[], i: number, d: number) => arr[i] ?? d;
    this.vel = Array.from({ length: n }, (_, i) => Math.min(pick(PANDA_LIMITS.dqMax, i, 2), options.velocityLimit ?? Infinity) * k);
    this.acc = Array.from({ length: n }, (_, i) => pick(PANDA_LIMITS.ddqMax, i, 7.5) * k);
    this.jerk = Array.from({ length: n }, (_, i) => pick(PANDA_LIMITS.dddqMax, i, 3750) * k);
    this.solver = createPandaSolver(chain);
    this.toolDown = toolDownRotation(chain);
    this.q = n === PANDA_READY_POSE.length ? [...PANDA_READY_POSE] : chain.joints.map((j) => (j.min + j.max) / 2);
    this.qGoal = this.q.slice();
    this.mode = adapter.isReal ? "real" : "sim";
  }

  get state(): JointState {
    return this.q.slice();
  }

  get target(): Vec3 | null {
    return this.lastTarget;
  }

  get targetReached(): boolean {
    return this.lastTargetSuccess;
  }

  get targetError(): number {
    return this.lastTargetError;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get gripOpen(): boolean {
    return this.gripperOpen;
  }

  get mode_(): string {
    return this.fault ? `fault: ${this.fault}` : this.mode;
  }

  get faultReason(): string {
    return this.fault;
  }

  get lastMotionResult(): MotionResult {
    return this.lastMotion;
  }

  get isReal(): boolean {
    return this.adapter.isReal;
  }

  /** True while the arm is following a motion. */
  get isMoving(): boolean {
    return this.path.length > 0 || this.goalInFlight;
  }

  /** Resolve once the arm has finished its current motion. True if it settled. */
  async waitUntilSettled(timeoutMs = 60000): Promise<boolean> {
    const start = Date.now();
    while (this.isMoving && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return !this.isMoving;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(): Promise<void> {
    await this.adapter.connect();
    this.adapter.onConnectionLost?.((reason) => this.setFault(reason));
    if (this.adapter.isReal) {
      const q = await this.adapter.readJointAngles();
      if (q.length !== this.chain.joints.length || !q.every(Number.isFinite)) {
        throw new Error(`robot reported ${q.length} joints; expected ${this.chain.joints.length}`);
      }
      this.q = q.slice();
      this.qGoal = q.slice();
    }
    this.running = true;
    this.timer = setInterval(() => this.step(), 1000 / this.controlHz);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.adapter.disconnect();
  }

  /**
   * Check a joint goal and the straight joint-space path to it.
   * Returns a reason, or null when the goal is safe to send.
   */
  validateGoal(q: JointState, from: JointState = this.q): string | null {
    const n = this.chain.joints.length;
    if (q.length !== n) return `expected ${n} joint values, got ${q.length}`;
    if (!q.every(Number.isFinite)) return "joint values must be finite";
    for (let i = 0; i < n; i++) {
      const j = this.chain.joints[i]!;
      if (q[i]! < j.min || q[i]! > j.max) {
        return `${j.name} = ${((q[i]! * 180) / Math.PI).toFixed(1)} deg is outside [${((j.min * 180) / Math.PI).toFixed(1)}, ${((j.max * 180) / Math.PI).toFixed(1)}] deg`;
      }
    }
    const end = this.solver.isConfigSafe(q);
    if (!end.safe) return end.reasons[0] ?? "unsafe configuration";
    const steps = 40;
    for (let k = 1; k < steps; k++) {
      const u = k / steps;
      const qq = from.map((a, i) => a + (q[i]! - a) * u);
      const c = this.solver.isConfigSafe(qq);
      if (!c.safe) return `path is unsafe at ${(u * 100).toFixed(0)}%: ${c.reasons[0]}`;
    }
    return null;
  }

  /** Validate and execute a joint goal. Resolves when the motion is done. */
  async moveJoints(q: JointState): Promise<MotionResult> {
    if (!this.enabled) return this.done({ ok: false, error: "disabled" });
    if (this.fault) return this.done({ ok: false, error: `fault: ${this.fault}` });
    if (this.adapter.isReal && this.isMoving) return this.done({ ok: false, error: "robot busy" });
    const reason = this.validateGoal(q);
    if (reason) return this.done({ ok: false, error: `rejected: ${reason}` });
    this.qGoal = q.slice();

    if (this.adapter.moveToJoints) {
      this.goalInFlight = true;
      this.emit();
      let res: MotionResult;
      try {
        res = await this.adapter.moveToJoints(q);
      } catch (err) {
        res = { ok: false, error: String(err) };
      }
      this.goalInFlight = false;
      await this.refreshFromRobot();
      if (!res.ok) this.setFault(res.error ?? "motion failed");
      return this.done(res);
    }

    // Streaming (simulated) adapter: run the trajectory in the control loop.
    if (this.pathDone) this.pathDone({ ok: false, error: "preempted" });
    this.path = generateTrajectory(this.q, q, {
      velocityLimit: this.vel,
      accelerationLimit: this.acc,
      jerkLimit: this.jerk,
      timestep: this.tick,
    });
    this.pathTime = 0;
    this.pathDuration = this.path.length ? this.path[this.path.length - 1]!.time : 0;
    const res = await new Promise<MotionResult>((resolve) => {
      this.pathDone = resolve;
    });
    return this.done(res);
  }

  /**
   * Solve IK for a TCP position (twin frame, mm) and move there.
   * `orientation`: "down" (hand points down), a 3x3 column-major rotation,
   * or undefined (position only; twin experiments in simulation).
   */
  async moveToPosition(position: Vec3, orientation?: "down" | Float64Array): Promise<MotionResult> {
    const ik = this.solveIk(position, orientation);
    if (!ik.ok) return this.done({ ok: false, error: ik.error });
    return this.moveJoints(ik.q);
  }

  /**
   * Twin "move to target". Returns whether the IK reached the target. The
   * motion runs in the background; a target that is not reached exactly is
   * never executed.
   */
  async setTarget(position: Vec3, orientation?: [number, number, number]): Promise<boolean> {
    if (!this.enabled) return false;
    // Real robot: always point the hand down (the only orientation the chess
    // task uses, and the one the reachability check covers).
    const o = this.adapter.isReal ? "down" : orientation ? toRotation(orientation) : undefined;
    const ik = this.solveIk(position, o);
    if (!ik.ok) {
      this.emit();
      return false;
    }
    void this.moveJoints(ik.q);
    return true;
  }

  /** Direct joint goal (sliders, replay). Returns a rejection reason, or null. */
  async setJointState(q: JointState): Promise<string | null> {
    if (!this.enabled) return "disabled";
    if (this.adapter.isReal && this.isMoving) return "robot busy";
    const reason = this.validateGoal(q);
    if (reason) return reason;
    void this.moveJoints(q);
    return null;
  }

  async setGripper(open: boolean): Promise<MotionResult> {
    if (this.adapter.isReal && !this.enabled) return { ok: false, error: "disabled" };
    let res: MotionResult = { ok: true };
    try {
      res = (await this.adapter.setGripper(open)) ?? { ok: true };
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    if (res.ok) this.gripperOpen = open;
    this.emit();
    return res;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && this.fault) {
      // Re-enabling is the operator's acknowledgement of the fault.
      this.fault = "";
    }
    this.enabled = enabled;
    this.adapter.setEnabled(enabled);
    if (!enabled) this.abortPath("disabled");
    this.emit();
  }

  async home(): Promise<MotionResult> {
    return this.moveJoints([...PANDA_READY_POSE].slice(0, this.chain.joints.length));
  }

  emergencyStop(): void {
    this.enabled = false;
    this.abortPath("emergency stop");
    this.adapter.emergencyStop();
    this.emit();
  }

  /** Stop, disable, and keep a reason until a person re-enables. */
  setFault(reason: string): void {
    this.fault = reason;
    this.emergencyStop();
  }

  private solveIk(position: Vec3, orientation?: "down" | Float64Array): { ok: true; q: JointState } | { ok: false; error: string } {
    const rot = orientation === "down" ? this.toolDown : orientation;
    let res = this.solver.solve({ position, orientation: rot }, { seed: this.q });
    if (!res.success) res = this.solver.solve({ position, orientation: rot }, { seed: seedToward(position) });
    this.lastTarget = position;
    this.lastTargetSuccess = res.success;
    this.lastTargetError = res.error;
    if (!res.success) {
      return { ok: false, error: `IK: target not reachable (${res.message ?? `error ${res.error.toFixed(1)} mm`})` };
    }
    return { ok: true, q: res.q };
  }

  private done(res: MotionResult): MotionResult {
    this.lastMotion = res;
    this.emit();
    return res;
  }

  private abortPath(reason: string): void {
    this.path = [];
    if (this.pathDone) {
      const fn = this.pathDone;
      this.pathDone = null;
      fn({ ok: false, error: reason });
    }
  }

  private async refreshFromRobot(): Promise<void> {
    if (!this.adapter.isReal || this.polling) return;
    this.polling = true;
    try {
      const q = await this.adapter.readJointAngles();
      if (q.length === this.chain.joints.length) this.q = q.slice();
    } catch (err) {
      if (this.enabled) this.setFault(`lost robot state: ${String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private step(): void {
    if (!this.running) return;

    const frame = Math.floor(Date.now() / (1000 / this.broadcastHz));
    const newFrame = frame !== this.lastBroadcastFrame;

    if (this.adapter.isReal) {
      // Mirror the measured robot state (never a model of it).
      if (newFrame) void this.refreshFromRobot();
    } else if (this.path.length && this.enabled) {
      this.pathTime += this.tick * this.simTimeScale;
      const qAtTime = this.samplePath(this.pathTime);
      this.q = qAtTime;
      void this.adapter.setJointAngles(qAtTime);
      if (this.pathTime >= this.pathDuration) {
        this.path = [];
        const fn = this.pathDone;
        this.pathDone = null;
        fn?.({ ok: true });
      }
    }

    if (newFrame) {
      this.lastBroadcastFrame = frame;
      this.emit();
    }
  }

  private lastBroadcastFrame = 0;

  private samplePath(t: number): JointState {
    const path = this.path;
    if (path.length === 0) return this.qGoal.slice();
    let lo = 0;
    let hi = path.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path[mid]!.time < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return path[0]!.q.slice();
    const a = path[lo - 1]!;
    const b = path[lo]!;
    const span = b.time - a.time || 1;
    const u = Math.min(Math.max((t - a.time) / span, 0), 1);
    return a.q.map((v, k) => v + (b.q[k]! - v) * u);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function toRotation(axisAngle: [number, number, number]): Float64Array {
  // Build a 3x3 column-major rotation from an axis-angle vector.
  const [x, y, z] = axisAngle;
  const angle = Math.hypot(x, y, z);
  if (angle < 1e-9) return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const k = [x / angle, y / angle, z / angle] as const;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return new Float64Array([
    t * k[0] * k[0] + c,
    t * k[0] * k[1] + s * k[2],
    t * k[0] * k[2] - s * k[1],
    t * k[0] * k[1] - s * k[2],
    t * k[1] * k[1] + c,
    t * k[1] * k[2] + s * k[0],
    t * k[0] * k[2] + s * k[1],
    t * k[1] * k[2] - s * k[0],
    t * k[2] * k[2] + c,
  ]);
}
