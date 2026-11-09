import {
  Vec3,
  mat4ToMat3,
  mat4TransformPoint,
  rotationVector,
  vec3Cross,
  vec3Length,
} from "./math3d";
import { forwardKinematics } from "./fk";
import { isConfigSafe as checkConfigSafe } from "./collision";
import type {
  ForwardKinematics,
  FunctionalIK,
  GripperConfig,
  IKResult,
  IKSolverOptions,
  IKTarget,
  JointState,
  KinematicChain,
} from "./types";

/**
 * Inverse kinematics via Levenberg-Marquardt (damped least squares).
 *
 * Solves for joint angles that place the end-effector at `target.position`
 * (and, if given, at `target.orientation`). Uses the analytic geometric
 * Jacobian from the forward kinematics, clamps to joint limits, and supports
 * warm-starting from a seed (previous solution) for fast convergence.
 */
export class InverseKinematicsSolver implements FunctionalIK {
  private readonly positionTolerance: number;
  private readonly orientationTolerance: number;
  private readonly maxIterations: number;
  private readonly damping: number;
  private readonly groundFloor: number;
  private readonly groundUpAxis: number;
  private readonly groundWeight: number;
  private readonly eeOffset: Vec3;
  private readonly avoidSelfCollision: boolean;
  private readonly linkRadii: number[] | undefined;
  private readonly clearance: number;
  private readonly baseRadius: number | undefined;
  private readonly baseObstacleSkip: number | undefined;
  private readonly restarts: number;
  private readonly gripper: GripperConfig | undefined;

  constructor(private readonly chain: KinematicChain, options: IKSolverOptions = {}) {
    this.positionTolerance = options.positionTolerance ?? 1e-3;
    this.orientationTolerance = options.orientationTolerance ?? 1e-3;
    this.maxIterations = options.maxIterations ?? 50;
    this.damping = options.damping ?? 0.01;
    this.groundFloor = options.groundFloor ?? 0;
    this.groundUpAxis = options.groundUpAxis ?? 1;
    this.groundWeight = options.groundWeight ?? 20;
    this.eeOffset = options.eeOffset ?? [0, 0, 0];
    this.avoidSelfCollision = options.avoidSelfCollision ?? false;
    this.linkRadii = options.linkRadii;
    this.clearance = options.clearance ?? 0;
    this.baseRadius = options.baseRadius;
    this.baseObstacleSkip = options.baseObstacleSkip;
    this.restarts = options.restarts ?? 3;
    this.gripper = options.gripper;
  }

  solve(target: IKTarget, options: IKSolverOptions = {}): IKResult {
    const avoid = options.avoidSelfCollision ?? this.avoidSelfCollision;
    const seed = options.seed ?? (this.chain.joints.length ? this.currentSeed() : []);
    if (!avoid) return this.solveFromSeed(target, seed, options);

    const seeds = this.collectSeeds(seed, options.restarts ?? this.restarts);

    // Solve from each seed, keep only the collision-free results.
    const safeCandidates: IKResult[] = [];
    for (const s of seeds) {
      const res = this.solveFromSeed(target, s, options);
      if (this.isConfigSafe(res.q, options).safe) safeCandidates.push(res);
    }

    // Pick the safe result that reaches the target and is closest to the
    // current pose. Preferring closeness avoids the arm folding or jumping
    // between IK branches. If none reaches, the closest safe one still gives
    // the arm a sensible approach instead of freezing.
    let best: IKResult | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const c of safeCandidates) {
      const score = (c.success ? 0 : 1e6) + jointSpaceDist(c.q, seed) + c.error * 1e-3;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) {
      return { ...best, message: best.success ? undefined : "safe configuration (target not reached)" };
    }

