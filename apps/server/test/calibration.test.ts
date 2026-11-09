import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultChain } from "@robot/robot-config";
import { SimulatedAdapter } from "@robot/hardware";
import { CALIBRATION_SCHEMA } from "@robot/protocol";
import { currentBoardPose, initialPosition, setBoardPose, squareCentre } from "@robot/chess";
import { observationFromPosition, type Observer } from "@robot/brain";
import { RobotController } from "../src/controller";
import { ChessSession } from "../src/chess";
import { CalibrationService } from "../src/calib/service";
import { CalibrationStore, defaultCalibrationFile } from "../src/calib/store";
import { sameOrigin } from "../src/calib/origin";

const original = currentBoardPose();
afterEach(() => setBoardPose(original));

function calibrationDoc(over: Record<string, unknown> = {}) {
  return {
    schema: CALIBRATION_SCHEMA,
    revision: 3,
    created: "2026-11-09T12:00:00+00:00",
    operator_note: "test",
    camera: { source: "0", width: 1280, height: 720, controls: {}, intrinsics: null },
    board: {
      square_mm: 40,
      homography: [
        [1.5, 0, 400],
        [0, 1.5, 100],
        [0, 0, 1],
      ],
      orientation: { confirmed: true, mirrored_camera: false },
    },
    reference: { image: "calibration.d/reference-r0003.png", frames: 10 },
    thresholds: { diff: 30, occupied_fraction: 0.2, white: 120 },
    robot: { origin_twin_mm: [590, 2, -150], rotation_deg: 1.5, square_mm: 40, method: "touch-off", residual_mm: 0.4 },
    validation: { passed: true, revision: 3 },
    ...over,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "calib-"));
});

function writeDoc(doc: unknown): string {
  const f = join(dir, "calibration.json");
  writeFileSync(f, JSON.stringify(doc));
  return f;
}

describe("calibration file (read-only in the server)", () => {
  it("reports a missing, corrupt, old-format and incomplete file", () => {
    const f = join(dir, "calibration.json");
    const st = new CalibrationStore(f);
    expect(st.load().valid).toBe(false);
    expect(st.state.reasons[0]).toMatch(/no calibration file/);
    writeFileSync(f, "{not json");
    expect(st.load().reasons[0]).toMatch(/not valid JSON/);
    writeFileSync(f, JSON.stringify({ H: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], square: 40 }));
    expect(st.load().reasons[0]).toMatch(/old or unknown calibration format/);
    const noRobot = calibrationDoc();
    delete (noRobot as Record<string, unknown>).robot;
    writeFileSync(f, JSON.stringify(noRobot));
    expect(st.load().reasons[0]).toMatch(/incomplete calibration file: robot/);
  });

  it("is valid only when the orientation is confirmed and the final check passed for this revision", () => {
    expect(new CalibrationStore(writeDoc(calibrationDoc())).load()).toMatchObject({ valid: true, reasons: [] });
    expect(new CalibrationStore(writeDoc(calibrationDoc({ validation: undefined }))).load().reasons).toEqual([
      "not validated (run the final check)",
    ]);
    expect(new CalibrationStore(writeDoc(calibrationDoc({ validation: { passed: true, revision: 2 } }))).load().valid).toBe(false);
    expect(new CalibrationStore(writeDoc(calibrationDoc({ validation: { passed: false, revision: 3 } }))).load().valid).toBe(false);
    const doc = calibrationDoc();
    doc.board.orientation.confirmed = false;
    expect(new CalibrationStore(writeDoc(doc)).load().reasons).toContain("board orientation not confirmed");
  });

  it("uses the same path variable as the vision service", () => {
    expect(defaultCalibrationFile({ VISION_CALIBRATION_FILE: "/var/lib/robot-twin/vision/calibration.json" })).toBe(
      "/var/lib/robot-twin/vision/calibration.json",
    );
    expect(defaultCalibrationFile({ CALIBRATION_FILE: "/x/c.json", VISION_CALIBRATION_FILE: "/y" })).toBe("/x/c.json");
  });
});

