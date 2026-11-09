import { applyMove, legalMoves, squareName, type Color, type Move, type Position } from "./engine";

/**
 * What an overhead camera can see reliably: for each square, empty or the
 * colour of the piece on it. Keys are square names ("a1".."h8").
 */
export type SquareState = Color | null;
export type Occupancy = Record<string, SquareState>;

export const ALL_SQUARES: string[] = (() => {
  const out: string[] = [];
  for (let rank = 1; rank <= 8; rank++) for (const f of "abcdefgh") out.push(`${f}${rank}`);
  return out;
})();

/** Expected occupancy of a position. */
export function occupancyOf(pos: Position): Occupancy {
  const occ: Occupancy = {};
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = pos.board[r]![c];
      occ[squareName({ r, c })] = p ? p.color : null;
    }
  }
  return occ;
}

/** Squares where two occupancies differ (an unknown/missing square counts as a difference). */
export function diffOccupancy(expected: Occupancy, observed: Occupancy): string[] {
  return ALL_SQUARES.filter((sq) => (expected[sq] ?? null) !== (observed[sq] ?? null));
}

export type InferResult =
  | { kind: "none" }
  | { kind: "move"; move: Move }
  | { kind: "ambiguous"; moves: Move[] }
  | { kind: "mismatch"; squares: string[] };

/**
 * Find the legal move of the side to move that turns `pos` into the observed
 * occupancy. Handles captures, castling and en passant. A promotion is
 * reported as a queen promotion (colour-only vision cannot see the type).
 */
export function inferMove(pos: Position, observed: Occupancy): InferResult {
  const now = occupancyOf(pos);
  if (diffOccupancy(now, observed).length === 0) return { kind: "none" };
  const matches = legalMoves(pos, pos.turn).filter(
    (m) => (!m.promotion || m.promotion === "q") && diffOccupancy(occupancyOf(applyMove(pos, m)), observed).length === 0,
  );
  if (matches.length === 1) return { kind: "move", move: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", moves: matches };
  return { kind: "mismatch", squares: diffOccupancy(now, observed) };
}
