import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialPosition, legalMoves } from "@robot/chess";
import { GameLoop, type GameLoopOptions, type LoopEvent } from "../src/loop";
import { IntuitionBrain, UniformPolicyModel, moveUci } from "../src/intuition";
import { JsonlFileLog, MemoryLog } from "../src/log";
import { SimActor, SimObserver, SimWorld, type SimObserverOptions } from "../src/sim";
import type { Brain } from "../src/types";
import { FixedPolicy } from "./helpers";

/** A brain that plays a scripted list of moves (falls back to the first legal move). */
function scripted(moves: string[]): IntuitionBrain {
  let i = 0;
  return new IntuitionBrain(new FixedPolicy(() => [{ uci: moves[i++] ?? "", prob: 1 }]));
}

function setup(brain: Brain, obsOpts: SimObserverOptions = {}, extra: Partial<GameLoopOptions> = {}) {
  const world = new SimWorld(initialPosition());
  const log = new MemoryLog();
  const events: LoopEvent[] = [];
  const loop = new GameLoop({
    brain,
    observer: new SimObserver(world, obsOpts),
    actor: new SimActor(world),
    log,
    onEvent: (e) => events.push(e),
    robotColor: "b",
    stableFrames: 2,
    settleMs: 0,
    sleep: async () => {},
    ...extra,
  });
  loop.start();
  const human = async (uci: string) => {
    const pos = (await import("@robot/chess")).parseFen(loop.fen);
    world.handPlay(legalMoves(pos, pos.turn).find((m) => moveUci(m) === uci)!);
    let rec = null;
    for (let i = 0; i < 3 && !rec; i++) rec = await loop.step();
    return rec;
  };
  return { world, log, events, loop, human };
}

