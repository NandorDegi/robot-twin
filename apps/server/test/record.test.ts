import { describe, expect, it } from "vitest";
import { TrajectoryRecorder } from "../src/record";

describe("TrajectoryRecorder", () => {
  it("records target and gripper steps only while recording", () => {
    const r = new TrajectoryRecorder();
    r.target([0.1, 0.2, 0.3]);
    r.start();
    r.target([0.4, 0.5, 0.6], 100);
    r.gripper(true);
    const steps = r.stop();
    expect(steps).toEqual([
      { type: "target", position: [0.4, 0.5, 0.6], wait: 100 },
      { type: "gripper", open: true },
    ]);
  });

  it("round-trips through JSON", () => {
    const r = new TrajectoryRecorder();
    r.start();
    r.target([1, 2, 3]);
    r.gripper(false);
    const json = r.toJson();
    const back = TrajectoryRecorder.fromJson(json);
    expect(back).toEqual(r.stop());
  });
});
