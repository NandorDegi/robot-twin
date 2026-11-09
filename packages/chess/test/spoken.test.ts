import { describe, expect, it } from "vitest";
import { initialPosition, parseFen } from "../src/engine";
import { spokenToSan } from "../src/spoken";

const CASTLE_POS = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";

describe("spokenToSan", () => {
  it("maps simple pawn and piece moves", () => {
    let pos = initialPosition();
    expect(spokenToSan(pos, "e4")).toBe("e4");
    expect(spokenToSan(pos, "pawn e4")).toBe("e4");
    expect(spokenToSan(pos, "e four")).toBe("e4");
    expect(spokenToSan(pos, "knight f3")).toBe("Nf3");
    expect(spokenToSan(pos, "knight to f3")).toBe("Nf3");
  });

  it("resolves pawn captures with a source file", () => {
    const pos = parseFen("rnbqkbnr/ppp2ppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1");
    expect(spokenToSan(pos, "e takes d5")).toBe("exd5");
    expect(spokenToSan(pos, "e x d5")).toBe("exd5");
    expect(spokenToSan(pos, "ex d5")).toBe("exd5");
  });

  it("resolves piece captures by name", () => {
    const pos = parseFen("r1bqkbnr/pppp1ppp/2n5/4p3/1N6/8/PPPP1PPP/R1BQKBNR w KQkq - 0 1");
    expect(spokenToSan(pos, "knight takes c6")).toBe("Nxc6");
    expect(spokenToSan(pos, "knight captures c6")).toBe("Nxc6");
    // A capture with no piece name, when only one move fits.
    expect(spokenToSan(pos, "takes c6")).toBe("Nxc6");
  });

  it("handles short castling", () => {
    const pos = parseFen(CASTLE_POS);
    expect(spokenToSan(pos, "castle king side")).toBe("O-O");
    expect(spokenToSan(pos, "short castle")).toBe("O-O");
    expect(spokenToSan(pos, "king side castle")).toBe("O-O");
    expect(spokenToSan(pos, "o-o")).toBe("O-O");
  });

  it("handles long castling (queen side)", () => {
    const pos = parseFen(CASTLE_POS);
    expect(spokenToSan(pos, "long castle")).toBe("O-O-O");
    expect(spokenToSan(pos, "castle queen side")).toBe("O-O-O");
    expect(spokenToSan(pos, "queenside castle")).toBe("O-O-O");
    expect(spokenToSan(pos, "o-o-o")).toBe("O-O-O");
  });

  it("prefers king-side when castle is not qualified", () => {
    const pos = parseFen(CASTLE_POS);
    expect(spokenToSan(pos, "castle")).toBe("O-O");
  });

  it("uses the only legal castle when only one is available", () => {
    const pos = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w Kk - 0 1");
    expect(spokenToSan(pos, "castle")).toBe("O-O");
  });

  it("annotates check", () => {
    const pos = parseFen("6k1/8/8/8/8/8/8/4R1K1 w - - 0 1");
    expect(spokenToSan(pos, "rook e8")).toBe("Re8+");
  });

  it("handles promotion", () => {
    const pos = parseFen("8/4P2k/8/8/8/8/8/4K3 w - - 0 1");
    expect(spokenToSan(pos, "e8 queen")).toBe("e8=Q");
    expect(spokenToSan(pos, "e8 equals queen")).toBe("e8=Q");
    expect(spokenToSan(pos, "push to e8 promote to queen")).toBe("e8=Q");
  });

  it("returns null for illegal or ambiguous moves", () => {
    const pos = initialPosition();
    expect(spokenToSan(pos, "knight z9")).toBeNull();
    expect(spokenToSan(pos, "knight e5")).toBeNull();
    const twoKnights = parseFen("8/8/8/8/8/.N...N../8/4K3 w - - 0 1");
    expect(spokenToSan(twoKnights, "knight d4")).toBeNull();
  });

  it("ignores filler words", () => {
    const pos = initialPosition();
    expect(spokenToSan(pos, "please move a knight to f3")).toBe("Nf3");
    expect(spokenToSan(pos, "okay, the pawn to e4")).toBe("e4");
  });
});
