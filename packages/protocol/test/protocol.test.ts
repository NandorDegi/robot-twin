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
