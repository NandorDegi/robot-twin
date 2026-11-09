import type { Color, PieceType } from "@robot/chess";

/** Remaining time on the clocks (milliseconds), UCI style. All optional. */
export interface Clock {
  wtimeMs?: number;
  btimeMs?: number;
  wincMs?: number;
  bincMs?: number;
}

/** What a brain gets to decide on. */
export interface DecisionInput {
  /** Current position (FEN). The side to move is the side the brain plays. */
  fen: string;
  /**
   * Moves played so far, UCI ("e2e4"), from `startFen` (or the standard start
   * position when `startFen` is absent). Lets an engine see repetitions.
   */
  history: string[];
  /** FEN the history starts from. Optional. */
  startFen?: string;
  clock?: Clock;
  /** What the robot remembers from its own recent cycles (for reflection). */
  context?: SelfContext;
}

/** Short-term memory the loop hands to the brain: what just happened. */
export interface SelfContext {
  /** The human's last move, if known. */
  lastHumanMove?: { uci: string; san: string };
  /** Recent self-check notes, newest last ("cycle 12: mismatch on e4 (missing), resolved by human"). */
  recent: string[];
}

/** One candidate move from the intuition network. */
export interface Candidate {
  uci: string;
  san: string;
  /** Probability after the illegal moves are removed and the rest renormalised. */
  prob: number;
}

/** A brain's answer: one legal move and why. */
export interface Decision {
  /** Move in UCI notation ("e7e5", "e7e8q"). Always legal in `fen`. */
  uci: string;
  /** Move in SAN ("e5"), for humans. */
  san: string;
  /** Human-readable reason. Never contains secrets. */
  rationale: string;
  /** Name of the brain that actually produced the move (after fallbacks). */
  brain: string;
  /** The intuition network's top-k candidates (if the brain used one). */
  candidates?: Candidate[];
  /** Set when a primary brain failed and a fallback produced the move. */
  fallbackReason?: string;
  elapsedMs: number;
}

/**
 * The decision interface. Small on purpose: perception and acting live in the
 * loop, so a brain can be swapped (engine, LLM, learned policy) without
 * touching anything else.
 */
export interface Brain {
  readonly name: string;
  decide(input: DecisionInput): Promise<Decision>;
  /** Optional: explain a move in words (used for commentary). */
  commentary?(input: CommentaryInput): Promise<string | null>;
  /** Release resources (engine subprocess, ...). */
  close?(): Promise<void>;
}

export interface CommentaryInput {
  fenBefore: string;
  san: string;
  uci: string;
  rationale: string;
  /** "robot" when the robot played the move, "human" otherwise. */
  by: "robot" | "human";
}

// --- perception ---------------------------------------------------------------

/**
 * What the camera thinks is on one square.
 *  - `color: null` -> the square is seen as empty.
 *  - `type: null` with a color -> a piece of that colour, type unknown (the
 *    heuristic detector cannot tell piece types apart).
 *  - `confidence` in [0, 1] for this square's label (0 = no idea).
 */
export interface SquareObservation {
  color: Color | null;
  type: PieceType | null;
  confidence: number;
}

/** One camera observation of the whole board. */
export interface Observation {
  /** Square name ("e4") -> observation. Missing squares count as unknown (confidence 0, empty). */
  squares: Record<string, SquareObservation>;
  /** Where it came from ("vision:yolo", "vision:heuristic", "sim", ...). */
  source: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Optional id of the camera frame (for linking the log to saved frames). */
  frameId?: string;
}
