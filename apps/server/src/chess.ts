import {
  applyMove,
  chooseMove,
  initialPosition,
  isInCheck,
  moveToSan,
  parseSan,
  planMove,
  squareToTarget,
  toFen,
  trayTarget,
  type Move,
  type PlanStep,
  type Position,
} from "@robot/chess";
import type { RobotController } from "./controller";
import { agentMove } from "./agent";

/**
 * Drives a chess game: applies a SAN move, plans the arm actions, plays them
 * on the controller, and (optionally) answers with a bot/agent move.
 */
export class ChessSession {
  private pos: Position = initialPosition();
  // The twin is the opponent by default (plays Black; the user plays White).
  private opponent = true;
  private elo = 1200;
  private busy = false;
  private lastSan = "";
  private readonly listeners = new Set<() => void>();

  constructor(private readonly controller: RobotController) {
    controller.subscribe(() => {});
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
    return this.elo;
  }

  get moveHistoryLast(): string {
    return this.lastSan;
  }

  async playSan(san: string): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: "robot busy" };
    const move = parseSan(this.pos, san);
    if (!move) return { ok: false, error: `illegal move: ${san}` };
    this.busy = true;
    try {
      await this.apply(move);
      // Reply with the opponent (black) if enabled: try the LLM/model-router
      // agent first (if configured), otherwise the built-in bot.
      if (this.opponent && this.pos.turn === "b") {
        const reply = await this.opponentMove();
        if (reply) await this.apply(reply);
      }
      return { ok: true };
    } finally {
      this.busy = false;
    }
  }

  setOpponent(enabled: boolean, elo?: number): void {
    this.opponent = enabled;
    if (elo) this.elo = Math.max(100, Math.min(2800, elo));
    this.emit();
  }

  reset(): void {
    this.pos = initialPosition();
    this.lastSan = "";
    this.emit();
  }

  private async opponentMove(): Promise<Move | null> {
    const fen = this.fen;
    const san = await agentMove(fen);
    if (san) {
      const m = parseSan(this.pos, san);
      if (m) return m;
    }
    return chooseMove(this.pos, this.elo);
  }

  private async apply(move: Move): Promise<void> {
    const san = moveToSan(this.pos, move);
    const steps: PlanStep[] = planMove(this.pos, move);
    this.pos = applyMove(this.pos, move);
    this.lastSan = san;
    await executeSteps(this.controller, steps);
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

async function executeSteps(controller: RobotController, steps: PlanStep[]): Promise<void> {
  for (const step of steps) {
    if (step.op === "pick") {
      const target = step.square ? squareToTarget(step.square) : trayTarget();
      if (await controller.setTarget(target)) {
        await controller.waitUntilSettled();
        await controller.setGripper(false); // close to grab
        await controller.waitUntilSettled();
      }
    } else {
      const target = "tray" in step ? trayTarget() : squareToTarget(step.square!);
      if (await controller.setTarget(target)) {
        await controller.waitUntilSettled();
        await controller.setGripper(true); // open to release
        await controller.waitUntilSettled();
      }
    }
  }
}
