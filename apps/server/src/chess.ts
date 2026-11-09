import { APPROACH_HEIGHT_MM, PANDA_READY_POSE } from "@robot/robot-config";
import {
  applyMove,
  diffOccupancy,
  inferMove,
  initialPosition,
  isInCheck,
  moveToSan,
  occupancyOf,
  parseSan,
  planMove,
  squareName,
  squareToTarget,
  toFen,
  trayTarget,
  type Color,
  type Move,
  type Position,
} from "@robot/chess";
import type { RobotController } from "./controller";
import { EngineDecider, type MoveDecider } from "./decider";
import type { BoardObserver } from "./observer";

export type LoopStage = "idle" | "observing" | "deciding" | "moving" | "verifying" | "manual" | "fault";

export interface LoopStatus {
  stage: LoopStage;
  message: string;
  /** Squares where the camera disagrees with the tracked game. */
  mismatches: string[];
  /** True when the last robot move was confirmed by the camera. */
  verified: boolean;
}

export interface ChessSessionOptions {
  decider?: MoveDecider;
  observer?: BoardObserver | null;
  /** Refuse robot moves when no camera check is possible. Default: true on a real robot. */
  requireVision?: boolean;
  /** Colour the robot plays. Default black. */
  robotColor?: Color;
  /**
   * Joint pose (rad) where the arm does not hide the board from the overhead
   * camera. The robot goes there before every camera check and after each
   * move. Default: the ready pose turned 90 deg about joint1 (arm to the
   * robot's left). Set CHESS_OBSERVE_POSE for your cell.
   */
  observePose?: number[];
  /** Wait (ms) after reaching the observe pose before reading the camera. */
  settleMs?: number;
  /**
   * The loop runs only when this says ok (calibration wizard: a valid saved
   * calibration). Default: no check.
   */
  calibrationGate?: () => { ok: boolean; reason: string };
}

export const DEFAULT_OBSERVE_POSE: number[] = (() => {
  const q = [...PANDA_READY_POSE];
  q[0] = Math.PI / 2;
  return q;
})();

class LoopError extends Error {
  constructor(
    message: string,
    readonly mismatches: string[] = [],
  ) {
    super(message);
  }
}

/**
 * The chess loop (see docs/NUC-BRINGUP.md, "The closed loop"):
 *
 *   camera -> board state (FEN) -> decision -> pick/place -> camera verifies
 *
 * 1. observe: the camera occupancy must match the tracked game (or differ by
 *    exactly one legal move of the human, which is then applied);
 * 2. decide: the MoveDecider proposes a move; only a legal move is accepted;
 * 3. act: pick/place with a vertical approach, every motion validated;
 * 4. verify: the camera occupancy must equal the expected position.
 * Any failure or mismatch stops the loop in "fault", disables the robot and
 * names the squares. Nothing continues until a person clears the fault.
 */
