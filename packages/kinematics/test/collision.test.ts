import { describe, expect, it } from "vitest";
import { mat4Identity, mat4Translation } from "../src/math3d";
import type { KinematicChain } from "../src/types";
import { armSegments, defaultPandaGripper, isConfigSafe, segmentDistance } from "../src/collision";
import { InverseKinematicsSolver } from "../src/ik";

/**
 * A planar 3-link arm in the X-Y plane (Y up), used to test the floor and
 * self-collision checks. Units are metres. The base is mounted at Y=0.2.
 */
function verticalArm(): KinematicChain {
  return {
    name: "collision-arm",
    base: mat4Translation(0, 0.2, 0),
    joints: [
      { name: "j0", min: -Math.PI, max: Math.PI, axis: [0, 0, 1], origin: mat4Identity() },
      { name: "j1", min: -Math.PI, max: Math.PI, axis: [0, 0, 1], origin: mat4Translation(0.3, 0, 0) },
      { name: "j2", min: -Math.PI, max: Math.PI, axis: [0, 0, 1], origin: mat4Translation(0.25, 0, 0) },
    ],
    tool: mat4Translation(0.1, 0, 0),
  };
}

const RADII = [0.03, 0.03, 0.03, 0.03];

describe("segmentDistance", () => {
  it("returns 0 for intersecting segments", () => {
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [0.5, -1, 0], [0.5, 1, 0])).toBeCloseTo(0, 9);
  });

  it("returns the gap for parallel, separated segments", () => {
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0])).toBeCloseTo(1, 9);
  });

  it("returns the end-to-end distance when the segments do not overlap", () => {
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0])).toBeCloseTo(1, 9);
  });
});

describe("isConfigSafe", () => {
  const chain = verticalArm();
  const opts = { linkRadii: RADII, groundFloor: 0, groundUpAxis: 1 };

  it("accepts a straight, raised arm", () => {
    expect(isConfigSafe(chain, [0, 0, 0], opts).safe).toBe(true);
  });

  it("rejects an arm folded below the floor", () => {
    const r = isConfigSafe(chain, [-Math.PI / 2, 0, 0], opts);
    expect(r.safe).toBe(false);
    expect(r.reasons.some((x) => x.includes("below floor"))).toBe(true);
  });

  it("rejects an arm folded back on itself", () => {
    const r = isConfigSafe(chain, [0, Math.PI, 0], opts);
    expect(r.safe).toBe(false);
    expect(r.reasons.some((x) => x.includes("collide"))).toBe(true);
  });

  it("replaces the tool capsule with palm and finger capsules (opt-in)", () => {
    const q = [0, 0, 0];
    const base = armSegments(chain, q, { linkRadii: RADII }).length;
    const withGripper = armSegments(chain, q, { linkRadii: RADII, gripper: defaultPandaGripper }).length;
    // The hand replaces the thin tool capsule with a palm capsule plus two
    // finger capsules, so the net count increases by two.
    expect(withGripper).toBe(base + 2);
  });
});

describe("collision-avoiding solve", () => {
  const chain = verticalArm();
  const solver = new InverseKinematicsSolver(chain, {
    avoidSelfCollision: true,
    positionTolerance: 1e-3,
    groundFloor: 0,
    groundUpAxis: 1,
    linkRadii: RADII,
  });
  const safety = (q: number[]) =>
    isConfigSafe(chain, q, { linkRadii: RADII, groundFloor: 0, groundUpAxis: 1 }).safe;

  it("reaches a reachable, safe target", () => {
    const res = solver.solve({ position: [0.4, 0.2, 0] }, { seed: [0, 0, 0] });
    expect(res.success).toBe(true);
    expect(safety(res.q)).toBe(true);
  });

  it("never returns an unsafe configuration for a target below the floor", () => {
    const res = solver.solve({ position: [0.4, -0.1, 0] }, { seed: [0, 0, 0] });
    expect(res.success).toBe(false);
    expect(safety(res.q)).toBe(true);
  });

  it("recovers to a safe configuration from a colliding start", () => {
    const colliding = [0, Math.PI, 0]; // folds back on itself
    expect(safety(colliding)).toBe(false);
    const res = solver.solve({ position: [0.4, 0.35, 0] }, { seed: colliding });
    expect(safety(res.q)).toBe(true);
  });
});
