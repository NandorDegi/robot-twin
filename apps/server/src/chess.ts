/**
 * The chess loop of the server. There is ONE loop: the brain's GameLoop
 * (@robot/brain), wired to this server's controller, camera and safety rules.
 *
 *   observe -> decide (brain) -> predict -> act -> observe -> compare
 *
 * The decision maker is the brain: intuition (a searchless policy network)
 * plus reflection (a small LM choosing among the candidates). There is no
 * search engine in the decision path. The brain only PROPOSES: the loop
 * accepts a legal move only, and every motion is validated by the controller.
 *
 * Safety rules kept from the closed chess loop (docs/NUC-BRINGUP.md):
 *  - the loop is stopped at server start; a person presses Start;
 *  - calibration gate: no start and no step without a valid calibration;
 *  - pre-check: the camera must show the expected board before the arm moves;
 *  - post-check: the camera must show the predicted board after the move;
 *  - any halt (mismatch, illegal human move, arm or camera failure) DISABLES
 *    the robot; a person answers the question and enables it again;
 *  - single commander: the controller is the only path to the arm, manual
 *    motion is refused while the loop runs (ws.ts), and the arm parks out of
 *    the camera view before every look;
 *  - a real robot needs a real camera check (no simulated board).
 *
 * Env (deploy/robot-twin.env.template, docs/BRAIN.md):
 *   BRAIN_OBSERVER=vision|observe|sim  VISION_URL  CHESS_REQUIRE_VISION
 *   CHESS_OBSERVE_POSE  CHESS_SETTLE_MS  BRAIN_LOG  BRAIN_POLL_MS
 *   BRAIN_ROBOT_COLOR  BRAIN_MIN_CONFIDENCE  BRAIN_COMMENTARY
 *   plus the brain variables of @robot/brain brainFromEnv.
 */
import {
  GameLoop,
  JsonlFileLog,
  OccupancyObserver,
  SimActor,
  SimObserver,
  SimWorld,
  VisionObserver,
  brainFromEnv,
  moveUci,
  type Actor,
  type AskHuman,
  type Brain,
  type CycleLog,
  type Fault,
  type LoopEvent,
  type LoopState,
  type Observation,
  type Observer,
  type ResolveAction,
} from "@robot/brain";
import { APPROACH_HEIGHT_MM, PANDA_READY_POSE } from "@robot/robot-config";
import { isInCheck, legalMoves, parseFen, parseSan, squareToTarget, trayTarget, type Move, type PlanStep } from "@robot/chess";
import type { BrainCommand, ServerMessage } from "@robot/protocol";
import type { RobotController } from "./controller";

export type ObserverKind = "vision" | "observe" | "sim";

/** Loop stage for the twin: the GameLoop state, or why the loop is not running. */
export type LoopStage = LoopState | "stopped" | "paused";

export interface LoopStatus {
  stage: LoopStage;
  message: string;
  /** Squares where the camera disagrees with the prediction (when halted). */
  mismatches: string[];
  /** True when the last robot move was confirmed by the camera. */
  verified: boolean;
}