export class ChessSession {
  private pos: Position = initialPosition();
  private opponent = true;
  private readonly engine: EngineDecider;
  private decider: MoveDecider;
  private readonly observer: BoardObserver | null;
  private readonly requireVision: boolean;
  private readonly robotColor: Color;
  private readonly observePose: number[];
  private readonly settleMs: number;
  private readonly calibrationGate: (() => { ok: boolean; reason: string }) | null;
  private busy = false;
  private lastSan = "";
  private status: LoopStatus = { stage: "idle", message: "", mismatches: [], verified: false };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly controller: RobotController,
    opts: ChessSessionOptions = {},
  ) {
    this.engine = opts.decider instanceof EngineDecider ? opts.decider : new EngineDecider();
    this.decider = opts.decider ?? this.engine;
    this.observer = opts.observer ?? null;
    this.requireVision = opts.requireVision ?? controller.isReal;
    this.robotColor = opts.robotColor ?? "b";
    this.observePose = opts.observePose ?? DEFAULT_OBSERVE_POSE;
    this.settleMs = opts.settleMs ?? 500;
    this.calibrationGate = opts.calibrationGate ?? null;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Move the arm out of the camera view (calibration wizard, operator button). */
  async moveToObservePose(): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: "robot busy" };
    return this.controller.moveJoints(this.observePose);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get fen(): string {
    return toFen(this.pos);
  }

  get turn(): string {
    return this.pos.turn;
  }

  get inCheck(): boolean {
    return isInCheck(this.pos, this.pos.turn);
  }

  get opponentEnabled(): boolean {
    return this.opponent;
  }

  get eloLevel(): number {
    return this.engine.elo;
  }

  get moveHistoryLast(): string {
    return this.lastSan;
  }

  get loopStatus(): LoopStatus {
    return { ...this.status, mismatches: [...this.status.mismatches] };
  }

  get deciderName(): string {
    return this.decider.name;
  }

  setDecider(d: MoveDecider): void {
    this.decider = d;
    this.emit();
  }

  /** The robot plays the given SAN move on the board (for either side). */
  async playSan(san: string): Promise<{ ok: boolean; error?: string }> {
    const move = parseSan(this.pos, san);
    if (!move) return { ok: false, error: `illegal move: ${san}` };
    const r = await this.run(async () => {
      await this.executeMove(move);
      if (this.opponent && this.pos.turn === this.robotColor) await this.robotTurnInner();
    });
    return r;
  }

  /**
   * Read the board with the camera. If the human made one legal move, apply
   * it; then, if it is the robot's turn and the opponent is on, play.
   */
  async syncBoard(): Promise<{ ok: boolean; error?: string }> {
    return this.run(async () => {
      const occ = await this.observeOrThrow();
      const r = inferMove(this.pos, occ);
      if (r.kind === "mismatch") {
        throw new LoopError("the board does not match the game plus one legal move", r.squares);
      }
      if (r.kind === "ambiguous") {
        throw new LoopError(`the camera view fits ${r.moves.length} moves; play the move in the text box instead`);
      }
      if (r.kind === "move") {
        this.lastSan = moveToSan(this.pos, r.move);
        this.pos = applyMove(this.pos, r.move);
        this.setStatus("idle", `human played ${this.lastSan}`);
      } else {
        this.setStatus("idle", "no change on the board");
      }
      if (this.opponent && this.pos.turn === this.robotColor) await this.robotTurnInner();
    });
  }

  /** Let the decider choose a move for the side to move and play it. */
  async robotTurn(): Promise<{ ok: boolean; error?: string }> {
    return this.run(() => this.robotTurnInner());
  }

  setOpponent(enabled: boolean, elo?: number): void {
    this.opponent = enabled;
    if (elo) this.engine.elo = Math.max(100, Math.min(2800, elo));
    this.emit();
  }

  /** A person fixed the board (or accepts the state): leave the fault. */
  clearFault(): void {
    if (this.status.stage === "fault" || this.status.stage === "manual") this.setStatus("idle", "fault cleared by operator");
  }

  reset(): void {
    this.pos = initialPosition();
    this.lastSan = "";
    this.setStatus("idle", "new game");
  }

  // --------------------------------------------------------------------------

  private async run(fn: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: "robot busy" };
    if (this.status.stage === "fault") return { ok: false, error: `fault: ${this.status.message} (clear it first)` };
    const gate = this.calibrationGate?.();
    if (gate && !gate.ok) {
      this.setStatus("idle", `refused: ${gate.reason}`);
      return { ok: false, error: gate.reason };
    }
    this.busy = true;
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      const e = err instanceof LoopError ? err : new LoopError(String(err instanceof Error ? err.message : err));
      this.setStatus("fault", e.message, e.mismatches);
      this.controller.setEnabled(false);
      return { ok: false, error: e.message };
    } finally {
      this.busy = false;
    }
  }

  private async robotTurnInner(): Promise<void> {
    this.setStatus("deciding", `asking ${this.decider.name}`);
    const move = await this.decider.decide(this.pos);
    if (!move) {
      this.setStatus("idle", "no move (game over?)");
      return;
    }
    await this.executeMove(move);
  }

  private async executeMove(move: Move): Promise<void> {
    // 1. The board must be what we think it is before the arm touches it.
    if (this.observer) {
      this.setStatus("observing", "checking the board before the move");
      const occ = await this.observeOrThrow();
      const diff = diffOccupancy(occupancyOf(this.pos), occ);
      if (diff.length) throw new LoopError("the board does not match the game before the move", diff);
    } else if (this.requireVision) {
      throw new LoopError("no camera check possible (vision not configured); refusing to move the real robot");
    }

    // 2. Act.
    const san = moveToSan(this.pos, move);
    const next = applyMove(this.pos, move);
    this.setStatus("moving", `playing ${san}`);
    for (const step of planMove(this.pos, move)) {
      const isPick = step.op === "pick";
      const target = "tray" in step ? trayTarget() : squareToTarget(step.square!);
      await this.pickOrPlace(target, isPick, "tray" in step ? "tray" : step.square!);
    }
    await this.park();

    // The move is physically done: track it.
    this.pos = next;
    this.lastSan = san;

    if (move.promotion) {
      this.setStatus("manual", `promotion: replace the pawn on ${squareName(move.to)} with a ${move.promotion.toUpperCase()}, then press Sync/Clear`);
    }

    // 3. Verify with the camera.
    if (this.observer) {
      this.setStatus("verifying", `checking ${san} with the camera`);
      const occ = await this.observeOrThrow();
      const diff = diffOccupancy(occupancyOf(this.pos), occ);
      if (diff.length) {
        throw new LoopError(`after ${san} the board does not match: set the board to FEN ${toFen(this.pos)} by hand, then clear the fault`, diff);
      }
      this.status.verified = true;
      if (!move.promotion) this.setStatus("idle", `${san} done and verified`, [], true);
    } else if (!move.promotion) {
      this.setStatus("idle", `${san} done (NOT verified: no camera)`);
    }
  }

  private async pickOrPlace(target: [number, number, number], pick: boolean, what: string): Promise<void> {
    const above: [number, number, number] = [target[0], target[1] + APPROACH_HEIGHT_MM, target[2]];
    const must = async (p: Promise<{ ok: boolean; error?: string }>, label: string) => {
      const r = await p;
      if (!r.ok) throw new LoopError(`${label} ${what}: ${r.error ?? "failed"}`);
    };
    if (pick) await must(this.controller.setGripper(true), "open gripper before picking at");
    await must(this.controller.moveToPosition(above, "down"), "approach");
    await must(this.controller.moveToPosition(target, "down"), "descend to");
    const g = await this.controller.setGripper(!pick);
    if (!g.ok) {
      // Leave the board area before stopping.
      await this.controller.moveToPosition(above, "down");
      throw new LoopError(`${pick ? "grasp" : "release"} at ${what} failed: ${g.error ?? ""}`);
    }
    await must(this.controller.moveToPosition(above, "down"), "lift from");
  }

  /** Move the arm out of the camera view (only when motion is enabled). */
  private async park(): Promise<void> {
    if (!this.controller.isEnabled) return;
    const r = await this.controller.moveJoints(this.observePose);
    if (!r.ok) throw new LoopError(`could not reach the observe pose: ${r.error}`);
  }

  private async observeOrThrow() {
    if (!this.observer) throw new LoopError("vision not configured (VISION_URL)");
    await this.park();
    if (this.settleMs > 0) await new Promise((r) => setTimeout(r, this.settleMs));
    const o = await this.observer.observe();
    if (!o.ok) throw new LoopError(o.error);
    return o.occupancy;
  }

  private setStatus(stage: LoopStage, message: string, mismatches: string[] = [], verified = false): void {
    this.status = { stage, message, mismatches, verified };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
