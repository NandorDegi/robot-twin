import type { RecordedStep } from "@robot/protocol";
import type { RobotController } from "./controller";

/**
 * Records a sequence of user intent steps (targets and gripper actions) so a
 * demonstration can be replayed. Steps are stored as JSON.
 */
export class TrajectoryRecorder {
  private steps: RecordedStep[] = [];
  private recording = false;

  start(): void {
    this.steps = [];
    this.recording = true;
  }

  stop(): RecordedStep[] {
    this.recording = false;
    return this.steps;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  target(position: [number, number, number], wait?: number): void {
    if (!this.recording) return;
    this.steps.push({ type: "target", position, wait });
  }

  gripper(open: boolean): void {
    if (!this.recording) return;
    this.steps.push({ type: "gripper", open });
  }

  wait(ms: number): void {
    if (!this.recording) return;
    this.steps.push({ type: "wait", ms });
  }

  toJson(): string {
    return JSON.stringify(this.steps, null, 2);
  }

  static fromJson(json: string): RecordedStep[] {
    return JSON.parse(json) as RecordedStep[];
  }
}

/**
 * Replays a list of recorded steps through the controller, one at a time:
 * each motion must finish (and succeed) before the next starts. The replay
 * stops at the first failure. Motion is gated by the controller's enable state.
 */
export async function replay(
  controller: RobotController,
  steps: RecordedStep[],
): Promise<{ ok: boolean; error?: string }> {
  for (const step of steps) {
    switch (step.type) {
      case "target": {
        const r = await controller.moveToPosition(step.position, controller.isReal ? "down" : undefined);
        if (!r.ok) return { ok: false, error: `replay stopped: ${r.error ?? "motion failed"}` };
        break;
      }
      case "gripper": {
        const r = await controller.setGripper(step.open);
        if (!r.ok) return { ok: false, error: `replay stopped: ${r.error ?? "gripper failed"}` };
        break;
      }
      case "wait":
        await sleep(Math.min(step.ms, 60000));
        break;
    }
    if (step.type === "target" && step.wait) await sleep(step.wait);
  }
  return { ok: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
