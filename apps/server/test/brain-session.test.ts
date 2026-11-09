import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultChain } from "@robot/robot-config";
import { SimulatedAdapter } from "@robot/hardware";
import { clientMessageSchema, type ServerMessage } from "@robot/protocol";
import { RobotController } from "../src/controller";
import { BrainSession } from "../src/brain-session";

let controller: RobotController;
let msgs: ServerMessage[];
let session: BrainSession;
let logPath: string;

beforeEach(async () => {
  controller = new RobotController(defaultChain, new SimulatedAdapter(defaultChain.joints.length), { controlHz: 120, velocityLimit: Math.PI * 8 });
  controller.setEnabled(true);
  await controller.start();
  msgs = [];
  logPath = join(mkdtempSync(join(tmpdir(), "brain-srv-")), "brain.jsonl");
  session = new BrainSession(controller, (m) => msgs.push(m), {
    BRAIN_INTUITION: "uniform",
    BRAIN_REFLECTION: "off",
    BRAIN_OBSERVER: "sim",
    BRAIN_LOG: logPath,
    BRAIN_POLL_MS: "10",
  });
});

afterEach(async () => {
  await session.stop();
  await controller.stop();
});

const events = () => msgs.filter((m): m is Extract<ServerMessage, { type: "brain" }> => m.type === "brain").map((m) => m.event);
async function until(pred: () => boolean, ms = 20000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("BrainSession (sim)", () => {
  it("validates brain commands in the protocol", () => {
    expect(clientMessageSchema.safeParse({ type: "brain", cmd: "start" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "brain", cmd: "fly" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "brain", cmd: "simFault", fault: { kind: "offset", to: "z9" } }).success).toBe(false);
  });

  it("human move -> the arm plays a verified reply on the controller", async () => {
    await session.handle({ type: "brain", cmd: "start" });
    await until(() => session.status().state === "awaiting-human");
    await session.handle({ type: "brain", cmd: "simHuman", uci: "e2e4" });
    await until(() => events().some((e) => e.type === "verified"));
    expect(session.status().moves).toHaveLength(2);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.verdict)).toEqual(["human-move", "ok"]);
  }, 30000);

  it("a dropped piece stops the loop and asks the human over WebSocket", async () => {
    await session.handle({ type: "brain", cmd: "start" });
    await until(() => session.status().state === "awaiting-human");
    await session.handle({ type: "brain", cmd: "simFault", fault: { kind: "drop" } });
    await session.handle({ type: "brain", cmd: "simHuman", uci: "d2d4" });
    await until(() => events().some((e) => e.type === "ask-human"));
    const ask = events().find((e) => e.type === "ask-human") as { ask: { message: string; options: string[] } };
    expect(ask.ask.message).toMatch(/I stopped \(mismatch\)/);
    expect(session.status().state).toBe("halted");
    await session.handle({ type: "brain", cmd: "resolve", action: "accept-prediction" });
    expect(session.status().state).toBe("awaiting-human");
  }, 30000);
});
