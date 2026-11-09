import type { InverseKinematicsSolver, JointState, KinematicChain, Vec3 } from "@robot/kinematics";
import { PANDA_READY_POSE, createPandaSolver } from "@robot/robot-config";

/**
 * Offline fallback so the twin is fully interactive even without the server.
 * Solves IK locally and moves the arm smoothly toward the result.
 */
export class LocalSim {
  private readonly solver: InverseKinematicsSolver;
  private goal: JointState;
  private current: JointState;

  constructor(private readonly chain: KinematicChain) {
    this.solver = createPandaSolver(chain);
    this.current = [...PANDA_READY_POSE];
    this.goal = this.current.slice();
  }

  setTarget(target: Vec3): boolean {
    const res = this.solver.solve({ position: target }, { seed: this.current });
    // Same rule as the server: a target that is not reached is not executed.
    if (res.success) this.goal = res.q;
    return res.success;
  }

  setJoint(q: JointState): boolean {
    // Direct joint input (sliders, replay) must pass the same safety check as
    // IK targets: no link below the floor, no self-collision.
    if (!this.solver.isConfigSafe(q).safe) return false;
    this.goal = q.slice();
    return true;
  }

  home(): void {
    this.goal = [...PANDA_READY_POSE];
  }

  /** Advance the interpolation. Returns the current smoothed joint state. */
  tick(dt: number, rate = 10): JointState {
    const alpha = 1 - Math.exp(-dt * rate);
    const next = this.current.map((v, i) => v + (this.goal[i]! - v) * alpha);
    // Hold at the last safe state: even between two safe endpoints a straight
    // joint-space path can sweep through the base or dip below the floor.
    if (!this.solver.isConfigSafe(next).safe) return this.current.slice();
    this.current = next;
    return this.current.slice();
  }

  get q(): JointState {
    return this.current.slice();
  }
}