    // No seed produced a safe configuration. If the current pose is already
    // safe, hold it rather than risk a collision. If it is NOT safe (for
    // example the arm is under the plane), find a nearby safe pose so the arm
    // can escape instead of being stuck.
    if (this.isConfigSafe(seed, options).safe) {
      return {
        success: false,
        q: this.clampToLimits(seed.slice()),
        error: Number.POSITIVE_INFINITY,
        orientationError: 0,
        iterations: 0,
        analytic: false,
        message: "no safe configuration reaches the target",
      };
    }
    const escape = this.findSafeNear(seed, options);
    return {
      success: false,
      q: escape,
      error: Number.POSITIVE_INFINITY,
      orientationError: 0,
      iterations: 0,
      analytic: false,
      message: "escaped a colliding configuration",
    };
  }

  /**
   * Find a safe configuration close to `seed`, used to escape a colliding
   * start state (for example the arm folded under the floor). It jiggles each
   * joint and falls back to the neutral pose.
   */
  private findSafeNear(seed: JointState, options: IKSolverOptions): JointState {
    const n = this.chain.joints.length;
    const home = this.currentSeed();
    const candidates: JointState[] = [this.clampToLimits(home.slice())];
    for (let i = 0; i < n; i++) {
      const j = this.chain.joints[i]!;
      const range = j.max - j.min;
      for (const dir of [1, -1]) {
        const s = seed.slice();
        s[i] = this.clampToLimits([seed[i]! + dir * range * 0.15])[0];
        candidates.push(s);
      }
    }
    let best: JointState | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      if (!this.isConfigSafe(c, options).safe) continue;
      const d = jointSpaceDist(c, seed);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best ?? this.clampToLimits(home.slice());
  }

  /**
   * True when a configuration is collision-free and above the ground plane.
   * Uses the solver's configured radii/clearance/floor.
   */
  isConfigSafe(
    q: JointState,
    options: IKSolverOptions = {},
  ): { safe: boolean; reasons: string[] } {
    return checkConfigSafe(this.chain, q, {
      linkRadii: options.linkRadii ?? this.linkRadii,
      clearance: options.clearance ?? this.clearance,
      groundFloor: options.groundFloor ?? this.groundFloor,
      groundUpAxis: options.groundUpAxis ?? this.groundUpAxis,
      eeOffset: options.eeOffset ?? this.eeOffset,
      baseRadius: options.baseRadius ?? this.baseRadius,
      baseObstacleSkip: options.baseObstacleSkip ?? this.baseObstacleSkip,
      gripper: options.gripper ?? this.gripper,
    });
  }

  /**
   * Levenberg-Marquardt solve from a single seed. The arm's redundancy often
   * has several valid postures for one target; `solve` retries a few seeds so a
   * collision-avoiding posture is found when the warm-started seed leads the
   * solver into a self-colliding local minimum.
   */
  private solveFromSeed(target: IKTarget, seed: JointState, options: IKSolverOptions): IKResult {
    const q: JointState = this.clampToLimits(seed.slice());
    const withOrientation = target.orientation !== undefined;

    const tol = options.positionTolerance ?? this.positionTolerance;
    const oTol = options.orientationTolerance ?? this.orientationTolerance;

    // Never command a target below the ground plane.
    const targetPos: Vec3 = [target.position[0], target.position[1], target.position[2]];
    targetPos[this.groundUpAxis] = Math.max(targetPos[this.groundUpAxis], this.groundFloor);

    const n = this.chain.joints.length;
    let best: IKResult | null = null;

    for (let iter = 0; iter < (options.maxIterations ?? this.maxIterations); iter++) {
      const fk = forwardKinematics(this.chain, q);
      // The end-effector reference can be an offset in the tool frame (e.g. the
      // gripper tip) rather than the tool-frame origin (the wrist).
      const eePos =
        this.eeOffset[0] === 0 && this.eeOffset[1] === 0 && this.eeOffset[2] === 0
          ? ([fk.pose[12], fk.pose[13], fk.pose[14]] as Vec3)
          : mat4TransformPoint(fk.pose, this.eeOffset);

      const posError = vec3Length([
        targetPos[0] - eePos[0],
        targetPos[1] - eePos[1],
        targetPos[2] - eePos[2],
      ]);
      let orientError = 0;
      if (withOrientation) {
        const curR = mat4ToMat3(fk.pose);
        const rv = rotationVector(curR, target.orientation!);
        orientError = vec3Length(rv);
      }

      // Record the best-so-far.
      const err = Math.max(posError, withOrientation ? orientError : 0);
      if (!best || err < best.error) {
        best = {
          success: posError <= tol && (!withOrientation || orientError <= oTol),
          q: q.slice(),
          error: posError,
          orientationError: orientError,
          iterations: iter,
          analytic: false,
        };
      }

      if (posError <= tol && (!withOrientation || orientError <= oTol)) break;

      // Build the base task (position + optional orientation).
      const baseRows = withOrientation ? 6 : 3;
      const e = new Float64Array(baseRows);
      e[0] = targetPos[0] - eePos[0];
      e[1] = targetPos[1] - eePos[1];
      e[2] = targetPos[2] - eePos[2];
      if (withOrientation) {
        const curR = mat4ToMat3(fk.pose);
        const rv = rotationVector(curR, target.orientation!);
        e[3] = rv[0];
        e[4] = rv[1];
        e[5] = rv[2];
      }
      const J = buildJacobianForPoint(fk, eePos, n, withOrientation);

      // Ground constraint: push every below-floor arm point back up.
      const ground: { row: Float64Array; res: number }[] = [];
      const floor = this.groundFloor;
      const up = this.groundUpAxis;
      const points: { p: Vec3; attach: number }[] = [];
      points.push({ p: eePos, attach: n - 1 });
      for (let i = 0; i < n; i++) points.push({ p: fk.jointOrigins[i], attach: i - 1 });
      for (const pt of points) {
        if (pt.p[up] < floor - 1e-6) {
          const row = pointJacobianRow(fk, pt.p, pt.attach, n, up);
          for (let j = 0; j < n; j++) row[j] *= this.groundWeight;
          ground.push({ row, res: (floor - pt.p[up]) * this.groundWeight });
        }
      }

      const total = baseRows + ground.length;
      const eAug = new Float64Array(total);
      eAug.set(e, 0);
      const JAug = new Float64Array(total * n);
      JAug.set(J.subarray(0, baseRows * n), 0);
      for (let g = 0; g < ground.length; g++) {
        eAug[baseRows + g] = ground[g]!.res;
        JAug.set(ground[g]!.row, (baseRows + g) * n);
      }

      const dq = solveDampedLeastSquares(JAug, total, eAug, this.damping);

      // Clamp the step to joint limits and to a sane per-iteration magnitude.
      const maxStep = 0.3;
      for (let i = 0; i < q.length; i++) {
        const step = Math.abs(dq[i]) > maxStep ? Math.sign(dq[i]) * maxStep : dq[i];
        q[i] = this.clampToLimits([q[i] + step])[0];
      }
    }

    return best ?? {
      success: false,
      q,
      error: Number.POSITIVE_INFINITY,
      orientationError: 0,
      iterations: 0,
      analytic: false,
      message: "IK did not converge",
    };
  }

  /** Candidate seeds, warm-started seed first, then elbow-up/down variants. */
  private collectSeeds(seed: JointState, restarts: number): JointState[] {
    const n = this.chain.joints.length;
    const mid = this.currentSeed();
    const seeds: JointState[] = [];
    if (seed.length === n) seeds.push(seed.slice());
    seeds.push(mid.slice());
    for (let k = 0; k < restarts; k++) {
      const s: JointState = mid.slice();
      for (let i = 0; i < n; i++) {
        const j = this.chain.joints[i]!;
        const half = (j.max - j.min) / 2;
        const dir = (i % 2 === 0 ? 1 : -1) * (k % 2 === 0 ? 1 : -1);
        s[i] = this.clampToLimits([mid[i] + dir * half * 0.7])[0];
      }
      seeds.push(s);
    }
    // Wrist variants. A position-only solve does not control the converged
    // finger direction, and with the hand attached some directions collide
    // with the forearm. Offsetting seeds on joints 5 and 6 gives the solver
    // different approach angles to converge to. Only for chains with wrist
    // joints beyond the elbow (the 7-DOF Panda arm).
    if (n > 5) {
      for (const a of [-1, 1]) {
        for (const b of [-1, 1]) {
          const s: JointState = mid.slice();
          s[4] = this.clampToLimits([mid[4]! + a * 1.0])[0]!;
          s[5] = this.clampToLimits([mid[5]! + b * 1.0])[0]!;
          seeds.push(s);
        }
      }
    }
    return seeds;
  }

  /** Neutral seed: the midpoint of each joint's range. */
  private currentSeed(): JointState {
    return this.chain.joints.map((j) => (j.min + j.max) / 2);
  }

  private clampToLimits(q: JointState): JointState {
    return q.map((v, i) => {
      const j = this.chain.joints[i];
      if (!j) return v;
      const lo = Math.min(j.min, j.max);
      const hi = Math.max(j.min, j.max);
      return Math.max(lo, Math.min(hi, v));
    });
  }
}

