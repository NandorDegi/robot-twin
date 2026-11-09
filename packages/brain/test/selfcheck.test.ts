import { describe, expect, it } from "vitest";
import { applyMove, initialPosition, legalMoves, parseFen, squareName, type Position } from "@robot/chess";
import {
  detectHumanMove,
  diffBoard,
  encodeObservation,
  expectedBoard,
  explainDiff,
  observationFromPosition,
  predictAfter,
} from "../src/selfcheck";
import { moveUci } from "../src/intuition";

const play = (pos: Position, uci: string) => {
  const m = legalMoves(pos, pos.turn).find((x) => moveUci(x) === uci);
  if (!m) throw new Error(`illegal ${uci}`);
  return { move: m, next: applyMove(pos, m) };
};

describe("predict + diff", () => {
  it("a perfect observation of the prediction matches", () => {
    const pos = initialPosition();
    const { move } = play(pos, "e2e4");
    const pred = predictAfter(pos, move);
    const d = diffBoard(expectedBoard(pred), observationFromPosition(pred));
    expect(d.match).toBe(true);
    expect(d.diffs).toEqual([]);
  });

  it("reports the squares that differ and what kind of difference", () => {
    const pos = initialPosition();
    const { move, next } = play(pos, "e2e4");
    // The piece is still on e2 (grasp failed): observation = start position.
    const d = diffBoard(expectedBoard(next), observationFromPosition(pos));
    expect(d.match).toBe(false);
    expect(d.diffs.map((x) => [x.square, x.kind])).toEqual([
      ["e4", "missing"],
      ["e2", "unexpected"],
    ]);
    const hints = explainDiff(d, { move, before: pos });
    expect(hints.join(" ")).toMatch(/still on e2.*grasp/);
  });

  it("colour-only observations agree with any piece type of that colour", () => {
    const pos = initialPosition();
    const d = diffBoard(expectedBoard(pos), observationFromPosition(pos, { knownTypes: false }));
    expect(d.match).toBe(true);
  });

  it("wrong type is a mismatch when the type is known", () => {
    const pos = initialPosition();
    const obs = observationFromPosition(pos);
    obs.squares.d1 = { color: "w", type: "k", confidence: 0.9 };
    const d = diffBoard(expectedBoard(pos), obs);
    expect(d.diffs).toEqual([expect.objectContaining({ square: "d1", kind: "wrong-type", expected: "Q", observed: "K" })]);
  });

  it("flags low confidence, both on agreement (uncertain) and on mismatch (hint)", () => {
    const pos = initialPosition();
    const obs = observationFromPosition(pos);
    obs.squares.a2 = { color: "w", type: "p", confidence: 0.3 };
    obs.squares.h2 = { color: null, type: null, confidence: 0.4 };
    const d = diffBoard(expectedBoard(pos), obs, { minConfidence: 0.6 });
    expect(d.uncertain).toEqual(["a2"]);
    expect(d.diffs[0]).toMatchObject({ square: "h2", kind: "missing", lowConfidence: true });
    expect(explainDiff(d).join(" ")).toMatch(/Low detection confidence on h2 \(0\.40\)/);
  });

  it("drop in transit and off-centre placement get different hints", () => {
    const pos = initialPosition();
    const { move, next } = play(pos, "g1f3");
    const dropped = observationFromPosition(next);
    dropped.squares.f3 = { color: null, type: null, confidence: 0.95 };
    expect(explainDiff(diffBoard(expectedBoard(next), dropped), { move, before: pos }).join(" ")).toMatch(/dropped in transit/);
    const offset = observationFromPosition(next);
    offset.squares.f3 = { color: null, type: null, confidence: 0.95 };
    offset.squares.g3 = { color: "w", type: "n", confidence: 0.95 };
    expect(explainDiff(diffBoard(expectedBoard(next), offset), { move, before: pos }).join(" ")).toMatch(/g3 next to f3.*off-centre/);
  });

  it("many differences point to calibration", () => {
    const pos = initialPosition();
    const empty = observationFromPosition(parseFen("8/8/8/8/8/8/8/8 w - - 0 1"));
    expect(explainDiff(diffBoard(expectedBoard(pos), empty))[0]).toMatch(/calibration/);
  });

  it("encodes an observation as 64 labels in FEN order", () => {
    const enc = encodeObservation(observationFromPosition(initialPosition(), { knownTypes: false }));
    expect(enc.board).toHaveLength(64);
    expect(enc.board.slice(0, 8)).toBe("BBBBBBBB");
    expect(enc.board.slice(56)).toBe("WWWWWWWW");
    expect(enc.confidence).toHaveLength(64);
  });
});

describe("human move detection", () => {
  it("no change", () => {
    const pos = initialPosition();
    expect(detectHumanMove(pos, observationFromPosition(pos)).status).toBe("no-change");
  });

  it("finds a normal move, also from colour-only observations", () => {
    const pos = initialPosition();
    const { next } = play(pos, "g1f3");
    for (const knownTypes of [true, false]) {
      const r = detectHumanMove(pos, observationFromPosition(next, { knownTypes }));
      expect(r).toMatchObject({ status: "move", uci: "g1f3", san: "Nf3" });
    }
  });

  it("finds castling (four squares change) and en passant", () => {
    let pos = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    expect(detectHumanMove(pos, observationFromPosition(play(pos, "e1g1").next, { knownTypes: false }))).toMatchObject({ status: "move", san: "O-O" });
    pos = parseFen("4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1");
    expect(detectHumanMove(pos, observationFromPosition(play(pos, "d5e6").next, { knownTypes: false }))).toMatchObject({ status: "move", uci: "d5e6" });
  });

  it("a promotion with unknown piece type is ambiguous; with a known type it is not", () => {
    const pos = parseFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    const { next } = play(pos, "a7a8q");
    const amb = detectHumanMove(pos, observationFromPosition(next, { knownTypes: false }));
    expect(amb.status).toBe("ambiguous");
    expect(amb.candidates.map((c) => c.uci).sort()).toEqual(["a7a8b", "a7a8n", "a7a8q", "a7a8r"]);
    expect(detectHumanMove(pos, observationFromPosition(next))).toMatchObject({ status: "move", uci: "a7a8q" });
  });

  it("an illegal move is reported with the changed squares", () => {
    const pos = initialPosition();
    const obs = observationFromPosition(pos);
    obs.squares.e2 = { color: null, type: null, confidence: 0.9 };
    obs.squares.e5 = { color: "w", type: "p", confidence: 0.9 }; // e2-e5: not legal
    const r = detectHumanMove(pos, obs);
    expect(r.status).toBe("illegal");
    expect(r.changed.map((x) => x.square).sort()).toEqual(["e2", "e5"]);
    expect(r.hints[0]).toMatch(/no legal move for White/);
  });

  it("only the side to move can move", () => {
    const pos = initialPosition(); // White to move
    const obs = observationFromPosition(pos);
    obs.squares.e7 = { color: null, type: null, confidence: 0.9 };
    obs.squares.e5 = { color: "b", type: "p", confidence: 0.9 };
    expect(detectHumanMove(pos, obs).status).toBe("illegal");
  });
});

it("square names agree with @robot/chess orientation", () => {
  expect(squareName({ r: 0, c: 0 })).toBe("a8");
  expect(expectedBoard(initialPosition()).e1).toEqual({ color: "w", type: "k" });
});
