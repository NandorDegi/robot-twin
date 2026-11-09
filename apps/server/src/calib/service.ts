/**
 * Server half of the Calibrate wizard:
 *
 *  - step 5, robot frame: move the hand above a1/h1/h8 (operator-pressed
 *    buttons only, through the normal controller: enabled robot, every goal
 *    validated, the bridge's dry-run and speed limits), jog in small steps,
 *    record the TCP from the measured joint state, fit the board pose;
 *  - step 6: reload the calibration file without a restart and run the final
 *    check (reachability here, the start position in the vision service);
 *  - the gate: the chess loop refuses to run without a valid calibration.
 */
import { forwardKinematics, mat4TransformPoint } from "@robot/kinematics";
import { PANDA_TCP_OFFSET_MM, createPandaSolver, seedToward, toolDownRotation, APPROACH_HEIGHT_MM } from "@robot/robot-config";
import {
  baseToTwin,
  reachabilityChecks,
  reachabilityMiss,
  currentBoardPose,
  fitBoardPose,
  setBoardPose,
  squareCentre,
  type BoardPose,
  type Reachability,
  type TouchPoint,
  type Vec3,
} from "@robot/chess";
import type { CalibClientMessage, CalibServerMessage, WireFit } from "@robot/protocol";
import type { RobotController } from "../controller";
import type { ChessSession } from "../chess";
import { CalibrationStore } from "./store";

export interface CalibrationServiceOptions {
  store?: CalibrationStore;
  /** Vision service base URL (the final check reads the start position there). */
  visionUrl?: string;
  /** The chess loop refuses to run without a valid calibration. */
  required?: boolean;
  fetchImpl?: typeof fetch;
}

type Result = { ok: boolean; error?: string };

export class CalibrationService {
  readonly store: CalibrationStore;
  readonly required: boolean;
  private readonly visionUrl: string;
  private readonly f: typeof fetch;
  private chess: ChessSession | null = null;
  private points: Partial<Record<TouchPoint, Vec3>> = {};
  private fit: WireFit | null = null;
  private message = "";
  private readonly listeners = new Set<() => void>();
  private solver: ReturnType<typeof createPandaSolver> | null = null;
  private down: Float64Array | null = null;

  constructor(
    private readonly controller: RobotController,
    opts: CalibrationServiceOptions = {},
  ) {
    this.store = opts.store ?? new CalibrationStore();
    this.required = opts.required ?? false;
    this.visionUrl = (opts.visionUrl ?? "").replace(/\/$/, "");
    this.f = opts.fetchImpl ?? fetch;
  }

