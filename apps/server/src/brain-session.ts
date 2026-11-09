/**
 * Wires the robot's brain loop (@robot/brain GameLoop) into the server:
 * the controller is the actor, the vision service (or the simulated board) is
 * the observer, and every loop event goes to the twin over WebSocket.
 *
 * This is separate from ChessSession (playSan + bot). Use one or the other.
 *
 * Env (see docs/BRAIN.md):
 *   BRAIN_OBSERVER=sim|vision   VISION_URL=http://127.0.0.1:8081
 *   BRAIN_LOG=logs/brain.jsonl  BRAIN_POLL_MS=500  BRAIN_ROBOT_COLOR=b
 *   BRAIN_MIN_CONFIDENCE=0.6    BRAIN_COMMENTARY=0
 *   plus the brain variables of @robot/brain brainFromEnv.
 */
import {
  GameLoop,
  JsonlFileLog,
  SimActor,
  SimObserver,
  SimWorld,
  VisionObserver,
  brainFromEnv,
  moveUci,
  type Actor,
  type Brain,
  type Fault,
  type LoopEvent,
  type Observer,
  type ResolveAction,
} from "@robot/brain";
import { legalMoves, parseFen, squareToTarget, trayTarget, type Move, type PlanStep } from "@robot/chess";
import type { BrainCommand, ServerMessage } from "@robot/protocol";
import type { RobotController } from "./controller";

/** Height (mm) above the grab height for the approach and the retreat. */
const APPROACH_MM = 80;

/**
 * Executes pick/place steps on the controller with an approach from above:
 * hover -> descend -> grip -> rise. Throws on an unreachable target instead of
 * carrying on, so the loop stops and asks the human.
 */
export class ControllerActor implements Actor {
  constructor(private readonly controller: RobotController) {}

  private async go(p: [number, number, number], what: string): Promise<void> {
    const ok = await this.controller.setTarget(p);
    await this.controller.waitUntilSettled();
    if (!ok) throw new Error(`target not reached: ${what} (error ${this.controller.targetError.toFixed(1)} mm)`);
  }

  async execute(steps: PlanStep[]): Promise<void> {
    if (!this.controller.isEnabled) throw new Error("the arm is not enabled");
    for (const s of steps) {
      const name = "tray" in s ? "tray" : s.square;
      const t = "tray" in s ? trayTarget() : squareToTarget(s.square);
      const above: [number, number, number] = [t[0], t[1] + APPROACH_MM, t[2]];
      if (s.op === "pick") await this.controller.setGripper(true);
      await this.go(above, `above ${name}`);
      await this.go(t, `${s.op} ${name}`);
      await this.controller.setGripper(s.op === "place"); // pick: close, place: open
      await this.go(above, `rise from ${name}`);
    }
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
  question: unknown;
}

export class BrainSession {
  private loop: GameLoop | null = null;
  private brain: Brain | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  readonly world = new SimWorld();
  private readonly observerKind: "sim" | "vision";

  constructor(
    private readonly controller: RobotController,
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.observerKind = env.BRAIN_OBSERVER === "vision" ? "vision" : "sim";
  }

  status(): BrainStatus {
    return {
      running: this.loop !== null,
      state: this.loop?.state ?? "idle",
      fen: this.loop?.fen ?? "",
      moves: this.loop?.moves ?? [],
      brain: this.brain?.name ?? "",
      observer: this.observerKind,
      question: this.loop?.question ?? null,
    };
  }

  async handle(cmd: BrainCommand): Promise<void> {
    switch (cmd.cmd) {
      case "start":
        await this.start(cmd.fen, cmd.robotColor);
        break;
      case "stop":
        await this.stop();
        break;
      case "resolve":
        if (!this.loop) throw new Error("brain not running");
        await this.loop.resolve(toResolve(cmd));
        this.kick();
        break;
      case "simHuman": {
        if (this.observerKind !== "sim" || !this.loop) throw new Error("simHuman needs BRAIN_OBSERVER=sim and a running game");
        const pos = parseFen(this.loop.fen);
        const m = legalMoves(pos, pos.turn).find((x) => moveUci(x) === cmd.uci);
        if (m) this.world.handPlay(m);
        else if (cmd.uci && /^[a-h][1-8][a-h][1-8]$/.test(cmd.uci)) this.world.handMove(cmd.uci.slice(0, 2), cmd.uci.slice(2, 4)); // illegal on purpose
        else throw new Error(`bad move ${cmd.uci}`);
        break;
      }
      case "simFault":
        if (this.observerKind !== "sim") throw new Error("simFault needs BRAIN_OBSERVER=sim");
        this.world.inject(cmd.fault as Fault);
        break;
      case "status":
        break;
    }
    this.sendStatus();
  }

  private async start(fen?: string, robotColor?: "w" | "b"): Promise<void> {
    await this.stop();
    this.brain = brainFromEnv(this.env);
    const observer: Observer =
      this.observerKind === "vision"
        ? new VisionObserver(this.env.VISION_URL ?? "http://127.0.0.1:8081")
        : new SimObserver(this.world, { knownTypes: this.env.BRAIN_SIM_TYPES !== "0" });
    const actor: Actor =
      this.observerKind === "sim" ? new BothActors([new ControllerActor(this.controller), new SimActor(this.world)]) : new ControllerActor(this.controller);
    this.loop = new GameLoop({
      brain: this.brain,
      observer,
      actor,
      log: new JsonlFileLog(this.env.BRAIN_LOG ?? "logs/brain.jsonl"),
      onEvent: (e: LoopEvent) => this.broadcast({ type: "brain", event: e }),
      robotColor: robotColor ?? (this.env.BRAIN_ROBOT_COLOR === "w" ? "w" : "b"),
      minConfidence: Number(this.env.BRAIN_MIN_CONFIDENCE ?? 0.6),
      commentary: this.env.BRAIN_COMMENTARY === "1",
    });
    this.loop.start(fen);
    if (this.observerKind === "sim") this.world.reset(parseFen(this.loop.fen));
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.loop = null;
    await this.brain?.close?.().catch(() => {});
    this.brain = null;
  }

  /** Poll the loop: one step at a time, never two at once. */
  private kick(): void {
    if (this.timer || !this.loop) return;
    const poll = Number(this.env.BRAIN_POLL_MS ?? 500);
    this.timer = setTimeout(async () => {
      this.timer = null;
      const loop = this.loop;
      if (!loop || this.busy) return;
      if (loop.state === "halted" || loop.state === "game-over") return this.sendStatus();
      this.busy = true;
      try {
        await loop.step();
      } catch (err) {
        this.broadcast({ type: "brain", event: { type: "error", message: (err as Error).message } });
      } finally {
        this.busy = false;
      }
      if (this.loop === loop) this.kick();
    }, poll);
  }

  private sendStatus(): void {
    this.broadcast({ type: "brainStatus", status: this.status() });
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
