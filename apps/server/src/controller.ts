import {
  InverseKinematicsSolver,
  defaultPandaGripper,
  generateTrajectory,
  type JointState,
  type KinematicChain,
  type TrajectoryPoint,
  type Vec3,
} from "@robot/kinematics";
import type { RobotAdapter } from "@robot/hardware";

/**
 * Orchestrates the digital-twin loop: holds the current and desired joint
 * state, drives motion through a smooth trajectory, and commands the hardware
 * adapter. It is the single source of truth that the twin mirrors.
 */
export class RobotController {
  private q: JointState;
  private qGoal: JointState;
  private path: TrajectoryPoint[] = [];
  private pathTime = 0;
  private pathDuration = 0;
  private gripperOpen = false;
  private enabled = false;
  private mode = "sim";
  private lastTarget: Vec3 | null = null;
  private lastTargetSuccess = false;
  private lastTargetError = Number.POSITIVE_INFINITY;

  private readonly solver: InverseKinematicsSolver;
  private readonly controlHz: number;
  private readonly broadcastHz: number;
  private readonly velocityLimit: number;
  private readonly tick = 1 / 120;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    public readonly chain: KinematicChain,
    private readonly adapter: RobotAdapter,
    options: { controlHz?: number; broadcastHz?: number; velocityLimit?: number } = {},
  ) {
    this.controlHz = options.controlHz ?? 120;
    this.broadcastHz = options.broadcastHz ?? 30;
    this.velocityLimit = options.velocityLimit ?? Math.PI;
    // Model units are millimetres, so a sensible tolerance is ~1 mm.
    // The end-effector reference is the gripper tip (130 mm further in the tool
    // frame), so the arm reaches a target with the gripper, not the wrist.
    this.solver = new InverseKinematicsSolver(chain, {
      positionTolerance: 1.0,
      eeOffset: [0, 0, 130],
      avoidSelfCollision: true,
      baseRadius: 55,
      gripper: defaultPandaGripper,
    });
    this.q = chain.joints.map((j) => (j.min + j.max) / 2);
    this.qGoal = this.q.slice();
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
    return this.mode;
  }

  /** True while the arm is following a motion path. */
  get isMoving(): boolean {
    return this.path.length > 0;
  }

  /** Resolve once the arm has finished its current motion. */
  async waitUntilSettled(timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (this.isMoving && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(): Promise<void> {
    await this.adapter.connect();
    this.running = true;
    this.timer = setInterval(() => this.step(), 1000 / this.controlHz);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.adapter.disconnect();
  }

  async setTarget(position: Vec3, orientation?: [number, number, number]): Promise<boolean> {
    if (!this.enabled) return false;
    const res = this.solver.solve(
      { position, orientation: orientation ? toRotation(orientation) : undefined },
      { seed: this.q },
    );
    this.lastTarget = position;
    this.lastTargetSuccess = res.success;
    this.lastTargetError = res.error;
    // Always move toward the returned configuration. With `avoidSelfCollision`
    // the solver only returns a collision-free config, so the arm follows the
    // target and stops safely rather than freezing on an unreachable target.
    this.qGoal = res.q;
    this.startPath(this.q, this.qGoal);
    this.emit();
    return res.success;
  }

  async setJointState(q: JointState): Promise<string | null> {
    // Direct joint input (sliders, replay) passes the same safety check as IK
    // targets. Returns a rejection reason, or null when accepted.
    const check = this.solver.isConfigSafe(q);
    if (!check.safe) return check.reasons[0] ?? "unsafe configuration";
    this.qGoal = q.slice();
    this.path = [];
    // Ease to the requested state.
    this.startPath(this.q, this.qGoal);
    return null;
  }

  async setGripper(open: boolean): Promise<void> {
    this.gripperOpen = open;
    await this.adapter.setGripper(open);
    this.emit();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.adapter.setEnabled(enabled);
    this.emit();
  }

  async home(): Promise<void> {
    if (!this.enabled) return;
    const home = this.chain.joints.map((j) => (j.min + j.max) / 2);
    this.qGoal = home;
    this.startPath(this.q, home);
  }

  emergencyStop(): void {
    this.enabled = false;
    this.path = [];
    this.adapter.emergencyStop();
    this.emit();
  }

  private startPath(from: JointState, to: JointState): void {
    this.path = generateTrajectory(from, to, {
      velocityLimit: this.velocityLimit,
      timestep: this.tick,
    });
    // Cut the path at the first unsafe sample. Goal states are checked at the
    // entry points, but a straight joint-space path between two safe states
    // can still sweep through the base or dip below the floor mid-motion.
    for (let i = 0; i < this.path.length; i++) {
      if (!this.solver.isConfigSafe(this.path[i]!.q).safe) {
        this.path = this.path.slice(0, i);
        break;
      }
    }
    this.pathTime = 0;
    this.pathDuration = this.path.length ? this.path[this.path.length - 1]!.time : 0;
  }

  private step(): void {
    if (!this.running) return;

    if (this.path.length && this.enabled) {
      this.pathTime += this.tick;
      const qAtTime = this.samplePath(this.pathTime);
      this.q = qAtTime;
      void this.adapter.setJointAngles(qAtTime);
      if (this.pathTime >= this.pathDuration) this.path = [];
    }

    // Broadcast throttling.
    const frame = Math.floor(Date.now() / (1000 / this.broadcastHz));
    if (frame !== this.lastBroadcastFrame) {
      this.lastBroadcastFrame = frame;
      this.emit();
    }
  }

  private lastBroadcastFrame = 0;

  private samplePath(t: number): JointState {
    const path = this.path;
    if (path.length === 0) return this.qGoal.slice();
    // Binary search over the (monotonic) time samples so a 120 Hz tick is O(log n).
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
