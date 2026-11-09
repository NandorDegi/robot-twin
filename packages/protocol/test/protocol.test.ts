import { describe, expect, it } from "vitest";
import { clientMessageSchema } from "../src/index";

describe("protocol", () => {
  it("validates a setTarget message", () => {
    const msg = { type: "setTarget", target: { position: [0.1, 0.2, 0.3] } };
    expect(clientMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects an unknown message type", () => {
    const msg = { type: "explode" };
    expect(clientMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("rejects a setTarget with a bad position", () => {
    const msg = { type: "setTarget", target: { position: [0.1] } };
    expect(clientMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe("calibration messages", () => {
  it("accepts a bounded nudge and rejects a large one", () => {
    expect(clientMessageSchema.safeParse({ type: "calibNudge", deltaBaseMm: [1, -5, 10] }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "calibNudge", deltaBaseMm: [11, 0, 0] }).success).toBe(false);
  });

  it("checks goto squares and heights", () => {
    expect(clientMessageSchema.safeParse({ type: "calibGoto", square: "h8", heightMm: 50 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "calibGoto", square: "i9", heightMm: 50 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "calibGoto", square: "a1", heightMm: 1 }).success).toBe(false);
  });

  it("accepts only the three touch-off points", () => {
    expect(clientMessageSchema.safeParse({ type: "calibRecord", point: "h1" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "calibRecord", point: "a8" }).success).toBe(false);
  });

  it("bounds a manual pose", () => {
    const ok = { type: "calibManualPose", origin: [600, 0, -160], rotationDeg: 3, square: 40 };
    expect(clientMessageSchema.safeParse(ok).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...ok, origin: [6000, 0, 0] }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...ok, square: 0 }).success).toBe(false);
  });
});
