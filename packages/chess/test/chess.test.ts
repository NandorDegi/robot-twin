import { describe, expect, it } from "vitest";
import {
  initialPosition,
  parseFen,
  toFen,
  legalMoves,
  applyMove,
  isInCheck,
} from "../src/engine";
import { planMove, uciToMove, listLegalUci, moveToUci } from "../src/planner";

describe("chess engine", () => {
  it("parses and re-serialises the initial position", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const pos = parseFen(fen);
    expect(toFen(pos)).toBe(fen);
  });

  it("a capture resets the halfmove clock; a quiet piece move increments it", () => {
    // White knight on d4 can take the black knight on e6, or retreat to f3.
    const pos = parseFen("4k3/8/4n3/8/3N4/8/8/4K3 w - - 7 30");
    const capture = applyMove(pos, uciToMove(pos, "d4e6"));
    expect(capture.halfmove).toBe(0);
    expect(toFen(capture)).toBe("4k3/8/4N3/8/8/8/8/4K3 b - - 0 30");
    const quiet = applyMove(pos, uciToMove(pos, "d4f3"));
    expect(quiet.halfmove).toBe(8);
    const pawn = applyMove(parseFen("4k3/8/8/8/8/8/4P3/4K3 w - - 5 40"), uciToMove(parseFen("4k3/8/8/8/8/8/4P3/4K3 w - - 5 40"), "e2e4"));
    expect(pawn.halfmove).toBe(0);
  });

  it("has exactly 20 legal moves from the start", () => {
    const pos = initialPosition();
    expect(legalMoves(pos, "w")).toHaveLength(20);
  });

  it("applies a pawn move", () => {
    const pos = initialPosition();
    const move = uciToMove(pos, "e2e4");
    const next = applyMove(pos, move);
    expect(next.turn).toBe("b");
    expect(moveToUci(move)).toBe("e2e4");
  });

  it("detects check", () => {
    const pos = parseFen("4k3/8/8/8/8/8/8/4R2K w - - 0 1");
    expect(isInCheck(pos, "b")).toBe(true);
    expect(isInCheck(pos, "w")).toBe(false);
  });

  it("allows kingside castling", () => {
    const pos = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const ucis = listLegalUci(pos, "w");
    expect(ucis).toContain("e1g1");
  });

  it("allows en passant", () => {
    const pos = parseFen("8/8/8/3pP3/8/8/8/8 w - d6 0 1");
    const ucis = listLegalUci(pos, "w");
    expect(ucis).toContain("e5d6");
  });

  it("does not leave the king in check (pin filtering)", () => {
    // Black rook pins the white rook to the king: the rook cannot leave the
    // e-file, but the king can escape sideways.
    const pos = parseFen("4r3/8/8/8/8/8/4R3/4K3 w - - 0 1");
    const ucis = listLegalUci(pos, "w");
    expect(ucis).toContain("e2e8"); // capture the pinning rook
    expect(ucis).not.toContain("e2d2"); // would expose the king
  });
});

describe("planner", () => {
  it("plans a simple push as pick then place", () => {
    const pos = initialPosition();
    const steps = planMove(pos, uciToMove(pos, "e2e4"));
    expect(steps).toEqual([
      { op: "pick", square: "e2" },
      { op: "place", square: "e4" },
    ]);
  });

  it("handles a capture by clearing the captured piece to a tray", () => {
    const pos = parseFen("8/8/8/8/3p4/4P3/8/8 w - - 0 1");
    const move = uciToMove(pos, "e3d4");
    const steps = planMove(pos, move);
    expect(steps).toEqual([
      { op: "pick", square: "d4" },
      { op: "place", tray: "capture" },
      { op: "pick", square: "e3" },
      { op: "place", square: "d4" },
    ]);
  });

  it("plans castling as rook then king", () => {
    const pos = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const move = uciToMove(pos, "e1g1");
    const steps = planMove(pos, move);
    expect(steps).toEqual([
      { op: "pick", square: "h1" },
      { op: "place", square: "f1" },
      { op: "pick", square: "e1" },
      { op: "place", square: "g1" },
    ]);
  });
});
