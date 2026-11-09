/**
 * A simulated physical board. It is the "world" for the simulator and tests:
 * the SimActor moves pieces on it (with optional faults), the SimObserver
 * looks at it (with optional degradation), and the simulated human moves
 * pieces on it by hand.
 */
import { parseSquare, squareName, type Move, type Piece, type PlanStep, type Position } from "@robot/chess";
import type { Actor, Observer } from "./loop";
import { ALL_SQUARES, expectedBoard } from "./selfcheck";
import type { Observation, SquareObservation } from "./types";

export type Fault =
  | { kind: "miss-grasp" } // next pick closes on nothing; the piece stays
  | { kind: "drop" } // the next carried piece falls off the board
  | { kind: "offset"; to: string }; // the next place lands on another square

export class SimWorld {
  board: Record<string, Piece | null> = {};
  hand: Piece | null = null;
  tray: Piece[] = [];
  private faults: Fault[] = [];

  constructor(pos?: Position) {
    if (pos) this.reset(pos);
  }

  reset(pos: Position): void {
    this.board = expectedBoard(pos);
    this.hand = null;
    this.tray = [];
    this.faults = [];
  }

  inject(f: Fault): void {
    this.faults.push(f);
  }

  private takeFault(kind: Fault["kind"]): Fault | undefined {
    const i = this.faults.findIndex((f) => f.kind === kind);
    return i >= 0 ? this.faults.splice(i, 1)[0] : undefined;
  }

  step(s: PlanStep): void {
    if (s.op === "pick") {
      if (this.takeFault("miss-grasp")) return;
      this.hand = this.board[s.square] ?? null;
      this.board[s.square] = null;
      if (this.hand && this.takeFault("drop")) this.hand = null;
      return;
    }
    if (!this.hand) return;
    if ("tray" in s) {
      this.tray.push(this.hand);
    } else {
      const off = this.takeFault("offset") as { kind: "offset"; to: string } | undefined;
      this.board[off ? off.to : s.square] = this.hand;
    }
    this.hand = null;
  }

  /** A human moves a piece by hand (no legality check: humans can do anything). */
  handMove(from: string, to: string, promoteTo?: Piece["type"]): void {
    const p = this.board[from] ?? null;
    this.board[from] = null;
    if (p) this.board[to] = promoteTo ? { color: p.color, type: promoteTo } : p;
  }

  /** A human plays a legal move, including the rook in castling and the e.p. capture. */
  handPlay(move: Move): void {
    const from = squareName(move.from);
    const to = squareName(move.to);
    if (move.flags.includes("ep")) this.board[squareName({ r: move.from.r, c: move.to.c })] = null;
    if (move.flags.includes("castle-k")) this.handMove(squareName({ r: move.from.r, c: 7 }), squareName({ r: move.from.r, c: 5 }));
    if (move.flags.includes("castle-q")) this.handMove(squareName({ r: move.from.r, c: 0 }), squareName({ r: move.from.r, c: 3 }));
    this.handMove(from, to, move.promotion);
  }

  remove(square: string): void {
    parseSquare(square);
    this.board[square] = null;
  }
}

export class SimActor implements Actor {
  constructor(private readonly world: SimWorld) {}
  async execute(steps: PlanStep[]): Promise<void> {
    for (const s of steps) this.world.step(s);
  }
}

export interface SimObserverOptions {
  /** Per-square confidence of the simulated detector. */
  confidence?: number;
  /** false = colour only (like the heuristic detector). */
  knownTypes?: boolean;
  /** Squares the simulated camera cannot see this time (occlusion): label empty, confidence 0.2. */
  occluded?: () => string[];
}

export class SimObserver implements Observer {
  constructor(
    private readonly world: SimWorld,
    private readonly opts: SimObserverOptions = {},
  ) {}

  async observe(): Promise<Observation> {
    const occ = new Set(this.opts.occluded?.() ?? []);
    const squares: Record<string, SquareObservation> = {};
    for (const sq of ALL_SQUARES) {
      const p = this.world.board[sq] ?? null;
      if (occ.has(sq)) {
        squares[sq] = { color: null, type: null, confidence: 0.2 };
        continue;
      }
      const c = this.opts.confidence ?? 0.95;
      squares[sq] = p ? { color: p.color, type: this.opts.knownTypes === false ? null : p.type, confidence: c } : { color: null, type: null, confidence: c };
    }
    return { squares, source: "sim", timestamp: new Date().toISOString() };
  }
}
