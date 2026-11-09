import {
  type Move,
  type PieceType,
  type Position,
  legalMoves,
  parseSquare,
  pieceAt,
  pseudoLegalMoves,
  squareName,
} from "./engine";

/**
 * A single robotic action. `square` refers to a board square by name (e.g.
 * "a1"), `tray` is an off-board drop location (e.g. "capture").
 */
export type PlanStep =
  | { op: "pick"; square: string }
  | { op: "place"; square: string }
  | { op: "place"; tray: string };

/**
 * Decompose a chess move into an ordered sequence of pick/place actions for a
 * robot arm. Captures are materialised first (the captured piece is moved to a
 * tray), castling moves the rook and the king, and the moving piece is then
 * placed on its destination square.
 */
export function planMove(pos: Position, move: Move): PlanStep[] {
  const steps: PlanStep[] = [];

  const captured = capturedSquare(pos, move);
  if (captured) {
    steps.push({ op: "pick", square: squareName(captured) });
    steps.push({ op: "place", tray: "capture" });
  }

  if (move.flags.includes("castle-k")) {
    steps.push({ op: "pick", square: squareName({ r: move.from.r, c: 7 }) });
    steps.push({ op: "place", square: squareName({ r: move.from.r, c: 5 }) });
  } else if (move.flags.includes("castle-q")) {
    steps.push({ op: "pick", square: squareName({ r: move.from.r, c: 0 }) });
    steps.push({ op: "place", square: squareName({ r: move.from.r, c: 3 }) });
  }

  steps.push({ op: "pick", square: squareName(move.from) });
  steps.push({ op: "place", square: squareName(move.to) });
  return steps;
}

/** The square of the piece captured by `move`, or null if no capture. */
export function capturedSquare(pos: Position, move: Move) {
  if (move.flags.includes("ep")) {
    return { r: move.from.r, c: move.to.c };
  }
  const target = pieceAt(pos.board, move.to);
  if (target && target.color !== move.color) return { ...move.to };
  return null;
}

/** Parse a UCI move string (e.g. "e2e4", "e7e8q") into a Move. */
export function uciToMove(pos: Position, uci: string): Move {
  if (uci.length < 4) throw new Error(`bad UCI move ${uci}`);
  const from = parseSquare(uci.slice(0, 2));
  const to = parseSquare(uci.slice(2, 4));
  const promotion = uci.length >= 5 ? (uci[4] as PieceType) : undefined;

  const piece = pieceAt(pos.board, from);
  if (!piece) throw new Error(`no piece at ${uci.slice(0, 2)}`);

  const found = pseudoLegalMoves(pos, pos.turn).find(
    (m) =>
      m.from.r === from.r &&
      m.from.c === from.c &&
      m.to.r === to.r &&
      m.to.c === to.c &&
      (m.promotion ?? undefined) === promotion,
  );
  if (!found) throw new Error(`illegal move ${uci}`);
  return found;
}

/** Serialise a Move as UCI (e.g. "e2e4"). */
export function moveToUci(move: Move): string {
  const base = `${squareName(move.from)}${squareName(move.to)}`;
  return move.promotion ? base + move.promotion : base;
}

/** All legal moves for the given color, as UCI strings. */
export function listLegalUci(pos: Position, color: Position["turn"]): string[] {
  return legalMoves(pos, color).map(moveToUci);
}