async function simController() {
  const controller = new RobotController(defaultChain, new SimulatedAdapter(7), { controlHz: 200, simTimeScale: 50 });
  await controller.start();
  controller.setEnabled(true);
  return controller;
}

const startCamera: Observer = {
  async observe() {
    return observationFromPosition(initialPosition(), { knownTypes: false });
  },
};

describe("the chess loop refuses without a valid calibration", () => {
  it("refuses, says why, and does not move the arm; runs once the calibration is valid", async () => {
    const controller = await simController();
    const f = join(dir, "calibration.json");
    const calib = new CalibrationService(controller, { store: new CalibrationStore(f), required: true });
    calib.reload();
    const chess = new ChessSession(controller, {
      observer: startCamera,
      observerKind: "vision",
      settleMs: 0,
      pollMs: 5,
      calibrationGate: () => calib.gate(),
      env: { BRAIN_INTUITION: "uniform", BRAIN_REFLECTION: "off", BRAIN_LOG: join(dir, "brain.jsonl") },
    });
    const q0 = controller.state;
    const r = await chess.start();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no valid calibration: no calibration file yet/);
    expect(chess.loopStatus.message).toMatch(/refused: no valid calibration/);
    expect(chess.running).toBe(false);
    expect(controller.state).toEqual(q0);
    expect(calib.statusMessage()).toMatchObject({ type: "calibStatus", required: true, valid: false });

    // Saved but not validated: still refused.
    writeFileSync(f, JSON.stringify(calibrationDoc({ validation: undefined })));
    calib.reload();
    expect((await chess.start()).error).toMatch(/not validated/);

    // Valid: the gate opens and the loop runs.
    writeFileSync(f, JSON.stringify(calibrationDoc()));
    calib.reload();
    expect(calib.gate().ok).toBe(true);
    expect(await chess.start()).toEqual({ ok: true });
    expect(chess.running).toBe(true);
    await chess.stop();
    await controller.stop();
  }, 60000);

  it("does not gate when not required (twin-only simulation)", async () => {
    const controller = await simController();
    const calib = new CalibrationService(controller, { store: new CalibrationStore(join(dir, "none.json")), required: false });
    calib.reload();
    expect(calib.gate()).toEqual({ ok: true, reason: "" });
    await controller.stop();
  });

  it("applies the saved board pose on reload (twin targets follow the calibration)", async () => {
    const controller = await simController();
    const calib = new CalibrationService(controller, { store: new CalibrationStore(writeDoc(calibrationDoc())) });
    calib.reload();
    expect(currentBoardPose()).toEqual({ origin: [590, 2, -150], rotationDeg: 1.5, square: 40 });
    expect(calib.statusMessage()).toMatchObject({ valid: true, revision: 3, boardPose: { rotationDeg: 1.5 } });
    await controller.stop();
  });
});

