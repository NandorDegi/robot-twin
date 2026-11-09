import {
  InverseKinematicsSolver,
  defaultPandaGripper,
  type JointState,
  type KinematicChain,
  type Vec3,
} from "@robot/kinematics";

/**
 * Offline fallback so the twin is fully interactive even without the server.
 * Solves IK locally and moves the arm smoothly toward the result.
 */
export class LocalSim {
  private readonly solver: InverseKinematicsSolver;
  private goal: JointState;
  private current: JointState;

  constructor(private readonly chain: KinematicChain) {
    this.solver = new InverseKinematicsSolver(chain, {
      positionTolerance: 1.0,
      eeOffset: [0, 0, 130],
      avoidSelfCollision: true,
      baseRadius: 55,
      gripper: defaultPandaGripper,
    });
    this.current = chain.joints.map((j) => (j.min + j.max) / 2);
    this.goal = this.current.slice();
  }

  setTarget(target: Vec3): boolean {
    const res = this.solver.solve({ position: target }, { seed: this.current });
    // Always follow the result. `solve` only returns a collision-free
    // configuration, so the arm moves toward it or safely holds.
    this.goal = res.q;
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
    this.goal = this.chain.joints.map((j) => (j.min + j.max) / 2);
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
