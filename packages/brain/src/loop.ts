/**
 * The closed loop: observe -> decide -> predict -> act -> observe -> compare.
 *
 * The robot never assumes its action worked. After each move it looks again
 * and compares what it sees with what it predicted. On any difference it
 * stops, says which squares differ and why that might be, and asks the human.
 */
import {
  applyMove,
  initialPosition,
  isCheckmate,
  isStalemate,
  legalMoves,
  parseFen,
  planMove,
  toFen,
  type Move,
  type PlanStep,
  type Position,
} from "@robot/chess";
import { moveUci } from "./intuition";
import {
  changedSquares,
  detectHumanMove,
  diffBoard,
  encodeExpected,
  encodeObservation,
  expectedBoard,
  explainDiff,
  type BoardDiff,
  type SquareDiff,
} from "./selfcheck";
import type { Brain, Clock, Decision, Observation, SelfContext } from "./types";

export interface Observer {
  observe(): Promise<Observation>;
}

export interface Actor {
  /** Carry out the pick/place steps of one move. Throws if a step fails. */
  execute(steps: PlanStep[], move: Move): Promise<void>;
}

export interface CycleLog {
  write(record: CycleRecord): void | Promise<void>;
}

export type LoopState = "idle" | "awaiting-human" | "robot-turn" | "acting" | "verifying" | "halted" | "game-over";

export type Verdict =
  | "ok" // robot move verified
  | "mismatch" // robot move: observation differs from prediction
  | "pre-check-failed" // board differed from the expected position before the robot moved
  | "human-move" // legal human move detected
  | "illegal" // board changed, no legal move explains it
  | "ambiguous"
  | "unstable" // observation still changing (hand in view)
  | "no-change"
  | "resolved" // human resolved a halt
  | "error";

/** One line of the JSONL log. This is the dataset for learning later. */
export interface CycleRecord {
  v: 1;
  ts: string;
  game: string;
  cycle: number;
  phase: "robot" | "human" | "resolve";
  fenBefore: string;
  fenAfter: string;
  decision?: Pick<Decision, "uci" | "san" | "brain" | "rationale" | "candidates" | "fallbackReason" | "elapsedMs">;
  plan?: PlanStep[];
  /** 64 labels, FEN order (a8..h1): the board the robot expected to see. */
  predicted?: string;
  observed?: { board: string; confidence: number[]; source: string; frameId?: string };
  diff?: SquareDiff[];
  uncertain?: string[];
  verdict: Verdict;
  hints?: string[];
  humanMove?: { uci: string; san: string };
  commentary?: string | null;
  error?: string;
}

export interface AskHuman {
  reason: Verdict;
  message: string;
  squares: SquareDiff[];
  hints: string[];
  /** What the human can answer with (see GameLoop.resolve). */
  options: ResolveAction["action"][];
  candidates?: { uci: string; san: string }[];
}

export type LoopEvent =
  | { type: "state"; state: LoopState; fen: string; turn: string }
  | { type: "decision"; decision: Decision }
  | { type: "verified"; uci: string; san: string; uncertain: string[] }
  | { type: "human-move"; uci: string; san: string }
  | { type: "ask-human"; ask: AskHuman }
  | { type: "commentary"; text: string }
  | { type: "game-over"; result: string }
  | { type: "error"; message: string };

export type ResolveAction =
  /** "I fixed the board, look again." */
  | { action: "retry" }
  /** "The board is right, the camera is wrong; continue with your prediction." */
  | { action: "accept-prediction" }
  /** "This is the true position." */
  | { action: "set-fen"; fen: string }
  /** For an ambiguous human move: "this is what I played." */
  | { action: "choose-move"; uci: string };