describe("closed loop", () => {
  it("human move -> robot move -> verified, logged", async () => {
    const { loop, log, human, events } = setup(scripted(["e7e5", "b8c6"]), { knownTypes: false });
    expect(loop.state).toBe("awaiting-human");
    expect(await loop.step()).toBeNull(); // first look: not stable yet
    expect(await loop.step()).toBeNull(); // stable, no change
    const h = await human("e2e4");
    expect(h).toMatchObject({ verdict: "human-move", humanMove: { san: "e4" } });
    expect(loop.state).toBe("robot-turn");
    const r = await loop.step();
    expect(r).toMatchObject({ verdict: "ok", decision: { uci: "e7e5", san: "e5" }, diff: [] });
    expect(r!.predicted).toHaveLength(64);
    expect(r!.predicted!.slice(24, 40)).toBe("....p.......P...");
    expect(loop.moves).toEqual(["e2e4", "e7e5"]);
    expect(loop.state).toBe("awaiting-human");
    expect(log.records.map((x) => x.verdict)).toEqual(["human-move", "ok"]);
    expect(events.some((e) => e.type === "verified")).toBe(true);
  });

  it("the brain sees the history and its own memory", async () => {
    const policy = new FixedPolicy(() => [{ uci: "e7e5", prob: 1 }]);
    const { human, loop } = setup(new IntuitionBrain(policy));
    await human("e2e4");
    await loop.step();
    expect(policy.calls[0]).toMatchObject({ history: ["e2e4"], context: { lastHumanMove: { uci: "e2e4", san: "e4" } } });
  });

  it("a failed grasp stops the robot, says where and why, and asks the human", async () => {
    const { world, loop, human, events, log } = setup(scripted(["e7e5"]));
    await human("e2e4");
    world.inject({ kind: "miss-grasp" });
    const r = await loop.step();
    expect(r!.verdict).toBe("mismatch");
    expect(r!.diff!.map((d) => d.square).sort()).toEqual(["e5", "e7"]);
    expect(loop.state).toBe("halted");
    const ask = events.find((e) => e.type === "ask-human") as Extract<LoopEvent, { type: "ask-human" }>;
    expect(ask.ask.message).toMatch(/e5: expected p, saw empty/);
    expect(ask.ask.hints.join(" ")).toMatch(/still on e7.*grasp/);
    expect(ask.ask.options).toEqual(["retry", "accept-prediction", "set-fen"]);
    expect(await loop.step()).toBeNull(); // does not continue on its own
    // The human fixes the board and says "retry": verified, the game continues.
    world.handMove("e7", "e5");
    const res = await loop.resolve({ action: "retry" });
    expect(res.verdict).toBe("resolved");
    expect(loop.state).toBe("awaiting-human");
    expect(loop.moves).toEqual(["e2e4", "e7e5"]);
    expect(log.records.map((x) => x.verdict)).toEqual(["human-move", "mismatch", "resolved"]);
  });

  it("retry without fixing stays halted", async () => {
    const { world, loop, human } = setup(scripted(["e7e5"]));
    await human("e2e4");
    world.inject({ kind: "drop" });
    const r = await loop.step();
    expect(r!.hints!.join(" ")).toMatch(/dropped in transit/);
    expect((await loop.resolve({ action: "retry" })).verdict).toBe("mismatch");
    expect(loop.state).toBe("halted");
  });

  it("accept-prediction continues with the predicted board (camera was wrong)", async () => {
    const { world, loop, human } = setup(scripted(["g8f6"]));
    await human("d2d4");
    world.inject({ kind: "offset", to: "g6" });
    expect((await loop.step())!.hints!.join(" ")).toMatch(/g6 next to f6/);
    await loop.resolve({ action: "accept-prediction" });
    expect(loop.moves).toEqual(["d2d4", "g8f6"]);
    expect(loop.state).toBe("awaiting-human");
  });

  it("a transient occlusion (arm in view) is tolerated by re-observing", async () => {
    let looks = 0;
    const { loop, human } = setup(scripted(["e7e5"]), { occluded: () => (looks++ === 3 ? ["e5"] : []) });
    await human("e2e4"); // looks 0..1(2)
    const r = await loop.step(); // pre-check = look 2, verify = look 3 (occluded), retry = look 4
    expect(r!.verdict).toBe("ok");
  });

  it("a camera failure after the move halts with the reason; retry verifies again", async () => {
    const { world, loop, human } = setup(scripted(["e7e5"]));
    await human("e2e4");
    let broken = false;
    const real = (loop as unknown as { o: GameLoopOptions }).o.observer;
    (loop as unknown as { o: GameLoopOptions }).o.observer = {
      observe: async () => {
        if (broken) throw new Error("vision service unreachable");
        return real.observe();
      },
    };
    const orig = world.step.bind(world);
    world.step = (s) => {
      orig(s);
      broken = true; // the camera dies while the arm moves
    };
    const r = await loop.step();
    expect(r).toMatchObject({ verdict: "error", error: "vision service unreachable", decision: { uci: "e7e5" } });
    expect(r!.hints!.join(" ")).toMatch(/could not look at the board after my move e5/);
    expect(loop.state).toBe("halted");
    expect(loop.question!.options).toEqual(["retry", "accept-prediction", "set-fen"]);
    broken = false;
    world.step = orig;
    expect((await loop.resolve({ action: "retry" })).verdict).toBe("resolved");
    expect(loop.moves).toEqual(["e2e4", "e7e5"]);
    expect(loop.state).toBe("awaiting-human");
  });

  it("refuses to move when the board is not what it expects (pre-check)", async () => {
    const { world, loop, human } = setup(scripted(["e7e5"]));
    await human("e2e4");
    world.remove("a7"); // someone took a pawn
    const r = await loop.step();
    expect(r!.verdict).toBe("pre-check-failed");
    expect(r!.decision).toBeUndefined();
    expect(r!.hints!.join(" ")).toMatch(/a7 looks empty/);
    await loop.resolve({ action: "set-fen", fen: "rnbqkbnr/1ppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1" });
    expect(loop.state).toBe("robot-turn");
    expect((await loop.step())!.verdict).toBe("ok");
  });

  it("an illegal human move halts; an ambiguous one asks which move", async () => {
    const { world, loop } = setup(scripted([]));
    world.handMove("e2", "e5");
    await loop.step();
    const r = await loop.step();
    expect(r!.verdict).toBe("illegal");
    expect(loop.state).toBe("halted");
    world.handMove("e5", "e2");
    await loop.resolve({ action: "retry" });
    expect(loop.state).toBe("awaiting-human");

    const p = setup(scripted([]), { knownTypes: false }, {});
    p.loop.start("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    p.world.reset((await import("@robot/chess")).parseFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1"));
    p.world.handMove("a7", "a8", "q");
    await p.loop.step();
    const amb = await p.loop.step();
    expect(amb!.verdict).toBe("ambiguous");
    expect(p.loop.question!.options[0]).toBe("choose-move");
    await p.loop.resolve({ action: "choose-move", uci: "a7a8q" });
    expect(p.loop.moves).toEqual(["a7a8q"]);
  });

  it("an illegal move from the brain is never executed", async () => {
    const bad: Brain = { name: "bad", decide: async () => ({ uci: "e7e4", san: "?", rationale: "", brain: "bad", elapsedMs: 0 }) };
    const { loop, human, world } = setup(bad);
    await human("e2e4");
    const before = JSON.stringify(world.board);
    const r = await loop.step();
    expect(r!.verdict).toBe("error");
    expect(r!.error).toMatch(/illegal move e7e4/);
    expect(JSON.stringify(world.board)).toBe(before);
  });

  it("plays a whole game in simulation and writes JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-log-"));
    const path = join(dir, "games", "g.jsonl");
    const world = new SimWorld(initialPosition());
    const loop = new GameLoop({
      brain: new IntuitionBrain(new UniformPolicyModel(), { temperature: 1, random: () => 0.37 }),
      observer: new SimObserver(world, { knownTypes: false }),
      actor: new SimActor(world),
      log: new JsonlFileLog(path),
      robotColor: "b",
      stableFrames: 1,
      sleep: async () => {},
    });
    loop.start();
    const humanPick = new IntuitionBrain(new UniformPolicyModel(), { temperature: 1, random: () => 0.61 });
    for (let ply = 0; ply < 40 && loop.state !== "game-over"; ply++) {
      if (loop.state === "awaiting-human") {
        const d = await humanPick.decide({ fen: loop.fen, history: [] });
        const pos = (await import("@robot/chess")).parseFen(loop.fen);
        world.handPlay(legalMoves(pos, pos.turn).find((m) => moveUci(m) === d.uci)!);
      }
      const r = await loop.step();
      if (loop.state === "halted") {
        // Colour-only vision can be ambiguous for a promotion: the human answers.
        expect(r!.verdict).toBe("ambiguous");
        await loop.resolve({ action: "choose-move", uci: loop.question!.candidates![0]!.uci });
      }
    }
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) {
      expect(l).toHaveProperty("v", 1);
      expect(l).toHaveProperty("fenBefore");
      if (l.phase !== "resolve") expect(l.observed.board).toHaveLength(64);
    }
    expect(lines.filter((l) => l.phase === "robot").every((l) => l.verdict === "ok" && l.predicted.length === 64 && l.decision.rationale)).toBe(true);
  });
});
