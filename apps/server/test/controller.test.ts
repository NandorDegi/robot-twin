import { describe, expect, it } from "vitest";
import { forwardKinematics, mat4TransformPoint } from "@robot/kinematics";
import { PANDA_READY_POSE, PANDA_TCP_OFFSET_MM, defaultChain } from "@robot/robot-config";
import { SimulatedAdapter, type MotionResult, type RobotAdapter } from "@robot/hardware";
import { RobotController } from "../src/controller";

async function makeController(): Promise<RobotController> {
  const adapter = new SimulatedAdapter(defaultChain.joints.length);
  const c = new RobotController(defaultChain, adapter, { controlHz: 200, simTimeScale: 20 });
  await c.start();
  c.setEnabled(true);
  return c;
}

const tcp = (q: number[]) => mat4TransformPoint(forwardKinematics(defaultChain, q).pose, [0, 0, PANDA_TCP_OFFSET_MM]) as [number, number, number];

/** A fake real (goal-based) adapter that records what it was sent. */
class FakeReal implements RobotAdapter {
  readonly name = "fake";
  readonly isReal = true;
  goals: number[][] = [];
  streamed = 0;
  q = [0.1, -0.7, 0, -2.3, 0, 1.6, 0.7];
  enabled = false;
  async connect() {}
  async disconnect() {}
  async setJointAngles() {
    this.streamed++;
  }
  async readJointAngles() {
    return this.q.slice();
  }
  async setGripper(): Promise<MotionResult> {
    return { ok: true };
  }
  setEnabled(e: boolean) {
    this.enabled = e;
  }
  emergencyStop() {
    this.enabled = false;
  }
  async moveToJoints(q: number[]): Promise<MotionResult> {
    this.goals.push(q.slice());
    this.q = q.slice();
    return { ok: true };
  }
}

describe("RobotController", () => {
  it("starts disabled", () => {
    const c = new RobotController(defaultChain, new SimulatedAdapter(7));
    expect(c.isEnabled).toBe(false);
  });

  it("reaches a reachable target and moves there", async () => {
    const c = await makeController();
    const q = [0.3, -0.3, 0.2, -2.0, 0.1, 1.9, 0.6];
    const r = await c.moveToPosition(tcp(q));
    expect(r.ok).toBe(true);
    const err = Math.hypot(...tcp(c.state).map((v, i) => v - tcp(q)[i]!));
    expect(err).toBeLessThan(2);
    await c.stop();
  });

  it("does not move when disabled", async () => {
    const c = await makeController();
    c.setEnabled(false);
    expect(await c.setTarget([300, 300, 0])).toBe(false);
    await c.stop();
  });

  it("does not execute an unreachable target", async () => {
    const c = await makeController();
    const before = c.state;
    expect(await c.setTarget([2000, 300, 0])).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.state).toEqual(before);
    await c.stop();
  });

  it("rejects joint goals outside the Panda limits", async () => {
    const c = await makeController();
    const q = [...PANDA_READY_POSE];
    q[5] = (250 * Math.PI) / 180; // Panda joint6 stops at 215 deg
    expect(await c.setJointState(q)).toMatch(/joint6/);
    q[5] = 1.5;
    q[3] = 0.1; // joint4 must stay negative
    expect(await c.setJointState(q)).toMatch(/joint4/);
    expect(await c.setJointState([0, 0, 0])).toMatch(/expected 7/);
    await c.stop();
  });

  it("rejects a goal whose path goes through the floor", async () => {
    const c = await makeController();
    const q = [0, 1.7, 0, -0.1, 0, 1.8, 0.785];
    expect(c.validateGoal(q)).not.toBeNull();
    expect(await c.setJointState(q)).not.toBeNull();
    await c.stop();
  });

  it("emergency stop disables", async () => {
    const c = await makeController();
    c.emergencyStop();
    expect(c.isEnabled).toBe(false);
    await c.stop();
  });

  it("with a real adapter: starts from the measured pose, sends goals only, never streams", async () => {
    const a = new FakeReal();
    const c = new RobotController(defaultChain, a, { controlHz: 200 });
    await c.start();
    expect(c.state).toEqual(a.q);
    expect(c.isEnabled).toBe(false);
    expect((await c.home()).ok).toBe(false); // disabled
    c.setEnabled(true);
    const r = await c.home();
    expect(r.ok).toBe(true);
    expect(a.goals).toEqual([[...PANDA_READY_POSE]]);
    await new Promise((res) => setTimeout(res, 50));
    expect(a.streamed).toBe(0);
    await c.stop();
  });

  it("with a real adapter: a failed motion disables and keeps a fault", async () => {
    const a = new FakeReal();
    a.moveToJoints = async () => ({ ok: false, error: "reflex" });
    const c = new RobotController(defaultChain, a);
    await c.start();
    c.setEnabled(true);
    const r = await c.home();
    expect(r.ok).toBe(false);
    expect(c.isEnabled).toBe(false);
    expect(c.faultReason).toMatch(/reflex/);
    expect((await c.home()).ok).toBe(false);
    await c.stop();
  });
});