export interface GameLoopOptions {
  brain: Brain;
  observer: Observer;
  actor: Actor;
  log?: CycleLog;
  onEvent?: (e: LoopEvent) => void;
  robotColor?: "w" | "b";
  minConfidence?: number;
  /** Consecutive identical observations needed before a human move is accepted. */
  stableFrames?: number;
  /** Re-observe this many times (with `settleMs` pause) before declaring a mismatch. */
  verifyAttempts?: number;
  settleMs?: number;
  /** Compare the board with the expected position before acting. Default true. */
  preCheck?: boolean;
  commentary?: boolean;
  clock?: () => Clock | undefined;
  gameId?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class GameLoop {
  private pos: Position = initialPosition();
  private startFen = toFen(initialPosition());
  private history: string[] = [];
  private stateV: LoopState = "idle";
  private cycle = 0;
  private lastObs: Observation | null = null;
  private stableCount = 0;
  private pending: { kind: "robot"; move: Move; predicted: Position } | { kind: "human" } | null = null;
  private memory: SelfContext = { recent: [] };
  private lastAsk: AskHuman | null = null;
  readonly gameId: string;

  constructor(private readonly o: GameLoopOptions) {
    this.gameId = o.gameId ?? new Date().toISOString().replace(/[:.]/g, "-");
  }

  get state(): LoopState {
    return this.stateV;
  }
  get fen(): string {
    return toFen(this.pos);
  }
  get moves(): string[] {
    return this.history.slice();
  }
  get question(): AskHuman | null {
    return this.lastAsk;
  }
  get robotColor(): "w" | "b" {
    return this.o.robotColor ?? "b";
  }

  start(fen?: string): void {
    this.pos = fen ? parseFen(fen) : initialPosition();
    this.startFen = toFen(this.pos);
    this.history = [];
    this.cycle = 0;
    this.memory = { recent: [] };
    this.lastObs = null;
    this.stableCount = 0;
    this.pending = null;
    this.lastAsk = null;
    this.setState(this.pos.turn === this.robotColor ? "robot-turn" : "awaiting-human");
  }

  /** Run whatever the current state needs: one robot move, or one look for the human's move. */
  async step(): Promise<CycleRecord | null> {
    if (this.stateV === "robot-turn") return this.robotTurn();
    if (this.stateV === "awaiting-human") return this.humanTurn();
    return null;
  }

  // --- robot ------------------------------------------------------------------

  async robotTurn(): Promise<CycleRecord> {
    if (this.stateV !== "robot-turn") throw new Error(`not the robot's turn (state ${this.stateV})`);
    const fenBefore = this.fen;
    const base = this.record("robot", fenBefore);

    // 1. Observe: is the board what I believe it is?
    if (this.o.preCheck ?? true) {
      let obs0: Observation;
      try {
        obs0 = await this.o.observer.observe();
      } catch (err) {
        return this.cameraFailed(base, err, "before my move");
      }
      const d0 = diffBoard(expectedBoard(this.pos), obs0, this.diffOpts());
      if (!d0.match) {
        const hints = explainDiff(d0);
        hints.unshift("The board does not match the position I expect, before my move. I will not move.");
        return this.halt({ ...base, observed: this.enc(obs0), diff: d0.diffs, uncertain: d0.uncertain, verdict: "pre-check-failed", hints }, ["retry", "set-fen"]);
      }
    }

    // 2. Decide.
    this.setState("robot-turn");
    let decision: Decision;
    try {
      decision = await this.o.brain.decide({
        fen: fenBefore,
        history: this.history.slice(),
        startFen: this.startFen,
        clock: this.o.clock?.(),
        context: { ...this.memory, recent: this.memory.recent.slice(-8) },
      });
    } catch (err) {
      return this.fail(base, err);
    }
    const move = legalMoves(this.pos, this.pos.turn).find((m) => moveUci(m) === decision.uci);
    if (!move) return this.fail(base, new Error(`brain ${decision.brain} returned an illegal move ${decision.uci}`));
    this.emit({ type: "decision", decision });
    const decRec = {
      uci: decision.uci,
      san: decision.san,
      brain: decision.brain,
      rationale: decision.rationale,
      candidates: decision.candidates,
      fallbackReason: decision.fallbackReason,
      elapsedMs: decision.elapsedMs,
    };

    // 3. Predict.
    const predicted = applyMove(this.pos, move);
    const plan = planMove(this.pos, move);

    // 4. Act.
    this.setState("acting");
    try {
      await this.o.actor.execute(plan, move);
    } catch (err) {
      this.pending = { kind: "robot", move, predicted };
      const hints = [`The arm reported a failure: ${(err as Error).message}. Check the arm and the board.`];
      return this.halt({ ...base, decision: decRec, plan, predicted: encodeExpected(expectedBoard(predicted)), verdict: "error", error: (err as Error).message, hints }, ["retry", "accept-prediction", "set-fen"]);
    }

    // 5. Observe again and 6. compare.
    this.setState("verifying");
    let checked: { obs: Observation; diff: BoardDiff };
    try {
      checked = await this.verify(predicted);
    } catch (err) {
      this.pending = { kind: "robot", move, predicted };
      return this.cameraFailed({ ...base, decision: decRec, plan, predicted: encodeExpected(expectedBoard(predicted)) }, err, `after my move ${decision.san}`, true);
    }
    const { obs, diff } = checked;
    const rec: CycleRecord = {
      ...base,
      decision: decRec,
      plan,
      predicted: encodeExpected(expectedBoard(predicted)),
      observed: this.enc(obs),
      diff: diff.diffs,
      uncertain: diff.uncertain,
      verdict: diff.match ? "ok" : "mismatch",
    };
    if (!diff.match) {
      this.pending = { kind: "robot", move, predicted };
      rec.hints = explainDiff(diff, { move, before: this.pos });
      this.remember(`my move ${decision.san}: mismatch on ${diff.diffs.map((x) => `${x.square} (${x.kind})`).join(", ")}`);
      return this.halt(rec, ["retry", "accept-prediction", "set-fen"]);
    }
    this.commit(move, predicted);
    rec.fenAfter = this.fen;
    if (diff.uncertain.length) this.remember(`my move ${decision.san}: verified, low confidence on ${diff.uncertain.join(" ")}`);
    this.emit({ type: "verified", uci: decision.uci, san: decision.san, uncertain: diff.uncertain });
    rec.commentary = await this.comment(fenBefore, decision.san, decision.uci, decision.rationale, "robot");
    await this.writeLog(rec);
    this.afterMove();
    return rec;
  }

  private async verify(predicted: Position): Promise<{ obs: Observation; diff: BoardDiff }> {
    const attempts = Math.max(1, this.o.verifyAttempts ?? 3);
    let obs!: Observation;
    let diff!: BoardDiff;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(this.o.settleMs ?? 700);
      obs = await this.o.observer.observe();
      diff = diffBoard(expectedBoard(predicted), obs, this.diffOpts());
      if (diff.match) break;
    }
    return { obs, diff };
  }

