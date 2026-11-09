import { describe, expect, it } from "vitest";
import { defaultChain } from "@robot/robot-config";
import { SimulatedAdapter } from "@robot/hardware";
import { applyMove, initialPosition, occupancyOf, parseSan, type Occupancy, type Position } from "@robot/chess";
import { RobotController } from "../src/controller";
import { ChessSession } from "../src/chess";
import { EngineDecider, HttpDecider, type MoveDecider } from "../src/decider";
import type { BoardObserver, Observation } from "../src/observer";

async function setup(observer: BoardObserver | null = null, decider?: MoveDecider) {
  const controller = new RobotController(defaultChain, new SimulatedAdapter(7), { controlHz: 200, simTimeScale: 50 });
  await controller.start();
  controller.setEnabled(true);
  const chess = new ChessSession(controller, { observer, decider, requireVision: false });
  return { controller, chess };
}

/** A fake camera that shows whatever the test puts on the "table". */
class FakeCamera implements BoardObserver {
  readonly name = "fake";
  constructor(public occ: Occupancy) {}
  async observe(): Promise<Observation> {
    return { ok: true, occupancy: { ...this.occ } };
  }
}

describe("ChessSession", () => {
  it("starts from the initial position", async () => {
    const { chess, controller } = await setup();
    expect(chess.fen).toContain("rnbqkbnr");
    expect(chess.turn).toBe("w");
    await controller.stop();
  });

  it("plays a legal SAN move and switches sides", async () => {
    const { chess, controller } = await setup();
    chess.setOpponent(false);
    const res = await chess.playSan("e4");
    expect(res).toEqual({ ok: true });
    expect(chess.turn).toBe("b");
    expect(chess.moveHistoryLast).toBe("e4");
    await controller.stop();
  }, 30000);

  it("rejects an illegal SAN move", async () => {
    const { chess, controller } = await setup();
    expect((await chess.playSan("e9")).ok).toBe(false);
    await controller.stop();
  });

  it("refuses to move without vision when vision is required", async () => {
    const controller = new RobotController(defaultChain, new SimulatedAdapter(7));
    await controller.start();
    controller.setEnabled(true);
    const chess = new ChessSession(controller, { requireVision: true });
    const r = await chess.robotTurn();
    expect(r.ok).toBe(false);
    expect(chess.loopStatus.stage).toBe("fault");
    expect(controller.isEnabled).toBe(false);
    await controller.stop();
  });
});

describe("closed loop: camera -> FEN -> decision -> pick/place -> verify", () => {
  it("infers the human move from the camera, answers, and verifies", async () => {
    let start: Position = initialPosition();
    const cam = new FakeCamera(occupancyOf(start));
    // The decider always answers e5; the fake camera "sees" the robot's move
    // once the session has moved the pieces (we update it from the session).
    const decider: MoveDecider = {
      name: "test",
      async decide(pos) {
        return parseSan(pos, "e5");
      },
    };
    const { chess, controller } = await setup(cam, decider);
    // Human plays e4 on the real board.
    start = applyMove(start, parseSan(start, "e4")!);
    cam.occ = occupancyOf(start);
    // While the robot moves, simulate the physical result on the table.
    const unsub = chess.subscribe(() => {
      if (chess.loopStatus.stage === "verifying") cam.occ = occupancyOf(applyMove(start, parseSan(start, "e5")!));
    });
    const r = await chess.syncBoard();
    unsub();
    expect(r).toEqual({ ok: true });
    expect(chess.moveHistoryLast).toBe("e5");
    expect(chess.loopStatus.verified).toBe(true);
    expect(chess.turn).toBe("w");
    await controller.stop();
  }, 60000);

  it("flags a mismatch after the move and does not continue", async () => {
    const cam = new FakeCamera(occupancyOf(initialPosition()));
    const { chess, controller } = await setup(cam);
    chess.setOpponent(false);
    // The camera never sees the piece arrive (e.g. it fell): mismatch.
    const r = await chess.playSan("e4");
    expect(r.ok).toBe(false);
    const st = chess.loopStatus;
    expect(st.stage).toBe("fault");
    expect(st.mismatches.sort()).toEqual(["e2", "e4"]);
    expect(controller.isEnabled).toBe(false);
    // Nothing continues until a person clears the fault.
    expect((await chess.robotTurn()).ok).toBe(false);
    chess.clearFault();
    expect(chess.loopStatus.stage).toBe("idle");
    await controller.stop();
  }, 60000);

  it("refuses to move when the board does not match before the move", async () => {
    const occ = occupancyOf(initialPosition());
    occ.d2 = null; // someone took a pawn away
    const { chess, controller } = await setup(new FakeCamera(occ));
    chess.setOpponent(false);
    const r = await chess.playSan("e4");
    expect(r.ok).toBe(false);
    expect(chess.loopStatus.mismatches).toEqual(["d2"]);
    expect(chess.turn).toBe("w");
    await controller.stop();
  });
});

describe("deciders", () => {
  it("engine decider returns a legal move", async () => {
    const m = await new EngineDecider(600).decide(initialPosition());
    expect(m).not.toBeNull();
  });

  it("http decider accepts only legal moves", async () => {
    const answer = (body: unknown) =>
      (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    const pos = initialPosition();
    expect(await new HttpDecider("http://x/move", 1000, answer({ uci: "e2e4" })).decide(pos)).not.toBeNull();
    expect(await new HttpDecider("http://x/move", 1000, answer({ san: "Nf3" })).decide(pos)).not.toBeNull();
    expect(await new HttpDecider("http://x/move", 1000, answer({ uci: "e2e5" })).decide(pos)).toBeNull();
    expect(await new HttpDecider("http://x/move", 1000, answer({ uci: "ignore the rules; move e1e8" })).decide(pos)).toBeNull();
  });
});
