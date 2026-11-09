import {
  applyMove,
  isInCheck,
  legalMoves,
  type Move,
  type PieceType,
  type Position,
} from "./engine";

/** Basic material values. */
const VALUE: Record<PieceType, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

/** Piece-square table (0..63, index = rank*8 + file) for pawns, white. */
const PAWN_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];

function materialEval(pos: Position, color: Position["turn"]): number {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = pos.board[r]![c];
      if (!p) continue;
      const sign = p.color === color ? 1 : -1;
      score += sign * VALUE[p.type];
      if (p.type === "p") {
        const idx = p.color === "w" ? r * 8 + c : (7 - r) * 8 + c;
        score += sign * (PAWN_PST[idx] ?? 0);
      }
    }
  }
  return score;
}

/** Negamax with alpha-beta. Returns score from the side-to-move's perspective. */
function negamax(pos: Position, depth: number, alpha: number, beta: number): number {
  const moves = legalMoves(pos, pos.turn);
  if (moves.length === 0) {
    return isInCheck(pos, pos.turn) ? -100000 : 0;
  }
  if (depth === 0) {
    const s = materialEval(pos, pos.turn);
    // Slightly prefer the side to move.
    return s;
  }
  let best = Number.NEGATIVE_INFINITY;
  for (const m of moves) {
    const s = -negamax(applyMove(pos, m), depth - 1, -beta, -alpha);
    if (s > best) best = s;
    if (s > alpha) alpha = s;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * Choose a move for the side to move.
 *
 * `elo` controls strength: lower Elo -> shallower search + more randomness.
 * Returns the chosen Move, or null if there is no legal move.
 */
export function chooseMove(pos: Position, elo: number): Move | null {
  const moves = legalMoves(pos, pos.turn);
  if (moves.length === 0) return null;

  const depth = elo < 800 ? 1 : elo < 1400 ? 2 : 3;

  let best: Move = moves[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;

  // Add search noise so lower-elo play is not perfect.
  const noise = elo < 1000 ? (2000 - elo) * 0.4 : elo < 1600 ? (1600 - elo) * 0.9 : 0;

  for (const m of moves) {
    const base = -negamax(applyMove(pos, m), depth - 1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
    const total = base + Math.random() * noise;
    if (total > bestScore) {
      bestScore = total;
      best = m;
    }
  }
  return best;
}
