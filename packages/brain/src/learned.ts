/**
 * LearnedPolicyModel: placeholder for a policy trained on the robot's OWN
 * games (the JSONL cycle log). Interface only.
 *
 * TODO (see docs/BRAIN.md "Learning path"):
 *  - export (position, chosen move, outcome, self-check verdict) from the logs;
 *  - fine-tune a small policy (e.g. the searchless 9M behavioural-cloning
 *    transformer) or LoRA-tune the reflection SLM (rde-weightlab);
 *  - export to ONNX/OpenVINO and implement `policy()` here.
 */
import type { PolicyModel, RawPolicy } from "./intuition";
import type { DecisionInput } from "./types";

export class NotImplementedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotImplementedError";
  }
}

export class LearnedPolicyModel implements PolicyModel {
  readonly name = "learned";
  constructor(readonly modelPath?: string) {}

  async policy(_input: DecisionInput): Promise<RawPolicy> {
    throw new NotImplementedError(
      "LearnedPolicyModel is a stub: no model trained on the robot's own games yet. See docs/BRAIN.md 'Learning path'.",
    );
  }
}