  attach(chess: ChessSession): void {
    this.chess = chess;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Re-read the file; apply its board pose (twin targets, planner, reach check). */
  reload(): void {
    const st = this.store.load();
    const r = st.calibration?.robot;
    if (r) setBoardPose({ origin: [...r.origin_twin_mm], rotationDeg: r.rotation_deg, square: r.square_mm });
    this.emit();
  }

  /** The chess-loop rule. */
  gate(): { ok: boolean; reason: string } {
    if (!this.required) return { ok: true, reason: "" };
    const st = this.store.state;
    if (st.valid) return { ok: true, reason: "" };
    return { ok: false, reason: `no valid calibration: ${st.reasons.join("; ")}. Open Calibrate and finish the wizard.` };
  }

  statusMessage(): CalibServerMessage {
    const st = this.store.state;
    const r = st.calibration?.robot;
    return {
      type: "calibStatus",
      required: this.required,
      valid: st.valid,
      reasons: st.reasons,
      revision: st.calibration?.revision ?? null,
      file: st.file,
      boardPose: r ? { origin: [...r.origin_twin_mm], rotationDeg: r.rotation_deg, square: r.square_mm } : null,
      validation: st.calibration?.validation ?? null,
    };
  }

  robotMessage(): CalibServerMessage {
    return {
      type: "calibRobot",
      points: { ...this.points } as Record<string, Vec3>,
      tcp: this.tcp(),
      configured: currentBoardPose(),
      fit: this.fit,
      message: this.message,
      real: this.controller.isReal,
    };
  }

  /** TCP (twin frame, mm) from the measured joint state. */
  tcp(): Vec3 {
    const fk = forwardKinematics(this.controller.chain, this.controller.state);
    const p = mat4TransformPoint(fk.pose, [0, 0, PANDA_TCP_OFFSET_MM]);
    return [p[0], p[1], p[2]];
  }

  /**
   * The `calibrate --check` reach test (64 squares + tray, grab and approach
   * height, hand down). About 130 IK solves: it yields to the event loop after
   * each IK solve so the controller loop and the bridge heartbeat keep running.
   */
  async reachability(pose: BoardPose): Promise<Reachability> {
    if (!this.solver) {
      this.solver = createPandaSolver(this.controller.chain);
      this.down = toolDownRotation(this.controller.chain);
    }
    const solver = this.solver;
    const down = this.down!;
    const canReach = (p: Vec3) => solver.solve({ position: p, orientation: down }, { seed: seedToward(p) }).success;
    const checks = reachabilityChecks(pose, { approachMm: APPROACH_HEIGHT_MM });
    const unreachable: string[] = [];
    const tick = () => new Promise((r) => setImmediate(r));
    for (const c of checks) {
      // One IK solve, then yield (a failing solve can take ~0.2 s).
      const grab = canReach(c.points[0]);
      await tick();
      const miss = grab ? reachabilityMiss({ name: c.name, points: [c.points[1], c.points[1]] }, canReach) : c.name;
      await tick();
      if (miss) unreachable.push(grab ? `${c.name} (approach)` : miss);
    }
    return { reachable: checks.length - unreachable.length, total: checks.length, unreachable };
  }

  async handle(msg: CalibClientMessage): Promise<Result> {
    try {
      return await this.dispatch(msg);
    } catch (err) {
      return this.done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async dispatch(msg: CalibClientMessage): Promise<Result> {
    switch (msg.type) {
      case "calibGoto": {
        const motion = this.motionAllowed(msg.confirmReal);
        if (!motion.ok) return this.done(motion);
        const target = squareCentre(currentBoardPose(), msg.square, msg.heightMm);
        this.message = `moving above ${msg.square} (${msg.heightMm} mm, configured board pose)`;
        this.emit();
        const r = await this.controller.moveToPosition(target, "down");
        return this.done(r.ok ? { ok: true } : { ok: false, error: `move above ${msg.square}: ${r.error ?? "failed"}` }, r.ok ? `above ${msg.square}: lower with -Z to the hover height, centre it, then Record` : undefined);
      }
      case "calibNudge": {
        const motion = this.motionAllowed(msg.confirmReal);
        if (!motion.ok) return this.done(motion);
        const d = baseToTwin(msg.deltaBaseMm);
        const t = this.tcp();
        const r = await this.controller.moveToPosition([t[0] + d[0], t[1] + d[1], t[2] + d[2]], "down");
        return this.done(r.ok ? { ok: true } : { ok: false, error: `jog: ${r.error ?? "failed"}` }, r.ok ? "jogged" : undefined);
      }
      case "calibRecord": {
        if (this.controller.isMoving) return this.done({ ok: false, error: "wait until the arm stands still" });
        this.points[msg.point] = this.tcp();
        this.fit = null;
        const p = this.points[msg.point]!;
        return this.done({ ok: true }, `recorded ${msg.point} at (${p.map((v) => v.toFixed(1)).join(", ")}) mm (twin frame)`);
      }
      case "calibFit": {
        const pts = this.points;
        if (!pts.a1 || !pts.h1 || !pts.h8) return this.done({ ok: false, error: "record a1, h1 and h8 first" });
        const nominal = currentBoardPose().square;
        const fit = fitBoardPose({ a1: pts.a1, h1: pts.h1, h8: pts.h8 }, msg.hoverMm, msg.useFittedSquare ? undefined : nominal);
        this.message = "fit done; checking the reachability of 64 squares + tray...";
        this.emit();
        this.fit = {
          ...fit,
          method: "touch-off",
          reachability: await this.reachability(fit.pose),
          delta: this.delta(fit.pose),
          hoverMm: msg.hoverMm,
          points: { a1: pts.a1, h1: pts.h1, h8: pts.h8 },
        };
        return this.done({ ok: true }, `fit: residual ${fit.residualRms.toFixed(2)} mm, yaw ${fit.pose.rotationDeg.toFixed(2)} deg`);
      }
      case "calibManualPose": {
        const pose: BoardPose = { origin: [...msg.origin], rotationDeg: msg.rotationDeg, square: msg.square };
        this.fit = {
          pose,
          fittedSquare: msg.square,
          residualRms: 0,
          residualMax: 0,
          perPoint: {},
          heightSpread: 0,
          mirrored: false,
          warnings: [],
          method: "manual",
          reachability: await this.reachability(pose),
          delta: this.delta(pose),
        };
        return this.done({ ok: true }, "manual board pose set");
      }
      case "calibReset":
        this.points = {};
        this.fit = null;
        return this.done({ ok: true }, "touch-off points cleared");
      case "calibReload":
        this.reload();
        return this.done({ ok: true }, `calibration reloaded (${this.store.state.valid ? "valid" : this.store.state.reasons.join("; ")})`);
      case "calibValidate":
        return this.validate();
      case "calibObservePose": {
        const motion = this.motionAllowed(msg.confirmReal);
        if (!motion.ok) return this.done(motion);
        if (!this.chess) return this.done({ ok: false, error: "no chess session" });
        const r = await this.chess.moveToObservePose();
        return this.done(r.ok ? { ok: true } : { ok: false, error: `observe pose: ${r.error ?? "failed"}` }, r.ok ? "in the observe pose" : undefined);
      }
    }
  }

  /** Step 6: reachability of the saved pose + the start position seen by the camera. */
  async validate(): Promise<Result> {
    this.reload();
    const c = this.store.state.calibration;
    if (!c) return this.done({ ok: false, error: this.store.state.reasons.join("; ") });
    if (!this.visionUrl) return this.done({ ok: false, error: "vision not configured (VISION_URL)" });
    const pose: BoardPose = { origin: [...c.robot.origin_twin_mm], rotationDeg: c.robot.rotation_deg, square: c.robot.square_mm };
    const reach = await this.reachability(pose);
    let body: { ok?: boolean; error?: string; validation?: { passed?: boolean } };
    try {
      const res = await this.f(`${this.visionUrl}/calib/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: c.revision, reachability: reach }),
        signal: AbortSignal.timeout(15000),
      });
      body = (await res.json()) as typeof body;
    } catch (err) {
      return this.done({ ok: false, error: `vision unreachable: ${String(err)}` });
    }
    this.reload();
    if (!body.ok) return this.done({ ok: false, error: `final check: ${body.error ?? "failed"}` });
    const st = this.store.state;
    const sp = st.calibration?.validation?.start_position;
    const summary = `final check r${c.revision}: pieces ${sp?.pieces_correct ?? "?"}/${sp?.pieces_total ?? 32}, squares ${sp?.correct ?? "?"}/64, reachable ${reach.reachable}/${reach.total}`;
    return this.done(st.valid ? { ok: true } : { ok: false, error: `${summary}: FAILED (${st.reasons.join("; ")})` }, `${summary}: ${st.valid ? "PASSED" : "FAILED"}`);
  }

  private motionAllowed(confirmReal?: boolean): Result {
    if (this.chess?.isBusy) return { ok: false, error: "the chess loop is busy" };
    if (!this.controller.isEnabled) return { ok: false, error: "robot disabled: press Enable first (operator decision)" };
    if (this.controller.isReal && !confirmReal) {
      return { ok: false, error: "real robot: confirm the motion in the wizard (user stop in hand)" };
    }
    if (this.controller.isMoving) return { ok: false, error: "the arm is moving" };
    return { ok: true };
  }

  private delta(p: BoardPose): WireFit["delta"] {
    const c = currentBoardPose();
    return {
      originMm: Math.hypot(p.origin[0] - c.origin[0], p.origin[1] - c.origin[1], p.origin[2] - c.origin[2]),
      rotationDeg: p.rotationDeg - c.rotationDeg,
      squareMm: p.square - c.square,
    };
  }

  private done(r: Result, message?: string): Result {
    if (message) this.message = message;
    else if (!r.ok && r.error) this.message = r.error;
    this.emit();
    return r;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
