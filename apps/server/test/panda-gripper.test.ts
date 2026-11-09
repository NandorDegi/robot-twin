import { describe, expect, it } from "vitest";
import { buildChain, defaultArmConfig } from "@robot/robot-config";
import { InverseKinematicsSolver, defaultPandaGripper, armSegments, isConfigSafe } from "@robot/kinematics";

const SAFE_OPTS = { eeOffset: [0, 0, 130], baseRadius: 55, gripper: defaultPandaGripper };

function make() {
  const chain = buildChain(defaultArmConfig());
  const solver = new InverseKinematicsSolver(chain, {
    positionTolerance: 1.0,
    eeOffset: [0, 0, 130],
    avoidSelfCollision: true,
    baseRadius: 55,
    gripper: defaultPandaGripper,
  });
  return { chain, solver };
}

const safe = (chain: ReturnType<typeof make>["chain"], q: number[]) =>
  isConfigSafe(chain, q, SAFE_OPTS).safe;

describe("panda gripper collision model", () => {
  const { chain, solver } = make();
  const neutral = () => chain.joints.map((j) => (j.min + j.max) / 2);

  it("replaces the tool capsule with a palm and two finger capsules (opt-in)", () => {
    const q = neutral();
    const base = armSegments(chain, q, {}).length;
    const withGripper = armSegments(chain, q, SAFE_OPTS).length;
    expect(withGripper).toBe(base + 2);
  });

  it("keeps the neutral pose safe when the gripper model is on", () => {
    expect(safe(chain, neutral())).toBe(true);
  });

  it("never returns an unsafe configuration for a target below the floor", () => {
    const res = solver.solve({ position: [200, -60, 60] }, { seed: neutral() });
    expect(safe(chain, res.q)).toBe(true);
  });

  it("never returns a configuration that sweeps through the base column", () => {
    const res = solver.solve({ position: [0, 300, 0] }, { seed: neutral() });
    expect(safe(chain, res.q)).toBe(true);
  });

  it("reaches a realistic board grab target and stays safe", () => {
    const res = solver.solve({ position: [260, 45, 0] }, { seed: neutral() });
    expect(safe(chain, res.q)).toBe(true);
    expect(res.error).toBeLessThan(2);
  });
});
