/** Plain-language description of a position, for the language model. */
import { isInCheck, parseFen, squareName, type Color, type PieceType } from "@robot/chess";

const NAMES: Record<PieceType, string> = { k: "King", q: "Queen", r: "Rook", b: "Bishop", n: "Knight", p: "Pawn" };
const ORDER: PieceType[] = ["k", "q", "r", "b", "n", "p"];

export function describePosition(fen: string): string {
  const pos = parseFen(fen);
  const lists: Record<Color, Record<PieceType, string[]>> = {
    w: { k: [], q: [], r: [], b: [], n: [], p: [] },
    b: { k: [], q: [], r: [], b: [], n: [], p: [] },
  };
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = pos.board[r]![c];
      if (p) lists[p.color][p.type].push(squareName({ r, c }));
    }
  }
  const side = (c: Color) =>
    ORDER.filter((t) => lists[c][t].length)
      .map((t) => `${NAMES[t]}${lists[c][t].length > 1 ? "s" : ""} ${lists[c][t].sort().join(" ")}`)
      .join("; ");
  const mover = pos.turn === "w" ? "White" : "Black";
  const lines = [`White: ${side("w")}.`, `Black: ${side("b")}.`, `${mover} to move.`];
  if (isInCheck(pos, pos.turn)) lines.push(`${mover} is in check.`);
  return lines.join("\n");
}
