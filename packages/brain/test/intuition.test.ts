import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { initialPosition, toFen } from "@robot/chess";
import { HttpPolicyModel, IntuitionBrain, Lc0PolicyModel, legalTopK, parseLc0VerboseStats } from "../src/intuition";
import { LearnedPolicyModel } from "../src/learned";
import { EngineNotFoundError } from "../src/uci";
import { brainFromEnv } from "../src/factory";
import { FixedPolicy, json, mockFetch } from "./helpers";

const START = toFen(initialPosition());
const input = { fen: START, history: [] };
const FAKE_LC0 = fileURLToPath(new URL("./fixtures/fake-lc0.mjs", import.meta.url));

describe("legalTopK", () => {
  it("drops illegal and garbage moves, renormalises and sorts", () => {
    const c = legalTopK(initialPosition(), { model: "t", moves: [
      { uci: "e2e5", prob: 0.5 }, // illegal
      { uci: "zz", prob: 0.2 }, // garbage
      { uci: "d2d4", prob: 0.1 },
      { uci: "e2e4", prob: 0.3 },
      { uci: "g1f3", prob: Number.NaN },
    ] }, 5);
    expect(c.map((x) => x.uci)).toEqual(["e2e4", "d2d4"]);
    expect(c[0]!.prob).toBeCloseTo(0.75);
    expect(c[0]!.san).toBe("e4");
  });

  it("throws when the network proposes nothing legal", () => {
    expect(() => legalTopK(initialPosition(), { model: "t", moves: [{ uci: "e2e5", prob: 1 }] }, 3)).toThrow(/no legal move/);
  });
});

describe("IntuitionBrain", () => {
  it("plays the top legal move and lists candidates in the rationale", async () => {
    const b = new IntuitionBrain(new FixedPolicy(() => [{ uci: "e1e2", prob: 0.9 }, { uci: "g1f3", prob: 0.06 }, { uci: "e2e4", prob: 0.04 }]), { topK: 3 });
    const d = await b.decide(input);
    expect(d.uci).toBe("g1f3"); // e1e2 is illegal (pawn on e2)
    expect(d.candidates).toHaveLength(2);
    expect(d.rationale).toMatch(/Nf3 at 60%.*e4 40%/);
  });

  it("temperature samples among the candidates", async () => {
    const b = new IntuitionBrain(new FixedPolicy(() => [{ uci: "e2e4", prob: 0.5 }, { uci: "d2d4", prob: 0.5 }]), { temperature: 1, random: () => 0.99 });
    expect((await b.decide(input)).uci).toBe("d2d4");
  });
});

describe("HttpPolicyModel (searchless sidecar)", () => {
  it("posts the FEN and history, reads moves[]", async () => {
    const m = mockFetch(() => json({ model: "searchless-9M", moves: [{ uci: "e2e4", prob: 0.7 }, { uci: "a2a5", prob: 0.3 }] }));
    const b = new IntuitionBrain(new HttpPolicyModel({ baseUrl: "http://x:8095/", fetchImpl: m.fetch }));
    const d = await b.decide({ fen: START, history: [] });
    expect(m.calls[0]!.url).toBe("http://x:8095/policy");
    expect(m.calls[0]!.body).toMatchObject({ fen: START, history: [] });
    expect(d.uci).toBe("e2e4");
    expect(d.candidates).toEqual([{ uci: "e2e4", san: "e4", prob: 1 }]);
  });

  it("gives a clear error when the service is down", async () => {
    const m = mockFetch(() => { throw new TypeError("fetch failed"); });
    await expect(new HttpPolicyModel({ baseUrl: "http://x:1", fetchImpl: m.fetch }).policy(input)).rejects.toThrow(/intuition service unreachable.*docs\/BRAIN.md/);
  });
});

describe("Maia via lc0", () => {
  it("parses VerboseMoveStats policy lines", () => {
    const p = parseLc0VerboseStats([
      "info string e2e4  (322 ) N:       0 (+ 0) (P: 12.34%) (WL:  -.-----)",
      "info string e7e8q (100 ) N:       0 (+ 0) (P:  1.50%) (Q: 0.1)",
      "info string node  ( 20 ) N:       1 (+ 0) (P: 100.00%)",
      "info depth 1 seldepth 1",
    ]);
    expect(p).toEqual([{ uci: "e2e4", prob: 0.1234 }, { uci: "e7e8q", prob: 0.015 }]);
  });

  it("runs a UCI subprocess (fake lc0) and filters its policy", async () => {
    const model = new Lc0PolicyModel({ path: FAKE_LC0, weights: "/w/maia-1500.pb.gz" });
    try {
      const b = new IntuitionBrain(model, { topK: 5 });
      const d = await b.decide(input);
      expect(model.name).toBe("maia:maia-1500");
      expect(d.uci).toBe("e2e4");
      expect(d.candidates!.map((c) => c.uci)).toEqual(["e2e4", "d2d4", "g1f3"]); // e2e5 filtered
      expect(d.candidates![0]!.prob).toBeCloseTo(0.5);
    } finally {
      await model.close();
    }
  });

  it("a missing lc0 binary is a clear error", async () => {
    const model = new Lc0PolicyModel({ path: "/nonexistent/lc0", weights: "w.pb.gz" });
    await expect(model.policy(input)).rejects.toBeInstanceOf(EngineNotFoundError);
    await expect(model.policy(input)).rejects.toThrow(/lc0 has no apt package/);
  });
});

describe("stubs and factory", () => {
  it("LearnedPolicyModel is a stub", async () => {
    await expect(new LearnedPolicyModel().policy(input)).rejects.toThrow(/stub/);
  });

  it("builds the configured brains", () => {
    expect(brainFromEnv({}).name).toBe("reflective:http+slm");
    expect(brainFromEnv({ BRAIN_REFLECTION: "off" }).name).toBe("intuition:http");
    expect(brainFromEnv({ BRAIN_REFLECTION: "off", BRAIN_INTUITION: "uniform" }).name).toBe("intuition:uniform-placeholder");
    expect(() => brainFromEnv({ BRAIN_REFLECTION: "remote" })).toThrow(/FLEET_LLM_URL/);
    expect(() => brainFromEnv({ BRAIN_INTUITION: "maia" })).toThrow(/INTUITION_MAIA_WEIGHTS/);
    expect(() => brainFromEnv({ BRAIN_INTUITION: "stockfish" })).toThrow(/unknown/);
  });
});
