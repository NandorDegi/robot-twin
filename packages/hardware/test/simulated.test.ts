import { describe, expect, it } from "vitest";
import { SimulatedAdapter } from "../src/simulated";
import { FrankaAdapter } from "../src/franka";

describe("SimulatedAdapter", () => {
  it("stores joint state", async () => {
    const a = new SimulatedAdapter(4);
    await a.setJointAngles([0.1, 0.2, 0.3, 0.4]);
    expect(await a.readJointAngles()).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("tracks grip and enable state", async () => {
    const a = new SimulatedAdapter(2);
    await a.setGripper(true);
    a.setEnabled(true);
    expect(a.gripOpen).toBe(true);
    expect(a.isEnabled).toBe(true);
  });

  it("emergency stop disables the arm", () => {
    const a = new SimulatedAdapter(2);
    a.setEnabled(true);
    a.emergencyStop();
    expect(a.isEnabled).toBe(false);
  });
});

describe("FrankaAdapter", () => {
  it("reports its name", () => {
    const a = new FrankaAdapter();
    expect(a.name).toBe("franka");
  });
});