/** Euclidean distance between two joint states in joint space (radians). */
function jointSpaceDist(a: JointState, b: JointState): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Solve (J^T J + lambda^2 I) delta = J^T e for delta.
 *
 * J is a rows x n column-major flat array where J[row * n + col].
 */
function solveDampedLeastSquares(  J: Float64Array,
  rows: number,
  e: Float64Array,
  damping: number,
): Float64Array {
  const n = J.length / rows;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);

  const lam2 = damping * damping;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let r = 0; r < rows; r++) s += J[r * n + i] * J[r * n + j];
      A[i * n + j] = s;
    }
    A[i * n + i] += lam2;
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let r = 0; r < rows; r++) s += J[r * n + i] * e[r];
    b[i] = s;
  }

  return solveLinear(A, b, n);
}

/**
 * Position (+ optional orientation) Jacobian for an arbitrary world point that
 * is fixed to the arm (all joints move it).
 */
function buildJacobianForPoint(
  fk: ForwardKinematics,
  p: Vec3,
  n: number,
  withOrientation: boolean,
): Float64Array {
  const rows = withOrientation ? 6 : 3;
  const J = new Float64Array(rows * n);
  for (let i = 0; i < n; i++) {
    const a = fk.jointAxes[i];
    const o = fk.jointOrigins[i];
    const pv = vec3Cross(a, [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
    J[0 * n + i] = pv[0];
    J[1 * n + i] = pv[1];
    J[2 * n + i] = pv[2];
    if (withOrientation) {
      J[3 * n + i] = a[0];
      J[4 * n + i] = a[1];
      J[5 * n + i] = a[2];
    }
  }
  return J;
}

/**
 * Jacobian row (1 x n) for the vertical coordinate of a point fixed in link
 * `attach`. For joint j <= attach, d(p)/dq_j = a_j x (p - o_j); joints after
 * `attach` do not move the point.
 */
function pointJacobianRow(
  fk: ForwardKinematics,
  p: Vec3,
  attach: number,
  n: number,
  up: number,
): Float64Array {
  const row = new Float64Array(n);
  if (attach < 0 || n === 0) return row;
  for (let j = 0; j <= attach && j < n; j++) {
    const a = fk.jointAxes[j];
    const o = fk.jointOrigins[j];
    const cross = vec3Cross(a, [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
    row[j] = cross[up];
  }
  return row;
}

/** Gaussian elimination with partial pivoting. Solves A x = b. */
function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array {
  // Build augmented matrix.
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + n] = b[i];
  }

  for (let col = 0; col < n; col++) {
    // Pivot.
    let piv = col;
    let maxAbs = Math.abs(M[col * (n + 1) + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * (n + 1) + col]);
      if (v > maxAbs) { maxAbs = v; piv = r; }
    }
    if (maxAbs < 1e-12) continue; // singular; leave as is
    if (piv !== col) {
      for (let c = 0; c <= n; c++) {
        const tmp = M[col * (n + 1) + c];
        M[col * (n + 1) + c] = M[piv * (n + 1) + c];
        M[piv * (n + 1) + c] = tmp;
      }
    }
    // Eliminate.
    const pivot = M[col * (n + 1) + col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r * (n + 1) + col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        M[r * (n + 1) + c] -= factor * M[col * (n + 1) + c];
      }
    }
  }

  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pivot = M[i * (n + 1) + i];
    x[i] = Math.abs(pivot) > 1e-12 ? M[i * (n + 1) + n] / pivot : 0;
  }
  return x;
}
