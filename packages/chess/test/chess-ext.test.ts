import { describe, expect, it } from "vitest";
import { initialPosition, parseFen, legalMoves } from "../src/engine";
import { parseSan, moveToSan } from "../src/san";
import { chooseMove } from "../src/bot";
import { squareToTarget, trayTarget, BOARD } from "../src/board";

describe("SAN", () => {
  it("round-trips a simple pawn move", () => {
    const pos = initialPosition();
    const m = parseSan(pos, "e4")!;
    expect(m).toBeTruthy();
    expect(moveToSan(pos, m).replace(/[+#]/g, "")).toBe("e4");
  });

  it("parses knight and castling moves", () => {
    const pos = initialPosition();
    expect(parseSan(pos, "Nf3")).toBeTruthy();
    const pos2 = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    expect(parseSan(pos2, "O-O")?.flags).toContain("castle-k");
    expect(parseSan(pos2, "O-O-O")?.flags).toContain("castle-q");
  });

  it("annotates check", () => {
    const pos = parseFen("6k1/8/8/8/8/8/8/4R1K1 w - - 0 1");
    const m = parseSan(pos, "Re8+");
    expect(m).toBeTruthy();
    expect(moveToSan(pos, m!)).toMatch(/\+$/);
  });

  it("handles en passant SAN (exd6)", () => {
    const pos = parseFen("8/8/8/3pP3/8/8/8/8 w - d6 0 1");
    expect(parseSan(pos, "exd6")?.flags).toContain("ep");
  });

  it("disambiguates when two knights can reach the same square", () => {
    const pos = parseFen("8/8/8/8/8/.N...N../8/4K3 w - - 0 1");
    const san = legalMoves(pos, "w")
      .filter((m) => m.piece === "n" && "abcdefgh"[m.to.c] === "d" && 8 - m.to.r === 4)
      .map((m) => moveToSan(pos, m));
    expect(san.length).toBe(2);
    expect(san).toContain("Nbd4");
    expect(san).toContain("Nfd4");
  });
});

describe("bot", () => {
  it("returns a legal move at every elo", () => {
    for (const elo of [400, 1200, 2200]) {
      const pos = initialPosition();
      const m = chooseMove(pos, elo);
      expect(m).toBeTruthy();
      expect(parseSan(pos, moveToSan(pos, m!))).toBeTruthy();
    }
  });
});

describe("board mapping", () => {
  it("maps squares to stable targets", () => {
    const a1 = squareToTarget("a1");
    const h8 = squareToTarget("h8");
    // a-file is at the high-X corner, so a1 is farther from the base in X than h8.
    expect(a1[0]).toBeGreaterThan(h8[0]!);
    expect(h8[2]).toBeGreaterThan(a1[2]!);
    expect(a1[1]).toBeCloseTo(BOARD.grabHeight);
    expect(Array.isArray(trayTarget())).toBe(true);
  });
});
