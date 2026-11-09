import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { defaultChain } from "@robot/robot-config";
import { SimulatedAdapter } from "@robot/hardware";
import { RobotController } from "../src/controller";
import { ChessSession } from "../src/chess";

let controller: RobotController;
let chess: ChessSession;

beforeEach(async () => {
  const adapter = new SimulatedAdapter(defaultChain.joints.length);
  controller = new RobotController(defaultChain, adapter, {
    controlHz: 120,
    velocityLimit: Math.PI * 6,
  });
  controller.setEnabled(true);
  await controller.start(); // run the motion loop so paths settle
  chess = new ChessSession(controller);
});

afterEach(async () => {
  await controller?.stop();
});

describe("ChessSession", () => {
  it("starts from the initial position", () => {
    expect(chess.fen).toContain("rnbqkbnr");
    expect(chess.turn).toBe("w");
    expect(chess.moveHistoryLast).toBe("");
  }, 10000);

  it("plays a legal SAN move and switches sides", async () => {
    chess.setOpponent(false); // isolate a single move
    const res = await chess.playSan("e4");
    expect(res.ok).toBe(true);
    expect(chess.turn).toBe("b");
    expect(chess.moveHistoryLast).toBe("e4");
  }, 10000);

  it("rejects an illegal SAN move", async () => {
    const res = await chess.playSan("e9");
    expect(res.ok).toBe(false);
  }, 10000);

  it("replies as black when the opponent is enabled", async () => {
    chess.setOpponent(true, 600);
    await chess.playSan("e4");
    expect(chess.turn).toBe("w");
    expect(chess.moveHistoryLast).not.toBe("e4");
  }, 10000);
});