  // --- human ------------------------------------------------------------------

  /** Look once. Accepts a move only after `stableFrames` identical observations. */
  async humanTurn(): Promise<CycleRecord | null> {
    if (this.stateV !== "awaiting-human") throw new Error(`not the human's turn (state ${this.stateV})`);
    let obs: Observation;
    try {
      obs = await this.o.observer.observe();
    } catch (err) {
      this.pending = { kind: "human" };
      return this.cameraFailed(this.record("human", this.fen), err, "while I waited for your move");
    }
    const prev = this.lastObs;
    this.lastObs = obs;
    this.stableCount = prev && changedSquares(prev, obs).length === 0 ? this.stableCount + 1 : 1;
    if (this.stableCount < Math.max(1, this.o.stableFrames ?? 2)) return null; // still moving / hand in view

    const fenBefore = this.fen;
    const res = detectHumanMove(this.pos, obs, this.diffOpts());
    if (res.status === "no-change") return null;
    const base = { ...this.record("human", fenBefore), observed: this.enc(obs), diff: res.changed };
    if (res.status === "move") {
      const next = applyMove(this.pos, res.move!);
      this.commit(res.move!, next);
      this.memory.lastHumanMove = { uci: res.uci!, san: res.san! };
      const rec: CycleRecord = { ...base, fenAfter: this.fen, verdict: "human-move", humanMove: { uci: res.uci!, san: res.san! } };
      this.emit({ type: "human-move", uci: res.uci!, san: res.san! });
      await this.writeLog(rec);
      this.afterMove();
      return rec;
    }
    this.pending = { kind: "human" };
    this.remember(`human turn: ${res.status} (${res.changed.map((x) => x.square).join(" ")})`);
    return this.halt(
      { ...base, verdict: res.status, hints: res.hints },
      res.status === "ambiguous" ? ["choose-move", "retry", "set-fen"] : ["retry", "set-fen"],
      res.candidates,
    );
  }

  // --- human resolves a halt ------------------------------------------------------

  async resolve(r: ResolveAction): Promise<CycleRecord> {
    if (this.stateV !== "halted") throw new Error("nothing to resolve");
    const fenBefore = this.fen;
    const rec: CycleRecord = { ...this.record("resolve", fenBefore), verdict: "resolved", hints: [`human: ${r.action}`] };
    const pending = this.pending;
    this.lastAsk = null;
    switch (r.action) {
      case "set-fen": {
        this.pos = parseFen(r.fen); // history continuity is lost: restart the history from here
        this.startFen = toFen(this.pos);
        this.history = [];
        break;
      }
      case "accept-prediction":
        if (pending?.kind === "robot") this.commit(pending.move, pending.predicted);
        break;
      case "choose-move": {
        const m = legalMoves(this.pos, this.pos.turn).find((x) => moveUci(x) === r.uci);
        if (!m) throw new Error(`illegal move ${r.uci}`);
        this.commit(m, applyMove(this.pos, m));
        break;
      }
      case "retry":
        if (pending?.kind === "robot") {
          // The human says the board is fixed: verify against the prediction again.
          this.setState("verifying");
          let checked: { obs: Observation; diff: BoardDiff };
          try {
            checked = await this.verify(pending.predicted);
          } catch (err) {
            return this.cameraFailed(rec, err, "when I looked again", true);
          }
          const { obs, diff } = checked;
          rec.observed = this.enc(obs);
          rec.diff = diff.diffs;
          if (!diff.match) {
            rec.verdict = "mismatch";
            rec.hints = explainDiff(diff, { move: pending.move, before: this.pos });
            return this.halt(rec, ["retry", "accept-prediction", "set-fen"]);
          }
          this.commit(pending.move, pending.predicted);
        }
        break;
    }
    this.remember(`resolved by the human (${r.action})`);
    this.pending = null;
    this.lastObs = null;
    this.stableCount = 0;
    rec.fenAfter = this.fen;
    await this.writeLog(rec);
    this.afterMove();
    return rec;
  }

