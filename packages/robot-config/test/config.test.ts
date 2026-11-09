import { describe, expect, it } from "vitest";
import { buildChain, defaultArmConfig } from "../src/config";

describe("robot-config", () => {
  it("buildChain creates one joint per config joint", () => {
    const cfg = defaultArmConfig();
    const chain = buildChain(cfg);
    expect(chain.joints.length).toBe(cfg.joints.length);
    expect(chain.name).toBe(cfg.name);
  });

  it("keeps joint limits in degrees -> radians", () => {
    const cfg = defaultArmConfig();
    const chain = buildChain(cfg);
    const base = chain.joints[0]!;
    expect(base.min).toBeCloseTo((Math.min(cfg.joints[0]!.minDeg, cfg.joints[0]!.maxDeg) * Math.PI) / 180, 6);
    expect(base.max).toBeCloseTo((Math.max(cfg.joints[0]!.minDeg, cfg.joints[0]!.maxDeg) * Math.PI) / 180, 6);
  });

  it("resolves axis names to unit vectors", () => {
    const chain = buildChain(defaultArmConfig());
    expect(chain.joints[0]!.axis[2]).toBeCloseTo(1, 6);
  });
});

describe("Panda (FER) limits", () => {
  it("matches the official FER position limits (minus the margin)", async () => {
    const { PANDA_LIMITS, PANDA_LIMIT_MARGIN_DEG } = await import("../src/config");
    const chain = buildChain(defaultArmConfig());
    const m = (PANDA_LIMIT_MARGIN_DEG * Math.PI) / 180;
    chain.joints.forEach((j, i) => {
      expect(j.min).toBeCloseTo(PANDA_LIMITS.qMin[i]! + m, 6);
      expect(j.max).toBeCloseTo(PANDA_LIMITS.qMax[i]! - m, 6);
    });
    // joint6 of the Panda stops at 215 deg (FR3 values must not leak in).
    expect(PANDA_LIMITS.qMax[5]).toBeCloseTo(3.7525, 4);
    expect(PANDA_LIMITS.qMax[1]).toBeCloseTo(1.7628, 4);
  });

  it("the ready pose is inside the limits", async () => {
    const { PANDA_READY_POSE } = await import("../src/config");
    const chain = buildChain(defaultArmConfig());
    PANDA_READY_POSE.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(chain.joints[i]!.min);
      expect(v).toBeLessThanOrEqual(chain.joints[i]!.max);
    });
  });
});
