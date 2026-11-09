import type { JointState, TrajectoryPoint } from "./types";

/**
 * Generate a smooth joint-space trajectory between two joint states.
 *
 * Uses a quintic (5th-order) polynomial per joint: smooth position, velocity
 * and acceleration at both endpoints. The duration is chosen so that no joint
 * exceeds its velocity or acceleration limits.
 *
 * The output is a sampled sequence of TrajectoryPoint.
 */
export function generateTrajectory(
  from: JointState,
  to: JointState,
  options: {
    /** rad/s, one value for all joints or one per joint. */
    velocityLimit?: number | readonly number[];
    /** rad/s^2, one value for all joints or one per joint. */
    accelerationLimit?: number | readonly number[];
    /** rad/s^3, one value for all joints or one per joint. Optional. */
    jerkLimit?: number | readonly number[];
    timestep?: number;
  } = {},
): TrajectoryPoint[] {
  const per = (v: number | readonly number[] | undefined, i: number, dflt: number): number => {
    const x = v === undefined ? dflt : typeof v === "number" ? v : (v[i] ?? dflt);
    if (!(x > 0) || !Number.isFinite(x)) throw new Error(`Trajectory: limit must be > 0 (joint ${i}: ${x})`);
    return x;
  };
  const timestep = options.timestep ?? 0.01;

  if (from.length !== to.length) {
    throw new Error(`Trajectory: mismatched joint counts ${from.length} vs ${to.length}`);
  }

  // Estimate a duration that respects velocity and acceleration limits.
  // For a quintic with zero endpoint velocity, the peak velocity scales with
  // delta / duration, so we bound duration from both the velocity and the
  // acceleration limit and add a small safety margin.
  let duration = 0;
  for (let i = 0; i < from.length; i++) {
    const delta = Math.abs(to[i] - from[i]);
    if (delta < 1e-9) continue;
    // Peak values of the quintic: v = 1.875 d/T, a = 5.774 d/T^2, j = 60 d/T^3.
    const tByVel = (1.875 * delta) / per(options.velocityLimit, i, Math.PI);
    const tByAcc = Math.sqrt((5.774 * delta) / per(options.accelerationLimit, i, 2 * Math.PI));
    const tByJerk = options.jerkLimit === undefined ? 0 : Math.cbrt((60 * delta) / per(options.jerkLimit, i, 1));
    duration = Math.max(duration, tByVel, tByAcc, tByJerk);
  }
  duration = Math.max(duration, 0.5);

  const points: TrajectoryPoint[] = [];
  for (let t = 0; t < duration; t += timestep) {
    const s = t / duration;
    const q: JointState = from.map((f, i) => quintic(s, f, to[i]));
    points.push({ time: t, q });
  }
  // Guarantee an exact endpoint at s = 1.
  points.push({ time: duration, q: from.map((f, i) => quintic(1, f, to[i])) });
  return points;
}

/** Quintic interpolation with zero endpoint velocity and acceleration. */
function quintic(s: number, a: number, b: number): number {
  // s in [0,1]; returns a + (b-a)*smooth(s)
  const s2 = s * s;
  const s3 = s2 * s;
  const s4 = s3 * s;
  const s5 = s4 * s;
  const smooth = 10 * s3 - 15 * s4 + 6 * s5;
  return a + (b - a) * smooth;
}
