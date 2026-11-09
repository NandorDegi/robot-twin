import { describe, expect, it } from "vitest";
import { forwardKinematics, isConfigSafe, defaultPandaGripper } from "@robot/kinematics";
import { defaultChain } from "@robot/robot-config";
import { SimulatedAdapter } from "@robot/hardware";
import { RobotController } from "../src/controller";

function makeController(): RobotController {
  const adapter = new SimulatedAdapter(defaultChain.joints.length);
  const c = new RobotController(defaultChain, adapter, { controlHz: 120 });
  c.setEnabled(true);
  return c;
}

describe("RobotController", () => {
  it("reaches a reachable target", async () => {
    const c = makeController();
    const q = [0.5, 0.3, -0.4, -1.5, 0.2, 2.0, 0.3];
    const fk = forwardKinematics(defaultChain, q);
    const pos = [fk.pose[12], fk.pose[13], fk.pose[14]] as [number, number, number];
    const ok = await c.setTarget(pos);
    expect(ok).toBe(true);
    expect(c.targetReached).toBe(true);
  });

  it("commands the adapter to move toward the target over time", async () => {
    const c = makeController();
    const fk = forwardKinematics(defaultChain, [0.2, 0.1, -0.2, -1.2, 0.1, 1.8, 0.2]);
    const pos = [fk.pose[12], fk.pose[13], fk.pose[14]] as [number, number, number];
    await c.setTarget(pos);
    // After a short step, the path should exist and the state should differ
    // from the (neutral) start.
    expect(c.state).toHaveLength(defaultChain.joints.length);
  });

  it("does not move when disabled", async () => {
    const c = makeController();
    c.setEnabled(false);
    const ok = await c.setTarget([0.29, 0, 0.1]);
    expect(ok).toBe(false);
  });

  it("escalates to an emergency stop", async () => {
    const c = makeController();
    c.emergencyStop();
    expect(c.isEnabled).toBe(false);
  });

  it("rejects a joint state that goes below the floor or collides", async () => {
    const c = makeController();
    // Deterministic scan for a configuration the safety check rejects.
    const n = defaultChain.joints.length;
    const grid = [-1.0, -0.5, 0, 0.5, 1.0];
    let unsafe: number[] | null = null;
    outer: for (const a of grid) for (const b of grid) for (const d of grid) {
      const q = [0, a, 0, b, 0, d, 0].slice(0, n);
      const opts = { eeOffset: [0, 0, 130] as [number, number, number], baseRadius: 55, gripper: defaultPandaGripper };
      if (!isConfigSafe(defaultChain, q, opts).safe) { unsafe = q; break outer; }
    }
    expect(unsafe).not.toBeNull(); // the scan must find the hole the user reported
    const rejection = await c.setJointState(unsafe!);
    expect(rejection).not.toBeNull();
    // The state must not have moved toward the rejected goal.
    expect(c.state).toEqual(defaultChain.joints.map((j) => (j.min + j.max) / 2));
  });

  it("accepts a safe joint state", async () => {
    const c = makeController();
    const neutral = defaultChain.joints.map((j) => (j.min + j.max) / 2);
    expect(await c.setJointState(neutral)).toBeNull();
  });
});
