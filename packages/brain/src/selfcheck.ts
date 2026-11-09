/**
 * Self-check: predict the board, compare it with what the camera sees, and
 * explain any difference. Also detects the human's move from an observation.
 *
 * Square naming and orientation follow @robot/chess: board[r][c], r = 0 is
 * rank 8, c = 0 is file a.
 */
import {
  applyMove,
  legalMoves,
  moveToSan,
  squareName,
  type Move,
  type Piece,
  type Position,
} from "@robot/chess";
import type { Observation, SquareObservation } from "./types";

export const ALL_SQUARES: string[] = (() => {
  const out: string[] = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) out.push(squareName({ r, c }));
  return out;
})();

/** Square -> piece (or null), the board we expect to see. */
export type ExpectedBoard = Record<string, Piece | null>;

export function expectedBoard(pos: Position): ExpectedBoard {
  const out: ExpectedBoard = {};
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) out[squareName({ r, c })] = pos.board[r]![c] ?? null;
  }
  return out;
}

/** Predict the board after `move` (the robot's own forward model). */
export function predictAfter(pos: Position, move: Move): Position {
  return applyMove(pos, move);
}

const UNKNOWN: SquareObservation = { color: null, type: null, confidence: 0 };

export function squareObs(obs: Observation, sq: string): SquareObservation {
  return obs.squares[sq] ?? UNKNOWN;
}

/** One-character label: "." empty, "PNBRQK"/"pnbrqk" known, "W"/"B" piece of unknown type. */
export function obsLabel(o: SquareObservation): string {
  if (!o.color) return ".";
  if (!o.type) return o.color === "w" ? "W" : "B";
  return o.color === "w" ? o.type.toUpperCase() : o.type;
}

export function pieceLabel(p: Piece | null): string {
  if (!p) return ".";
  return p.color === "w" ? p.type.toUpperCase() : p.type;
}

/**
 * Compact encoding for the log: 64 labels in FEN order (a8..h8, a7..., h1) and
 * the matching confidences.
 */
export function encodeObservation(obs: Observation): { board: string; confidence: number[] } {
  return {
    board: ALL_SQUARES.map((s) => obsLabel(squareObs(obs, s))).join(""),
    confidence: ALL_SQUARES.map((s) => Math.round(squareObs(obs, s).confidence * 100) / 100),
  };
}

export function encodeExpected(b: ExpectedBoard): string {
  return ALL_SQUARES.map((s) => pieceLabel(b[s] ?? null)).join("");
}

/** Build a (perfect, or degraded) observation from a position. Used by the simulator and tests. */
export function observationFromPosition(
  pos: Position,
  opts: { confidence?: number; knownTypes?: boolean; source?: string } = {},
): Observation {
  const confidence = opts.confidence ?? 1;
  const knownTypes = opts.knownTypes ?? true;
  const squares: Record<string, SquareObservation> = {};
  for (const [sq, p] of Object.entries(expectedBoard(pos))) {
    squares[sq] = p
      ? { color: p.color, type: knownTypes ? p.type : null, confidence }
      : { color: null, type: null, confidence };
  }
  return { squares, source: opts.source ?? "synthetic", timestamp: new Date().toISOString() };
}

// --- diff ---------------------------------------------------------------------

export type DiffKind =
  | "missing" // expected a piece, saw empty
  | "unexpected" // expected empty, saw a piece
  | "wrong-color"
  | "wrong-type";

export interface SquareDiff {
  square: string;
  kind: DiffKind;
  expected: string; // label, see pieceLabel
  observed: string; // label, see obsLabel
  confidence: number;
  /** Below the confidence threshold: the camera itself is unsure. */
  lowConfidence: boolean;
}

export interface DiffOptions {
  /** A label below this confidence is "uncertain". Default 0.6. */
  minConfidence?: number;
}

export interface BoardDiff {
  /** True when every square agrees (low-confidence agreements still count as agreement). */
  match: boolean;
  diffs: SquareDiff[];
  /** Squares that agree but with low confidence. Reported, not fatal. */
  uncertain: string[];
}

function squareAgrees(exp: Piece | null, o: SquareObservation): DiffKind | null {
  if (!exp) return o.color ? "unexpected" : null;
  if (!o.color) return "missing";
  if (o.color !== exp.color) return "wrong-color";
  if (o.type && o.type !== exp.type) return "wrong-type";
  return null;
}

export function diffBoard(expected: ExpectedBoard, obs: Observation, opts: DiffOptions = {}): BoardDiff {
  const minConf = opts.minConfidence ?? 0.6;
  const diffs: SquareDiff[] = [];
  const uncertain: string[] = [];
  for (const sq of ALL_SQUARES) {
    const exp = expected[sq] ?? null;
    const o = squareObs(obs, sq);
    const kind = squareAgrees(exp, o);
    const low = o.confidence < minConf;
    if (kind) {
      diffs.push({
        square: sq,
        kind,
        expected: pieceLabel(exp),
        observed: obsLabel(o),
        confidence: o.confidence,
        lowConfidence: low,
      });
    } else if (low) {
      uncertain.push(sq);
    }
  }
  return { match: diffs.length === 0, diffs, uncertain };
}

/** Squares whose label differs between two observations (the raw change set). */
export function changedSquares(a: Observation, b: Observation): string[] {
  return ALL_SQUARES.filter((s) => obsLabel(squareObs(a, s)) !== obsLabel(squareObs(b, s)));
}

// --- explanation ----------------------------------------------------------------

export interface MoveContext {
  /** The move the robot tried to make (position BEFORE the move). */
  move?: Move;
  before?: Position;
}

