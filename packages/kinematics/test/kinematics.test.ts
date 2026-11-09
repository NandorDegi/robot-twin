import { describe, expect, it } from "vitest";
import { forwardKinematics } from "../src/fk";
import { InverseKinematicsSolver } from "../src/ik";
import { generateTrajectory } from "../src/trajectory";
import { mat4TranslationOf, mat4TransformDir, mat4RotX, mat4RotY, mat4RotZ, vec3Length } from "../src/math3d";
import type { Vec3 } from "../src/types";
import { makeTestArm } from "./arm";

function eePosition(chain: ReturnType<typeof makeTestArm>, q: number[]): Vec3 {
  return mat4TranslationOf(forwardKinematics(chain, q).pose);
}

describe("rotation matrices", () => {
  it("RotX(90°) maps +Y to +Z and +Z to -Y", () => {
    const rx = mat4RotX(Math.PI / 2);
    const y = mat4TransformDir(rx, [0, 1, 0]);
    const z = mat4TransformDir(rx, [0, 0, 1]);
    expect(y[0]).toBeCloseTo(0, 6);
    expect(y[1]).toBeCloseTo(0, 6);
    expect(y[2]).toBeCloseTo(1, 6);
    expect(z[1]).toBeCloseTo(-1, 6);
  });

  it("RotY(90°) maps +Z to +X", () => {
    const ry = mat4RotY(Math.PI / 2);
    const v = mat4TransformDir(ry, [0, 0, 1]);
    expect(v[0]).toBeCloseTo(1, 6);
    expect(v[2]).toBeCloseTo(0, 6);
  });

  it("RotZ(90°) maps +X to +Y", () => {
    const rz = mat4RotZ(Math.PI / 2);
    const v = mat4TransformDir(rz, [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(1, 6);
  });
});

describe("forward kinematics", () => {
  const chain = makeTestArm();

  it("joint axes of the base are world Z", () => {
    const fk = forwardKinematics(chain, [0, 0, 0, 0]);
    expect(vec3Length(mat4TransformDir(fk.frames[1], [0, 0, 1]))).toBeGreaterThan(0.99);
  });

  it("a zero configuration has the expected end-effector position", () => {
    const p = eePosition(chain, [0, 0, 0, 0]);
    // base height 0.04 + upper 0.14 + forearm 0.13 + tool 0.02, along +X
    expect(p[0]).toBeCloseTo(0.29, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(0.04, 5);
  });

  it("throws on a wrong number of joint values", () => {
    expect(() => forwardKinematics(chain, [0, 0, 0])).toThrow();
  });
});

describe("inverse kinematics (DLS)", () => {
  const chain = makeTestArm();
  const solver = new InverseKinematicsSolver(chain, {
    positionTolerance: 1e-4,
    maxIterations: 80,
    damping: 0.01,
  });

  it("reaches a target near the arm's nominal reach", () => {
    const q = [0.6, 0.5, -0.4, 0.2];
    const target = eePosition(chain, q);
    const res = solver.solve({ position: target });
    expect(res.success).toBe(true);
    const reached = eePosition(chain, res.q);
    expect(vec3Length([reached[0] - target[0], reached[1] - target[1], reached[2] - target[2]]))
      .toBeLessThan(1e-3);
  });

  it("respects joint limits", () => {
    const q = [0.6, 0.5, -0.4, 0.2];
    const target = eePosition(chain, q);
    const res = solver.solve({ position: target });
    for (let i = 0; i < res.q.length; i++) {
      const j = chain.joints[i]!;
      expect(res.q[i]).toBeGreaterThanOrEqual(Math.min(j.min, j.max) - 1e-6);
      expect(res.q[i]).toBeLessThanOrEqual(Math.max(j.min, j.max) + 1e-6);
    }
  });

  it("reports fail for an unreachable target", () => {
    const res = solver.solve({ position: [10, 10, 10] });
    expect(res.success).toBe(false);
  });

  it("converges quickly from a warm start", () => {
    const q = [0.6, 0.5, -0.4, 0.2];
    const target = eePosition(chain, q);
    const res = solver.solve({ position: target }, { seed: [0.5, 0.4, -0.3, 0.1] });
    expect(res.iterations).toBeLessThan(30);
  });

  it("never lets the end-effector go below the ground plane", () => {
    const s = new InverseKinematicsSolver(chain, {
      positionTolerance: 1e-3,
      damping: 0.01,
      groundFloor: 0,
      groundUpAxis: 1,
      groundWeight: 20,
    });
    // Request a target far below the floor.
    const res = s.solve({ position: [0.2, -0.5, 0.05] });
    const reached = eePosition(chain, res.q);
    expect(reached[1]).toBeGreaterThanOrEqual(-1e-3);
  });
});

describe("trajectory", () => {
  it("starts and ends exactly at the requested states", () => {
    const from = [0, 0, 0, 0];
    const to = [0.5, 0.3, -0.2, 0.4];
    const pts = generateTrajectory(from, to, { timestep: 0.02 });
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    expect(first.q).toEqual(from);
    expect(last.q[0]).toBeCloseTo(to[0]!, 5);
    expect(last.q[1]).toBeCloseTo(to[1]!, 5);
    expect(last.q[2]).toBeCloseTo(to[2]!, 5);
    expect(last.q[3]).toBeCloseTo(to[3]!, 5);
  });

  it("produces a monotonic, bounded path", () => {
    const from = [0, 0, 0, 0];
    const to = [0.5, 0.3, -0.2, 0.4];
    const pts = generateTrajectory(from, to, { timestep: 0.01 });
    for (let i = 1; i < pts.length; i++) {
      for (let j = 0; j < 4; j++) {
        const now = pts[i]!.q[j]!;
        const prev = pts[i - 1]!.q[j]!;
        const delta = now - prev;
        const dir = Math.sign(to[j]! - from[j]!);
        // Each joint moves monotonically toward its target, and stays bounded.
        expect(now).toBeGreaterThanOrEqual(Math.min(from[j]!, to[j]!) - 1e-6);
        expect(now).toBeLessThanOrEqual(Math.max(from[j]!, to[j]!) + 1e-6);
        if (dir !== 0) expect(delta * dir).toBeGreaterThanOrEqual(-1e-6);
      }
    }
  });
});
