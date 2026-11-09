import { describe, expect, it } from "vitest";
import { SimulatedAdapter } from "../src/simulated";
import { FrankaAdapter } from "../src/franka";

describe("SimulatedAdapter", () => {
  it("stores joint state", async () => {
    const a = new SimulatedAdapter(4);
    await a.setJointAngles([0.1, 0.2, 0.3, 0.4]);
    expect(await a.readJointAngles()).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("emergency stop disables the arm", () => {
    const a = new SimulatedAdapter(2);
    a.setEnabled(true);
    a.emergencyStop();
    expect(a.isEnabled).toBe(false);
  });
});

/** A fake Franka bridge (same HTTP contract as apps/franka/franka_bridge.py). */
function fakeBridge() {
  const log: { path: string; body: any; lease: string | null }[] = [];
  const st = { q: [0, -0.78, 0, -2.35, 0, 1.57, 0.78], moving: false, lastMotion: { id: null as string | null, ok: null as boolean | null, error: "" }, leaseHeld: false };
  const f = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    log.push({ path, body, lease: headers["X-Lease"] ?? null });
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (path === "/state") return json({ connected: true, dryRun: true, q: st.q, moving: st.moving, lastMotion: st.lastMotion });
    if (path === "/lease") {
      if (st.leaseHeld) return json({ ok: false, error: "lease held" });
      st.leaseHeld = true;
      return json({ ok: true, token: "tok" });
    }
    if (path === "/move") {
      st.q = body.q;
      st.lastMotion = { id: body.id, ok: true, error: "" };
      return json({ ok: headers["X-Lease"] === "tok" });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;
  return { f, log, st };
}

describe("FrankaAdapter", () => {
  it("takes the single lease, sends whole goals with the lease, never streams", async () => {
    const b = fakeBridge();
    const a = new FrankaAdapter({ baseUrl: "http://127.0.0.1:3002", fetchImpl: b.f, heartbeatMs: 20 });
    await a.connect();
    expect(a.isReal).toBe(true);
    await expect(a.setJointAngles([0, 0, 0, 0, 0, 0, 0])).rejects.toThrow(/goal-based/);
    expect((await a.moveToJoints([0, 0, 0, -1, 0, 1, 0])).ok).toBe(false); // disabled
    a.setEnabled(true);
    const r = await a.moveToJoints([0, 0, 0, -1, 0, 1, 0]);
    expect(r.ok).toBe(true);
    const mv = b.log.filter((l) => l.path === "/move");
    expect(mv).toHaveLength(1);
    expect(mv[0]!.lease).toBe("tok");
    await new Promise((res) => setTimeout(res, 60));
    expect(b.log.some((l) => l.path === "/heartbeat")).toBe(true);
    await a.disconnect();
  });

  it("fails to connect when another process holds the lease", async () => {
    const b = fakeBridge();
    b.st.leaseHeld = true;
    const a = new FrankaAdapter({ fetchImpl: b.f });
    await expect(a.connect()).rejects.toThrow(/Only one process/);
  });
});