  // --- helpers ------------------------------------------------------------------

  private commit(move: Move, next: Position): void {
    this.history.push(moveUci(move));
    this.pos = next;
  }

  private afterMove(): void {
    this.lastObs = null;
    this.stableCount = 0;
    if (isCheckmate(this.pos) || isStalemate(this.pos)) {
      const result = isCheckmate(this.pos) ? (this.pos.turn === "w" ? "0-1" : "1-0") : "1/2-1/2";
      this.setState("game-over");
      this.emit({ type: "game-over", result });
      return;
    }
    this.setState(this.pos.turn === this.robotColor ? "robot-turn" : "awaiting-human");
  }

  private async halt(rec: CycleRecord, options: ResolveAction["action"][], candidates?: { uci: string; san: string }[]): Promise<CycleRecord> {
    const squares = rec.diff ?? [];
    const what = squares.length
      ? squares.map((x) => `${x.square}: expected ${x.expected === "." ? "empty" : x.expected}, saw ${x.observed === "." ? "empty" : x.observed} (conf ${x.confidence.toFixed(2)})`).join("; ")
      : rec.error ?? rec.verdict;
    this.lastAsk = {
      reason: rec.verdict,
      message: `I stopped (${rec.verdict}). ${what}. Please check the board and tell me how to continue.`,
      squares,
      hints: rec.hints ?? [],
      options,
      candidates,
    };
    this.setState("halted");
    this.emit({ type: "ask-human", ask: this.lastAsk });
    await this.writeLog(rec);
    return rec;
  }

  /** The camera (or the arm parking for it) failed: never guess, stop and ask. */
  private async cameraFailed(base: CycleRecord, err: unknown, when: string, robotPending = false): Promise<CycleRecord> {
    const message = (err as Error).message ?? String(err);
    this.remember(`camera failed ${when}: ${message}`);
    const hints = [`I could not look at the board ${when}: ${message}. Check the camera, the calibration and the arm, then let me look again.`];
    const options: ResolveAction["action"][] = robotPending ? ["retry", "accept-prediction", "set-fen"] : ["retry", "set-fen"];
    return this.halt({ ...base, verdict: "error", error: message, hints }, options);
  }

  private async fail(base: CycleRecord, err: unknown): Promise<CycleRecord> {
    const message = (err as Error).message ?? String(err);
    this.emit({ type: "error", message });
    const rec: CycleRecord = { ...base, verdict: "error", error: message };
    return this.halt(rec, ["retry", "set-fen"]);
  }

  private async comment(fenBefore: string, san: string, uci: string, rationale: string, by: "robot" | "human"): Promise<string | null> {
    if (!this.o.commentary || !this.o.brain.commentary) return null;
    const text = await this.o.brain.commentary({ fenBefore, san, uci, rationale, by }).catch(() => null);
    if (text) this.emit({ type: "commentary", text });
    return text;
  }

  private remember(note: string): void {
    this.memory.recent.push(`cycle ${this.cycle}: ${note}`);
    if (this.memory.recent.length > 20) this.memory.recent.shift();
  }

  private record(phase: CycleRecord["phase"], fenBefore: string): CycleRecord {
    this.cycle += 1;
    return { v: 1, ts: new Date().toISOString(), game: this.gameId, cycle: this.cycle, phase, fenBefore, fenAfter: fenBefore, verdict: "error" };
  }

  private enc(obs: Observation): CycleRecord["observed"] {
    return { ...encodeObservation(obs), source: obs.source, frameId: obs.frameId };
  }

  private diffOpts() {
    return { minConfidence: this.o.minConfidence ?? 0.6 };
  }

  private async writeLog(rec: CycleRecord): Promise<void> {
    try {
      await this.o.log?.write(rec);
    } catch (err) {
      this.emit({ type: "error", message: `log write failed: ${(err as Error).message}` });
    }
  }

  private setState(s: LoopState): void {
    this.stateV = s;
    this.emit({ type: "state", state: s, fen: this.fen, turn: this.pos.turn });
  }

  private emit(e: LoopEvent): void {
    try {
      this.o.onEvent?.(e);
    } catch {
      /* a UI error must not stop the loop */
    }
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }
}

