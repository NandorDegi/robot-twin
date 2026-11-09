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
 * Replays a list of recorded steps through the controller. Motion is gated by
 * the controller's enable state, so the queue waits until it is enabled.
 */
export async function replay(
  controller: RobotController,
  steps: RecordedStep[],
): Promise<void> {
  for (const step of steps) {
    switch (step.type) {
      case "target":
        await controller.setTarget(step.position);
        break;
      case "gripper":
        await controller.setGripper(step.open);
        break;
      case "wait":
        await sleep(step.ms);
        break;
    }
    if (step.type === "target" && step.wait) await sleep(step.wait);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
