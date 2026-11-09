/**
 * Robot-frame step of the wizard. Two drivers with the same interface:
 *
 *  - ServerDriver: the robot server (simulated adapter, Franka dry-run or the
 *    real arm). Every motion goes through the server's controller and the
 *    bridge; nothing moves unless the operator presses a button.
 *  - LocalDriver: the twin's own simulated arm when no server is reachable,
 *    so the whole wizard can be tried in the browser alone.
 */
import {
  baseToTwin,
  boardReachability,
  currentBoardPose,
  fitBoardPose,
  squareCentre,
  type BoardPose,
  type TouchPoint,
  type Vec3,
} from "@robot/chess";
import { forwardKinematics, mat4TransformPoint, type KinematicChain } from "@robot/kinematics";
import { APPROACH_HEIGHT_MM, PANDA_TCP_OFFSET_MM, createPandaSolver, seedToward, toolDownRotation } from "@robot/robot-config";
import type { CalibClientMessage, WireFit } from "@robot/protocol";
import type { LocalSim } from "../localsim";

export interface RobotStepState {
  points: Partial<Record<TouchPoint, Vec3>>;
  fit: WireFit | null;
  message: string;
  real: boolean;
  configured: BoardPose;
}

export interface RobotDriver {
  readonly kind: "server" | "local";
  state(): RobotStepState;
  send(msg: CalibClientMessage): Promise<void>;
}

export function tcpOf(chain: KinematicChain, q: number[]): Vec3 {
  const p = mat4TransformPoint(forwardKinematics(chain, q).pose, [0, 0, PANDA_TCP_OFFSET_MM]);
  return [p[0], p[1], p[2]];
}

export class ServerDriver implements RobotDriver {
  readonly kind = "server" as const;
  private st: RobotStepState = { points: {}, fit: null, message: "", real: false, configured: currentBoardPose() };

  constructor(private readonly sendWs: (m: CalibClientMessage) => void) {}

  /** Called for every server message. */
  onMessage(msg: any): boolean {
    if (msg?.type !== "calibRobot") return false;
    this.st = {
      points: (msg.points ?? {}) as RobotStepState["points"],
      fit: (msg.fit ?? null) as WireFit | null,
      message: String(msg.message ?? ""),
      real: Boolean(msg.real),
      configured: (msg.configured ?? this.st.configured) as BoardPose,
    };
    return true;
  }

  state(): RobotStepState {
    return this.st;
  }

  async send(msg: CalibClientMessage): Promise<void> {
    this.sendWs(msg);
  }
}

export class LocalDriver implements RobotDriver {
  readonly kind = "local" as const;
  private readonly solver;
  private readonly down: Float64Array;
  private st: RobotStepState = { points: {}, fit: null, message: "local simulation (no server)", real: false, configured: currentBoardPose() };

  constructor(
    private readonly chain: KinematicChain,
    private readonly sim: LocalSim,
    private readonly onChange: () => void,
  ) {
    this.solver = createPandaSolver(chain);
    this.down = toolDownRotation(chain);
  }

  state(): RobotStepState {
    return { ...this.st, configured: currentBoardPose() };
  }

  private say(message: string): void {
    this.st = { ...this.st, message };
    this.onChange();
  }

  private async moveTo(p: Vec3): Promise<boolean> {
    const res = this.solver.solve({ position: p, orientation: this.down }, { seed: this.sim.q });
    const r = res.success ? res : this.solver.solve({ position: p, orientation: this.down }, { seed: seedToward(p) });
    if (!r.success || !this.sim.setJoint(r.q)) {
      this.say(`not reachable (local IK): (${p.map((v) => v.toFixed(0)).join(", ")})`);
      return false;
    }
    // The twin's animation loop moves the arm; wait until it settles.
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      const tcp = tcpOf(this.chain, this.sim.q);
      if (Math.hypot(tcp[0] - p[0], tcp[1] - p[1], tcp[2] - p[2]) < 0.3) break;
      await new Promise((res2) => setTimeout(res2, 50));
    }
    return true;
  }

  async reachability(pose: BoardPose) {
    // Same check as the server, in the browser.
    return boardReachability(pose, (p) => this.solver.solve({ position: p, orientation: this.down }, { seed: seedToward(p) }).success, {
      approachMm: APPROACH_HEIGHT_MM,
    });
  }

  async send(msg: CalibClientMessage): Promise<void> {
    switch (msg.type) {
      case "calibGoto":
        if (await this.moveTo(squareCentre(currentBoardPose(), msg.square, msg.heightMm))) this.say(`above ${msg.square} (local sim)`);
        break;
      case "calibNudge": {
        const d = baseToTwin(msg.deltaBaseMm);
        const t = tcpOf(this.chain, this.sim.q);
        if (await this.moveTo([t[0] + d[0], t[1] + d[1], t[2] + d[2]])) this.say("jogged (local sim)");
        break;
      }
      case "calibRecord": {
        const p = tcpOf(this.chain, this.sim.q);
        this.st = { ...this.st, points: { ...this.st.points, [msg.point]: p }, fit: null };
        this.say(`recorded ${msg.point} (local sim)`);
        break;
      }
      case "calibFit": {
        const { a1, h1, h8 } = this.st.points;
        if (!a1 || !h1 || !h8) return this.say("record a1, h1 and h8 first");
        const c = currentBoardPose();
        const fit = fitBoardPose({ a1, h1, h8 }, msg.hoverMm, msg.useFittedSquare ? undefined : c.square);
        this.say("checking the reachability...");
        await new Promise((r) => setTimeout(r, 0));
        const reachability = await this.reachability(fit.pose);
        this.st = {
          ...this.st,
          fit: { ...fit, method: "touch-off", reachability, delta: delta(fit.pose, c), hoverMm: msg.hoverMm, points: { a1, h1, h8 } },
        };
        this.say(`fit: residual ${fit.residualRms.toFixed(2)} mm (local sim)`);
        break;
      }
      case "calibManualPose": {
        const pose: BoardPose = { origin: [...msg.origin], rotationDeg: msg.rotationDeg, square: msg.square };
        const reachability = await this.reachability(pose);
        this.st = {
          ...this.st,
          fit: { pose, fittedSquare: msg.square, residualRms: 0, residualMax: 0, perPoint: {}, heightSpread: 0, mirrored: false, warnings: [], method: "manual", reachability, delta: delta(pose, currentBoardPose()) },
        };
        this.say("manual board pose set (local sim)");
        break;
      }
      case "calibReset":
        this.st = { ...this.st, points: {}, fit: null };
        this.say("touch-off points cleared");
        break;
      case "calibObservePose": {
        const q = this.sim.q.slice();
        q[0] = Math.PI / 2;
        this.sim.setJoint(q);
        this.say("observe pose (local sim)");
        break;
      }
      case "calibReload":
      case "calibValidate":
        this.say("needs the robot server");
        break;
    }
  }
}

function delta(p: BoardPose, c: BoardPose): WireFit["delta"] {
  return {
    originMm: Math.hypot(p.origin[0] - c.origin[0], p.origin[1] - c.origin[1], p.origin[2] - c.origin[2]),
    rotationDeg: p.rotationDeg - c.rotationDeg,
    squareMm: p.square - c.square,
  };
}
