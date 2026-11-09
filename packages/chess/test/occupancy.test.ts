import { describe, expect, it } from "vitest";
import { applyMove, initialPosition, parseFen } from "../src/engine";
import { parseSan } from "../src/san";
import { diffOccupancy, inferMove, occupancyOf } from "../src/occupancy";

describe("occupancy", () => {
  it("initial position has 32 pieces", () => {
    const occ = occupancyOf(initialPosition());
    expect(Object.values(occ).filter(Boolean)).toHaveLength(32);
    expect(occ.e2).toBe("w");
    expect(occ.e7).toBe("b");
    expect(occ.e4).toBeNull();
  });

  it("infers a simple move", () => {
    const pos = initialPosition();
    const after = applyMove(pos, parseSan(pos, "e4")!);
    const r = inferMove(pos, occupancyOf(after));
    expect(r.kind).toBe("move");
    if (r.kind === "move") expect(r.move.to).toEqual({ r: 4, c: 4 });
  });

  it("infers castling and en passant", () => {
    const pos = parseFen("r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1");
    for (const san of ["O-O", "O-O-O", "exd6"]) {
      const m = parseSan(pos, san)!;
      const r = inferMove(pos, occupancyOf(applyMove(pos, m)));
      expect(r.kind, san).toBe("move");
    }
  });

  it("reports no change and a mismatch", () => {
    const pos = initialPosition();
    expect(inferMove(pos, occupancyOf(pos)).kind).toBe("none");
    const bad = occupancyOf(pos);
    bad.e2 = null;
    bad.a5 = "b"; // not a legal white move
    const r = inferMove(pos, bad);
    expect(r.kind).toBe("mismatch");
    if (r.kind === "mismatch") expect(r.squares.sort()).toEqual(["a5", "e2"]);
  });

  it("diff lists changed squares", () => {
    const a = occupancyOf(initialPosition());
    const b = { ...a, e2: null, e4: "w" as const };
    expect(diffOccupancy(a, b).sort()).toEqual(["e2", "e4"]);
  });
});