describe("robot-frame step in simulation", () => {
  it("goes above a1/h1/h8, records the TCP and fits the configured pose back", async () => {
    const controller = await simController();
    const calib = new CalibrationService(controller, { store: new CalibrationStore(join(dir, "none.json")) });
    const pose = { origin: [600, 0, -160] as [number, number, number], rotationDeg: 0, square: 40 };
    setBoardPose(pose);
    for (const sq of ["a1", "h1", "h8"] as const) {
      expect(await calib.handle({ type: "calibGoto", square: sq, heightMm: 30 })).toEqual({ ok: true });
      const tcp = calib.tcp();
      const want = squareCentre(pose, sq, 30);
      expect(Math.hypot(tcp[0] - want[0], tcp[1] - want[1], tcp[2] - want[2])).toBeLessThan(1.5);
      expect(await calib.handle({ type: "calibRecord", point: sq })).toEqual({ ok: true });
    }
    expect(await calib.handle({ type: "calibFit", hoverMm: 30 })).toEqual({ ok: true });
    const fit = calib.robotMessage();
    expect(fit.type).toBe("calibRobot");
    if (fit.type !== "calibRobot" || !fit.fit) throw new Error("no fit");
    expect(fit.fit.residualRms).toBeLessThan(1.5);
    expect(Math.abs(fit.fit.pose.rotationDeg)).toBeLessThan(0.3);
    expect(fit.fit.delta.originMm).toBeLessThan(2);
    expect(fit.fit.reachability).toMatchObject({ reachable: 65, total: 65 });
    expect(fit.fit.mirrored).toBe(false);
    await controller.stop();
  }, 60000);

  it("jogs in the robot base frame and refuses motion when disabled", async () => {
    const controller = await simController();
    const calib = new CalibrationService(controller, { store: new CalibrationStore(join(dir, "none.json")) });
    expect((await calib.handle({ type: "calibGoto", square: "e4", heightMm: 60 })).ok).toBe(true);
    const a = calib.tcp();
    // +5 mm along base X and +5 mm along base Z (up) = twin +X and +Y.
    expect((await calib.handle({ type: "calibNudge", deltaBaseMm: [5, 0, 5] })).ok).toBe(true);
    const b = calib.tcp();
    expect(b[0] - a[0]).toBeCloseTo(5, 0);
    expect(b[1] - a[1]).toBeCloseTo(5, 0);
    expect(Math.abs(b[2] - a[2])).toBeLessThan(1);
    controller.setEnabled(false);
    const r = await calib.handle({ type: "calibNudge", deltaBaseMm: [1, 0, 0] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled/);
    expect((await calib.handle({ type: "calibFit", hoverMm: 20 })).error).toMatch(/record a1, h1 and h8/);
    await controller.stop();
  }, 60000);

  it("needs the operator's confirmation before a real robot moves", async () => {
    const adapter = new SimulatedAdapter(7);
    Object.defineProperty(adapter, "isReal", { value: true });
    const controller = new RobotController(defaultChain, adapter);
    await controller.start();
    controller.setEnabled(true);
    const calib = new CalibrationService(controller, { store: new CalibrationStore(join(dir, "none.json")) });
    const r = await calib.handle({ type: "calibGoto", square: "a1", heightMm: 50 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/confirm/);
    await controller.stop();
  });

  it("runs the final check through the vision service and reloads the result", async () => {
    const controller = await simController();
    const f = writeDoc(calibrationDoc({ validation: undefined }));
    let sent: any = null;
    const fakeVision = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      // The vision service writes the validation into the file.
      const doc = JSON.parse(readFileSync(f, "utf8"));
      doc.validation = { passed: true, revision: doc.revision, start_position: { correct: 64, total: 64, pieces_correct: 32, pieces_total: 32, errors: [] } };
      writeFileSync(f, JSON.stringify(doc));
      return new Response(JSON.stringify({ ok: true, validation: doc.validation }));
    }) as unknown as typeof fetch;
    const calib = new CalibrationService(controller, {
      store: new CalibrationStore(f),
      visionUrl: "http://vision/",
      required: true,
      fetchImpl: fakeVision,
    });
    calib.reload();
    expect(calib.gate().ok).toBe(false);
    const r = await calib.handle({ type: "calibValidate" });
    expect(r).toEqual({ ok: true });
    expect(sent.url).toBe("http://vision/calib/validate");
    expect(sent.body.revision).toBe(3);
    expect(sent.body.reachability.total).toBe(65);
    expect(calib.gate().ok).toBe(true);
    expect(calib.robotMessage()).toMatchObject({ message: expect.stringMatching(/pieces 32\/32.*PASSED/) });
    await controller.stop();
  }, 60000);
});

describe("same-origin rule for the WebSocket", () => {
  it("allows the same host, loopback and non-browser clients; refuses others", () => {
    expect(sameOrigin({})).toBe(true);
    expect(sameOrigin({ origin: "http://192.168.1.5:5909", host: "192.168.1.5:5909" })).toBe(true);
    expect(sameOrigin({ origin: "https://robot:5909", host: "127.0.0.1:3001", "x-forwarded-host": "robot:5909" })).toBe(true);
    expect(sameOrigin({ origin: "http://localhost:5173", host: "localhost:3001" })).toBe(true);
    expect(sameOrigin({ origin: "https://evil.example", host: "192.168.1.5:5909" })).toBe(false);
    expect(sameOrigin({ origin: "not a url", host: "x" })).toBe(false);
  });
});