function neighbours(sq: string): string[] {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]);
  const out: string[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const nf = f + df;
      const nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 1 && nr <= 8) out.push(`${String.fromCharCode(97 + nf)}${nr}`);
    }
  }
  return out;
}

/**
 * Give plausible reasons for a mismatch. These are hypotheses for the human,
 * not facts: the robot cannot see why, only what.
 */
export function explainDiff(d: BoardDiff, ctx: MoveContext = {}): string[] {
  const hints: string[] = [];
  if (d.match) return hints;
  const bySq = new Map(d.diffs.map((x) => [x.square, x]));

  if (d.diffs.length >= 8) {
    hints.push(
      `${d.diffs.length} squares differ: the board or the camera probably moved, or the calibration is lost. Re-run calibration.`,
    );
  }

  if (ctx.move) {
    const from = squareName(ctx.move.from);
    const to = squareName(ctx.move.to);
    const fromD = bySq.get(from);
    const toD = bySq.get(to);
    if (toD?.kind === "missing" && fromD?.kind === "unexpected") {
      hints.push(`The piece is still on ${from}: the grasp at ${from} probably failed (gripper closed on nothing).`);
    } else if (toD?.kind === "missing") {
      const stray = d.diffs.find((x) => x.kind === "unexpected" && neighbours(to).includes(x.square));
      if (stray) {
        hints.push(`A piece is on ${stray.square} next to ${to}: it was probably placed off-centre or fell over.`);
      } else {
        hints.push(`No piece on ${to} and none on ${from}: the piece was probably dropped in transit.`);
      }
    } else if (toD && (toD.kind === "wrong-color" || toD.kind === "wrong-type")) {
      hints.push(
        `${to} shows ${toD.observed} instead of ${toD.expected}: the captured piece may not have been removed, or the label is wrong.`,
      );
    }
    if (ctx.before) {
      // Captured piece left on the board (en passant square differs from `to`).
      for (const x of d.diffs) {
        if (x.kind === "unexpected" && x.square !== from && x.square !== to && !neighbours(to).includes(x.square)) {
          hints.push(`Unexpected piece on ${x.square}: a piece was moved by someone else, or it is a false detection.`);
        }
      }
    }
    const offPath = d.diffs.filter(
      (x) => x.kind === "missing" && x.square !== from && x.square !== to,
    );
    for (const x of offPath) {
      hints.push(`${x.square} looks empty but should hold ${x.expected}: knocked over by the arm, or occluded (arm or hand in view).`);
    }
  } else {
    for (const x of d.diffs.filter((y) => y.kind === "missing")) {
      hints.push(`${x.square} looks empty but should hold ${x.expected}: occluded, knocked over, or removed.`);
    }
  }

  const low = d.diffs.filter((x) => x.lowConfidence);
  if (low.length) {
    hints.push(
      `Low detection confidence on ${low.map((x) => `${x.square} (${x.confidence.toFixed(2)})`).join(", ")}: possibly a misdetection, glare or occlusion. Re-observe before acting.`,
    );
  }
  // De-duplicate while keeping order.
  return [...new Set(hints)];
}

// --- the human's move ----------------------------------------------------------

export type HumanMoveStatus =
  | "no-change" // the board still shows the current position
  | "move" // exactly one legal move explains the observation
  | "ambiguous" // more than one legal move explains it (e.g. promotion with unknown type)
  | "illegal"; // the board changed, but no legal move explains it

export interface HumanMoveResult {
  status: HumanMoveStatus;
  move?: Move;
  uci?: string;
  san?: string;
  /** All legal moves that match the observation. */
  candidates: { uci: string; san: string }[];
  /** Difference between the observation and the position BEFORE the human move. */
  changed: SquareDiff[];
  hints: string[];
}

function moveUci(m: Move): string {
  return `${squareName(m.from)}${squareName(m.to)}${m.promotion ?? ""}`;
}

/**
 * Work out which legal move (if any) the human made: apply every legal move
 * and keep those whose predicted board matches the observation. This works
 * with colour-only observations too (heuristic detector): the set of changed
 * squares and their colours usually pins down the move.
 */
export function detectHumanMove(pos: Position, obs: Observation, opts: DiffOptions = {}): HumanMoveResult {
  const before = diffBoard(expectedBoard(pos), obs, opts);
  if (before.match) return { status: "no-change", candidates: [], changed: [], hints: [] };

  const matches: Move[] = [];
  for (const m of legalMoves(pos, pos.turn)) {
    if (diffBoard(expectedBoard(applyMove(pos, m)), obs, opts).match) matches.push(m);
  }
  const candidates = matches.map((m) => ({ uci: moveUci(m), san: moveToSan(pos, m) }));

  if (matches.length === 1) {
    const m = matches[0]!;
    return { status: "move", move: m, uci: candidates[0]!.uci, san: candidates[0]!.san, candidates, changed: before.diffs, hints: [] };
  }
  if (matches.length > 1) {
    const promos = matches.every((m) => m.promotion);
    return {
      status: "ambiguous",
      candidates,
      changed: before.diffs,
      hints: [
        promos
          ? "A promotion was made but the camera cannot tell the new piece type. Tell me which piece it is."
          : `The observation fits ${matches.length} legal moves (${candidates.map((c) => c.san).join(", ")}). Tell me which one you played.`,
      ],
    };
  }
  const hints = explainDiff(before);
  hints.unshift(
    `The board changed on ${before.diffs.map((x) => x.square).join(", ")}, but no legal move for ${pos.turn === "w" ? "White" : "Black"} explains it. Either the move is illegal, it is not finished yet, or the camera misread a square.`,
  );
  return { status: "illegal", candidates, changed: before.diffs, hints };
}
