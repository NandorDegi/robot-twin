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
