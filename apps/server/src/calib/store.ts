/**
 * Read-only view of the calibration file. The vision service writes it (the
 * Calibrate wizard); the robot server only reads it, so there is one source of
 * truth for the board geometry, the reference, the thresholds and the board
 * pose in the robot frame.
 *
 * Path: CALIBRATION_FILE, else VISION_CALIBRATION_FILE (the same variable the
 * vision service uses; one env file on the NUC), else the dev default.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CALIBRATION_SCHEMA, calibrationFileSchema, type CalibrationFile } from "@robot/protocol";

export interface CalibrationState {
  file: string;
  /** Usable by the chess loop: complete, orientation confirmed, final check passed. */
  valid: boolean;
  reasons: string[];
  calibration: CalibrationFile | null;
}

export function defaultCalibrationFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CALIBRATION_FILE || env.VISION_CALIBRATION_FILE || "../vision/calibration.json");
}

/** Why a parsed calibration cannot be used ([] = usable). Same rules as vision/calib.py completeness(). */
export function calibrationProblems(c: CalibrationFile): string[] {
  const reasons: string[] = [];
  if (!c.board.orientation.confirmed) reasons.push("board orientation not confirmed");
  if (!c.validation || !c.validation.passed || c.validation.revision !== c.revision) {
    reasons.push("not validated (run the final check)");
  }
  return reasons;
}

export class CalibrationStore {
  private last: CalibrationState;

  constructor(readonly file: string = defaultCalibrationFile()) {
    this.last = { file: this.file, valid: false, reasons: ["not loaded"], calibration: null };
  }

  get state(): CalibrationState {
    return this.last;
  }

  load(): CalibrationState {
    this.last = this.read();
    return this.last;
  }

  private read(): CalibrationState {
    const bad = (reason: string): CalibrationState => ({ file: this.file, valid: false, reasons: [reason], calibration: null });
    if (!existsSync(this.file)) return bad(`no calibration file (${this.file}): run the Calibrate wizard`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      return bad(`calibration file is not valid JSON: ${String(err)}`);
    }
    if (!raw || typeof raw !== "object" || (raw as { schema?: unknown }).schema !== CALIBRATION_SCHEMA) {
      return bad("old or unknown calibration format (homography only): run the Calibrate wizard");
    }
    const parsed = calibrationFileSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return bad(`incomplete calibration file: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}`);
    }
    const reasons = calibrationProblems(parsed.data);
    return { file: this.file, valid: reasons.length === 0, reasons, calibration: parsed.data };
  }
}
