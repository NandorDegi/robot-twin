import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultChain } from "@robot/robot-config";
import { SimulatedAdapter } from "@robot/hardware";
import { IntuitionBrain, OccupancyObserver, observationFromPosition, parseOccupancy, type Brain, type Observation, type Observer, type PolicyModel } from "@robot/brain";
import { applyMove, initialPosition, parseSan, toFen, type Position } from "@robot/chess";
import { clientMessageSchema } from "@robot/protocol";
import { RobotController } from "../src/controller";
import { ChessSession, type ChessSessionOptions } from "../src/chess";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/** A brain whose intuition always proposes the given moves in order (no reflection). */
function scripted(moves: string[]): () => Brain {
  return () => {
    let i = 0;
    const policy: PolicyModel = {
      name: "scripted",
      async policy() {
        return { model: "scripted", moves: [{ uci: moves[i++] ?? "", prob: 1 }] };
      },
    };
    return new IntuitionBrain(policy);
  };
}

/** A fake camera that shows whatever the test puts on the "table". */
class FakeCamera implements Observer {
  calls = 0;
  fail = "";
  constructor(public pos: Position) {}
  async observe(): Promise<Observation> {
    this.calls++;
    if (this.fail) throw new Error(this.fail);
    return observationFromPosition(this.pos, { knownTypes: false, source: "fake" });
  }
}

async function setup(opts: ChessSessionOptions = {}, enabled = true) {
  const controller = new RobotController(defaultChain, new SimulatedAdapter(7), { controlHz: 200, simTimeScale: 50 });
  await controller.start();
  if (enabled) controller.setEnabled(true);
  const logPath = join(mkdtempSync(join(tmpdir(), "chess-loop-")), "brain.jsonl");
  const chess = new ChessSession(controller, {
    settleMs: 0,
    pollMs: 5,
    env: { BRAIN_INTUITION: "uniform", BRAIN_REFLECTION: "off", BRAIN_LOG: logPath },
    ...opts,
  });
  cleanup.push(async () => {
    await chess.stop();
    await controller.stop();
  });
  const events: string[] = [];
  chess.onLoopEvent((e) => events.push(e.type));
  return { controller, chess, logPath, events };
}

