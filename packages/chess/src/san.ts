import {
  applyMove,
  isCheckmate,
  isInCheck,
  legalMoves,
  pieceAt,
  squareName,
  type Move,
  type Position,
} from "./engine";

const FILES = "abcdefgh";

/**
 * Render a move in Standard Algebraic Notation, given the position BEFORE the
 * move is played. Handles captures, check/mate, castling, promotions and
 * disambiguation.
 */
export function moveToSan(pos: Position, move: Move): string {
  let san: string;

  if (move.flags.includes("castle-k")) {
    san = "O-O";
  } else if (move.flags.includes("castle-q")) {
    san = "O-O-O";
  } else {
    const pieceChar = move.piece === "p" ? "" : move.piece.toUpperCase();
    const dest = squareName(move.to);
    const target = pieceAt(pos.board, move.to);
    const capture = (target !== null && target.color !== move.color) || move.flags.includes("ep");

    if (move.piece === "p") {
      san = capture ? FILES[move.from.c] + "x" + dest : dest;
    } else {
      const others = legalMoves(pos, move.color).filter(
        (m) =>
          m.piece === move.piece &&
          m.to.r === move.to.r &&
          m.to.c === move.to.c &&
          !(m.from.r === move.from.r && m.from.c === move.from.c),
      );
      let disambig = "";
      if (others.length > 0) {
        const files = new Set(others.map((m) => m.from.c));
        const ranks = new Set(others.map((m) => m.from.r));
        if (!files.has(move.from.c)) disambig = FILES[move.from.c];
        else if (!ranks.has(move.from.r)) disambig = String(8 - move.from.r);
        else disambig = FILES[move.from.c] + String(8 - move.from.r);
      }
      san = pieceChar + disambig + (capture ? "x" : "") + dest;
    }
    if (move.promotion) san += "=" + move.promotion.toUpperCase();
  }

  const next = applyMove(pos, move);
  if (isInCheck(next, next.turn)) san += isCheckmate(next) ? "#" : "+";
  return san;
}

/**
 * Parse a move in Standard Algebraic Notation. Returns the matching legal Move,
 * or null if the SAN string does not correspond to a legal move in `pos`.
 */
export function parseSan(pos: Position, san: string): Move | null {
  const input = san
    .trim()
    .replace(/0/g, "O")
    .replace(/[+#]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  for (const m of legalMoves(pos, pos.turn)) {
    if (moveToSan(pos, m).replace(/[+#]/g, "").toLowerCase() === input) return m;
  }
  return null;
}