export interface ChessSessionOptions {
  /** Which camera check: "vision" (/board, default with VISION_URL), "observe" (/observe, piece detector), "sim". */
  observerKind?: ObserverKind;
  visionUrl?: string;
  /** Refuse the simulated board (no camera check). Default: true on a real robot. */
  requireVision?: boolean;
  /** The loop runs only when this says ok (a valid saved calibration). */
  calibrationGate?: () => { ok: boolean; reason: string };
  /**
   * Joint pose (rad) where the arm does not hide the board from the overhead
   * camera. The arm goes there before every look. Default: the ready pose
   * turned 90 deg about joint1. Set CHESS_OBSERVE_POSE for your cell.
   */
  observePose?: number[];
  /** Wait (ms) after reaching the observe pose before reading the camera. */
  settleMs?: number;
  /** Builds the brain at each start. Default: brainFromEnv(env). */
  brain?: () => Brain;
  /** Override the camera (tests). */
  observer?: Observer;
  /** Override the log. Default: JSONL at BRAIN_LOG (logs/brain.jsonl). */
  log?: CycleLog;
  pollMs?: number;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_OBSERVE_POSE: number[] = (() => {
  const q = [...PANDA_READY_POSE];
  q[0] = Math.PI / 2;
  return q;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Executes the pick/place steps of one move on the controller: open, hover,
 * descend, grip, rise. Every motion is validated by the controller; a failed
 * motion or gripper command throws (the loop halts and asks the human).
 */
export class ControllerActor implements Actor {
  constructor(private readonly controller: RobotController) {}

  async execute(steps: PlanStep[]): Promise<void> {
    if (!this.controller.isEnabled) throw new Error("the arm is not enabled");
    for (const s of steps) {
      const what = "tray" in s ? "tray" : s.square;
      const target = "tray" in s ? trayTarget() : squareToTarget(s.square);
      await this.pickOrPlace(target, s.op === "pick", what);
    }
  }

  private async pickOrPlace(target: [number, number, number], pick: boolean, what: string): Promise<void> {
    const above: [number, number, number] = [target[0], target[1] + APPROACH_HEIGHT_MM, target[2]];
    const must = async (p: Promise<{ ok: boolean; error?: string }>, label: string) => {
      const r = await p;
      if (!r.ok) throw new Error(`${label} ${what}: ${r.error ?? "failed"}`);
    };
    if (pick) await must(this.controller.setGripper(true), "open gripper before picking at");
    await must(this.controller.moveToPosition(above, "down"), "approach");
    await must(this.controller.moveToPosition(target, "down"), "descend to");
    const g = await this.controller.setGripper(!pick);
    if (!g.ok) {
      await this.controller.moveToPosition(above, "down"); // leave the board area before stopping
      throw new Error(`${pick ? "grasp" : "release"} at ${what} failed: ${g.error ?? ""}`);
    }
    await must(this.controller.moveToPosition(above, "down"), "lift from");
  }
}

/** Parks the arm out of the camera view (when motion is enabled), waits, then looks. */
export class ParkedObserver implements Observer {
  constructor(
    private readonly controller: RobotController,
    private readonly inner: Observer,
    private readonly observePose: number[],
    private readonly settleMs: number,
  ) {}

  async observe(): Promise<Observation> {
    if (this.controller.isEnabled) {
      const r = await this.controller.moveJoints(this.observePose);
      if (!r.ok) throw new Error(`could not reach the observe pose: ${r.error ?? "failed"}`);
    }
    if (this.settleMs > 0) await sleep(this.settleMs);
    return this.inner.observe();
  }
}

class BothActors implements Actor {
  constructor(private readonly actors: Actor[]) {}
  async execute(steps: PlanStep[], move: Move): Promise<void> {
    for (const a of this.actors) await a.execute(steps, move);
  }
}

export interface BrainStatus {
  running: boolean;
  state: string;
  fen: string;
  moves: string[];
  brain: string;
  observer: string;
  question: AskHuman | null;
}

export class ChessSession {
  private loop: GameLoop | null = null;
  private brain: Brain | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stepping = false;
  private paused = "";
  private lastSan = "";
  private verified = false;
  private message = "";
  readonly world = new SimWorld();
  readonly observerKind: ObserverKind;
  private readonly env: Record<string, string | undefined>;
  private readonly visionUrl: string;
  private readonly requireVision: boolean;
  private readonly gate: (() => { ok: boolean; reason: string }) | null;
  private readonly observePose: number[];
  private readonly settleMs: number;
  private readonly pollMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: LoopEvent) => void>();

  constructor(
    private readonly controller: RobotController,
    private readonly opts: ChessSessionOptions = {},
  ) {
    this.env = opts.env ?? process.env;
    this.visionUrl = opts.visionUrl ?? this.env.VISION_URL ?? "";
    const kind = opts.observerKind ?? (this.env.BRAIN_OBSERVER as ObserverKind | undefined) ?? (this.visionUrl ? "vision" : "sim");
    if (kind !== "vision" && kind !== "observe" && kind !== "sim") throw new Error(`unknown BRAIN_OBSERVER=${kind} (vision | observe | sim)`);
    this.observerKind = kind;
    this.requireVision = opts.requireVision ?? controller.isReal;
    this.gate = opts.calibrationGate ?? null;
    this.observePose = opts.observePose ?? DEFAULT_OBSERVE_POSE;
    this.settleMs = opts.settleMs ?? 500;
    this.pollMs = opts.pollMs ?? Number(this.env.BRAIN_POLL_MS ?? 500);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Every loop event (decision, self-check, ask-human ...), for the twin. */
  onLoopEvent(fn: (e: LoopEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  get running(): boolean {
    return this.loop !== null;
  }

  /** True while the loop drives the arm or may do so at the next poll. */
  get isBusy(): boolean {
    if (this.stepping) return true;
    const s = this.loop?.state;
    return Boolean(s) && !this.paused && s !== "halted" && s !== "game-over";
  }

  get fen(): string {
    return this.loop?.fen ?? "";
  }

  get turn(): string {
    return this.loop ? parseFen(this.loop.fen).turn : "w";
  }

  get inCheck(): boolean {
    if (!this.loop) return false;
    const p = parseFen(this.loop.fen);
    return isInCheck(p, p.turn);
  }

  get moveHistoryLast(): string {
    return this.lastSan;
  }

  get deciderName(): string {
    return this.brain?.name ?? "";
  }

  get loopStatus(): LoopStatus {
    const q = this.loop?.question ?? null;
    const stage: LoopStage = !this.loop ? "stopped" : this.paused ? "paused" : this.loop.state;
    const message = this.paused || (q && this.loop?.state === "halted" ? q.message : this.message);
    return { stage, message, mismatches: q ? q.squares.map((s) => s.square) : [], verified: this.verified };
  }

  status(): BrainStatus {
    return {
      running: this.loop !== null,
      state: this.loopStatus.stage,
      fen: this.fen,
      moves: this.loop?.moves ?? [],
      brain: this.deciderName,
      observer: this.observerKind,
      question: this.loop?.state === "halted" ? this.loop.question : null,
    };
  }

  /** Move the arm out of the camera view (calibration wizard, operator button). */
  async moveToObservePose(): Promise<{ ok: boolean; error?: string }> {
    if (this.isBusy) return { ok: false, error: "the chess loop is running" };
    return this.controller.moveJoints(this.observePose);
  }

  async handle(cmd: BrainCommand): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (cmd.cmd) {
        case "start":
          return this.start(cmd.fen, cmd.robotColor);
        case "stop":
          await this.stop("stopped by the operator");
          return { ok: true };
        case "resume":
          return this.resume();
        case "resolve":
          return this.resolve(toResolve(cmd));
        case "simHuman":
          return this.simHuman(cmd.uci ?? "");
        case "simFault":
          if (this.observerKind !== "sim") return { ok: false, error: "simFault needs BRAIN_OBSERVER=sim" };
          this.world.inject(cmd.fault as Fault);
          return { ok: true };
        case "status":
          return { ok: true };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      this.emit();
    }
  }

  /** Start a new game. Refused without a valid calibration or a camera check. */
  async start(fen?: string, robotColor?: "w" | "b"): Promise<{ ok: boolean; error?: string }> {
    const refused = this.refusal();
    if (refused) {
      this.message = `refused: ${refused}`;
      this.emit();
      return { ok: false, error: refused };
    }
    await this.stop("new game");
    let brain: Brain;
    try {
      brain = this.opts.brain ? this.opts.brain() : brainFromEnv(this.env);
    } catch (err) {
      return this.refuse(`brain: ${(err as Error).message}`);
    }
    this.brain = brain;
    const inner: Observer =
      this.opts.observer ??
      (this.observerKind === "sim"
        ? new SimObserver(this.world, { knownTypes: this.env.BRAIN_SIM_TYPES !== "0" })
        : this.observerKind === "observe"
          ? new VisionObserver(this.visionUrl)
          : new OccupancyObserver(this.visionUrl));
    const arm = new ControllerActor(this.controller);
    const actor: Actor = this.observerKind === "sim" && !this.opts.observer ? new BothActors([arm, new SimActor(this.world)]) : arm;
    this.loop = new GameLoop({
      brain,
      observer: new ParkedObserver(this.controller, inner, this.observePose, this.settleMs),
      actor,
      log: this.opts.log ?? new JsonlFileLog(this.env.BRAIN_LOG ?? "logs/brain.jsonl"),
      onEvent: (e) => this.onEvent(e),
      robotColor: robotColor ?? (this.env.BRAIN_ROBOT_COLOR === "w" ? "w" : "b"),
      minConfidence: Number(this.env.BRAIN_MIN_CONFIDENCE ?? 0.6),
      commentary: this.env.BRAIN_COMMENTARY === "1",
      settleMs: Math.max(this.settleMs, 200),
    });
    this.lastSan = "";
    this.verified = false;
    this.message = `new game, brain ${brain.name}, camera ${this.observerKind}`;
    this.loop.start(fen);
    if (this.observerKind === "sim") this.world.reset(parseFen(this.loop.fen));
    this.kick();
    return { ok: true };
  }

  async stop(why = "stopped"): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.stepping) await sleep(20); // never drop the loop in the middle of a move
    this.loop = null;
    this.paused = "";
    this.message = why;
    await this.brain?.close?.().catch(() => {});
    this.brain = null;
    this.emit();
  }

  /** Continue after a pause (calibration became invalid, robot was disabled). */
  resume(): { ok: boolean; error?: string } {
    if (!this.loop) return { ok: false, error: "no game: press Start" };
    const refused = this.refusal();
    if (refused) return this.refuse(refused);
    this.paused = "";
    this.kick();
    return { ok: true };
  }

  /** The human answers the robot's question. The robot stays disabled until a person enables it. */
  async resolve(r: ResolveAction): Promise<{ ok: boolean; error?: string }> {
    if (!this.loop) return { ok: false, error: "no game" };
    if (this.stepping) return { ok: false, error: "robot busy" };
    this.stepping = true;
    try {
      await this.loop.resolve(r);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      this.stepping = false;
    }
    this.paused = "";
    this.kick();
    return { ok: true };
  }

  /**
   * A typed or spoken move of the human. With the simulated board the
   * simulated hand plays it; with a camera the human plays it on the board
   * (the camera is the only source of the human's move).
   */
  async playSan(san: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.loop) return { ok: false, error: "no game: press Start" };
    if (this.observerKind !== "sim") return { ok: false, error: "play the move on the board; the camera reads it" };
    const pos = parseFen(this.loop.fen);
    const m = parseSan(pos, san);
    if (!m) return { ok: false, error: `illegal move: ${san}` };
    return this.simHuman(moveUci(m));
  }

  private simHuman(uci: string): { ok: boolean; error?: string } {
    if (this.observerKind !== "sim" || !this.loop) return { ok: false, error: "simHuman needs BRAIN_OBSERVER=sim and a running game" };
    const pos = parseFen(this.loop.fen);
    const m = legalMoves(pos, pos.turn).find((x) => moveUci(x) === uci);
    if (m) this.world.handPlay(m);
    else if (/^[a-h][1-8][a-h][1-8]$/.test(uci)) this.world.handMove(uci.slice(0, 2), uci.slice(2, 4)); // illegal on purpose
    else return { ok: false, error: `bad move ${uci}` };
    return { ok: true };
  }

  // --------------------------------------------------------------------------

  /** Why the loop must not run now, or "" when it may. */
  private refusal(): string {
    const g = this.gate?.();
    if (g && !g.ok) return g.reason;
    if (this.requireVision && this.observerKind === "sim") return "no camera check possible (BRAIN_OBSERVER=sim); refusing to move the real robot";
    if (this.observerKind !== "sim" && !this.visionUrl && !this.opts.observer) return "vision not configured (VISION_URL)";
    return "";
  }

  private refuse(reason: string): { ok: false; error: string } {
    this.message = `refused: ${reason}`;
    this.emit();
    return { ok: false, error: reason };
  }

  /** Poll the loop: one step at a time, never two at once. */
  private kick(): void {
    if (this.timer || !this.loop || this.paused) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const loop = this.loop;
    if (!loop || this.stepping || this.paused) return;
    if (loop.state === "halted" || loop.state === "game-over") return this.emit();
    const refused = this.refusal();
    if (refused) {
      this.paused = `paused: ${refused}`;
      return this.emit();
    }
    if (loop.state === "robot-turn" && !this.controller.isEnabled) {
      // No motion without a person: wait until somebody enables the robot.
      const m = "my move: the robot is disabled; check the board and the arm, then press Enable";
      if (this.message !== m) {
        this.message = m;
        this.emit();
      }
      return this.kick();
    }
    this.stepping = true;
    try {
      await loop.step();
    } catch (err) {
      this.onEvent({ type: "error", message: (err as Error).message });
    } finally {
      this.stepping = false;
    }
    if (this.loop === loop) this.kick();
    this.emit();
  }

  private onEvent(e: LoopEvent): void {
    switch (e.type) {
      case "ask-human":
        // Disable first: nothing moves until a person has looked.
        this.controller.setEnabled(false);
        this.verified = false;
        break;
      case "decision":
        this.verified = false;
        this.message = `${e.decision.brain} plays ${e.decision.san}`;
        break;
      case "verified":
        this.lastSan = e.san;
        this.verified = true;
        this.message = `${e.san} done and verified`;
        if (e.uci.length === 5) {
          this.message += `; promotion: replace the pawn on ${e.uci.slice(2, 4)} with a ${e.uci[4]!.toUpperCase()}`;
        }
        break;
      case "human-move":
        this.lastSan = e.san;
        this.message = `human played ${e.san}`;
        break;
      case "game-over":
        this.message = `game over ${e.result}`;
        break;
      case "error":
        this.message = e.message;
        break;
      default:
        break;
    }
    for (const fn of this.eventListeners) {
      try {
        fn(e);
      } catch {
        /* a UI error must not stop the loop */
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function toResolve(cmd: BrainCommand): ResolveAction {
  switch (cmd.action) {
    case "set-fen":
      if (!cmd.fen) throw new Error("set-fen needs fen");
      return { action: "set-fen", fen: cmd.fen };
    case "choose-move":
      if (!cmd.uci) throw new Error("choose-move needs uci");
      return { action: "choose-move", uci: cmd.uci };
    case "accept-prediction":
      return { action: "accept-prediction" };
    default:
      return { action: "retry" };
  }
}

/** Server -> twin messages that describe the loop. */
export function loopMessages(chess: ChessSession): ServerMessage[] {
  return [
    { type: "chess", fen: chess.fen, turn: chess.turn, lastSan: chess.moveHistoryLast, check: chess.inCheck, running: chess.running },
    { type: "loop", ...chess.loopStatus, decider: chess.deciderName },
    { type: "brainStatus", status: chess.status() },
  ];
}