async function until(pred: () => boolean, ms = 30000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const log = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("the one chess loop (brain GameLoop on the controller)", () => {
  it("is stopped at start and validates its commands", async () => {
    const { chess } = await setup({ observerKind: "sim" });
    expect(chess.loopStatus.stage).toBe("stopped");
    expect(chess.isBusy).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "brain", cmd: "resume" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "brain", cmd: "fly" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "setOpponent", enabled: true, elo: 1200 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "brain", cmd: "simFault", fault: { kind: "offset", to: "z9" } }).success).toBe(false);
  });

  it("sim: human move -> brain move on the controller, verified, JSONL logged", async () => {
    const { chess, logPath } = await setup({ observerKind: "sim" });
    expect(await chess.start()).toEqual({ ok: true });
    await until(() => chess.loopStatus.stage === "awaiting-human");
    expect(await chess.playSan("e4")).toEqual({ ok: true });
    await until(() => chess.loopStatus.verified);
    expect(chess.status().moves).toHaveLength(2);
    expect(chess.turn).toBe("w");
    expect(log(logPath).map((l) => l.verdict)).toEqual(["human-move", "ok"]);
  }, 60000);

  it("camera: verifies the brain's move with the fake camera", async () => {
    let table = applyMove(initialPosition(), parseSan(initialPosition(), "e4")!);
    const cam = new FakeCamera(table);
    const { chess, controller } = await setup({ observer: cam, observerKind: "vision", brain: scripted(["e7e5"]) });
    // The arm "really" moves the piece: once it lifts from e5, the table shows the move.
    const unsub = controller.subscribe(() => {
      if (chess.loopStatus.stage === "acting") cam.pos = applyMove(table, parseSan(table, "e5")!);
    });
    expect((await chess.start("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")).ok).toBe(true);
    await until(() => chess.loopStatus.verified);
    unsub();
    table = cam.pos;
    expect(chess.moveHistoryLast).toBe("e5");
    expect(chess.fen.split(" ")[0]).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR");
    expect(chess.deciderName).toBe("intuition:scripted");
  }, 60000);

  it("a mismatch after the move halts, explains, and DISABLES the robot", async () => {
    // The camera never sees the piece arrive (it fell).
    const cam = new FakeCamera(parseSanFen("e4"));
    const { chess, controller, logPath } = await setup({ observer: cam, observerKind: "vision", brain: scripted(["e7e5"]) });
    await chess.start(toFen(cam.pos));
    await until(() => chess.loopStatus.stage === "halted");
    const st = chess.loopStatus;
    expect(st.mismatches.sort()).toEqual(["e5", "e7"]);
    expect(st.message).toMatch(/I stopped \(mismatch\)/);
    expect(controller.isEnabled).toBe(false);
    const rec = log(logPath).at(-1);
    expect(rec.verdict).toBe("mismatch");
    expect(rec.hints.join(" ")).toMatch(/e7/);
    // The human puts the pawn on e5; the robot stays disabled until a person enables it.
    cam.pos = applyMove(cam.pos, parseSan(cam.pos, "e5")!);
    expect(await chess.resolve({ action: "retry" })).toEqual({ ok: true });
    expect(chess.loopStatus.stage).toBe("awaiting-human");
    expect(controller.isEnabled).toBe(false);
  }, 60000);

  it("pre-check: refuses to move when the board is not the expected one", async () => {
    const pos = parseSanFen("e4");
    const wrong = { ...pos, board: pos.board.map((r) => r.slice()) };
    wrong.board[1]![3] = null; // someone took the d7 pawn away
    const cam = new FakeCamera(wrong);
    const { chess, controller } = await setup({ observer: cam, observerKind: "vision", brain: scripted(["e7e5"]) });
    const q0 = controller.state;
    await chess.start(toFen(pos));
    await until(() => chess.loopStatus.stage === "halted");
    expect(chess.loopStatus.mismatches).toEqual(["d7"]);
    expect(chess.moveHistoryLast).toBe("");
    expect(controller.isEnabled).toBe(false);
    // The arm only went to the observe pose; it never went to the board.
    expect(controller.state[0]).toBeCloseTo(Math.PI / 2, 2);
    expect(q0[0]).not.toBeCloseTo(Math.PI / 2, 2);
  }, 60000);

  it("a camera failure halts with a reason instead of guessing", async () => {
    const cam = new FakeCamera(initialPosition());
    cam.fail = "vision service unreachable";
    const { chess, controller } = await setup({ observer: cam, observerKind: "vision" });
    await chess.start();
    await until(() => chess.loopStatus.stage === "halted");
    expect(chess.status().question?.hints.join(" ")).toMatch(/vision service unreachable/);
    expect(controller.isEnabled).toBe(false);
  }, 60000);

  it("waits (no motion) on its turn while the robot is disabled", async () => {
    const cam = new FakeCamera(parseSanFen("e4"));
    const { chess, controller } = await setup({ observer: cam, observerKind: "vision", brain: scripted(["e7e5"]) }, false);
    await chess.start(toFen(cam.pos));
    await new Promise((r) => setTimeout(r, 200));
    expect(chess.loopStatus.stage).toBe("robot-turn");
    expect(chess.loopStatus.message).toMatch(/robot is disabled/);
    expect(cam.calls).toBe(0);
    expect(controller.isEnabled).toBe(false);
  });

  it("refuses the simulated board on a real robot (no camera check)", async () => {
    const { chess } = await setup({ observerKind: "sim", requireVision: true });
    const r = await chess.start();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no camera check possible/);
    expect(chess.running).toBe(false);
  });

  it("refuses the camera loop without VISION_URL", async () => {
    const { chess } = await setup({ observerKind: "vision" });
    expect((await chess.start()).error).toMatch(/VISION_URL/);
  });

  it("calibration gate: refuses to start, pauses a running game, resumes when valid", async () => {
    let gate = { ok: false, reason: "no valid calibration: no calibration file yet" };
    const { chess } = await setup({ observerKind: "sim", calibrationGate: () => gate });
    const r = await chess.start();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no valid calibration/);
    expect(chess.loopStatus.message).toMatch(/refused: no valid calibration/);
    gate = { ok: true, reason: "" };
    expect((await chess.start()).ok).toBe(true);
    await until(() => chess.loopStatus.stage === "awaiting-human");
    gate = { ok: false, reason: "no valid calibration: file changed" };
    await until(() => chess.loopStatus.stage === "paused");
    expect(chess.loopStatus.message).toMatch(/paused: no valid calibration/);
    expect(chess.resume().ok).toBe(false);
    gate = { ok: true, reason: "" };
    expect(chess.resume().ok).toBe(true);
    await until(() => chess.loopStatus.stage === "awaiting-human");
  }, 60000);

  it("a typed move needs the simulated board (the camera reads real moves)", async () => {
    const { chess } = await setup({ observer: new FakeCamera(initialPosition()), observerKind: "vision" });
    expect((await chess.playSan("e4")).ok).toBe(false);
  });
});

describe("OccupancyObserver (/board)", () => {
  it("parses the calibrated occupancy with confidence; refuses bad data", async () => {
    const squares: Record<string, "w" | "b" | null> = {};
    for (const f of "abcdefgh") for (const r of "12345678") squares[`${f}${r}`] = r === "1" || r === "2" ? "w" : r === "7" || r === "8" ? "b" : null;
    const o = parseOccupancy({ ok: true, squares, confidence: { e2: 0.3 } });
    expect(o.squares.e2).toEqual({ color: "w", type: null, confidence: 0.3 });
    expect(o.squares.e4).toEqual({ color: null, type: null, confidence: 1 });
    expect(() => parseOccupancy({ ok: false, error: "board not calibrated" })).toThrow(/not calibrated/);
    expect(() => parseOccupancy({ ok: true, squares: { ...squares, a1: "x" } })).toThrow(/bad value/);
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, squares }))) as unknown as typeof fetch;
    const obs = await new OccupancyObserver("http://vision", { fetchImpl }).observe();
    expect(obs.source).toBe("vision:board");
  });
});

function parseSanFen(san: string): Position {
  const p = initialPosition();
  return applyMove(p, parseSan(p, san)!);
}
