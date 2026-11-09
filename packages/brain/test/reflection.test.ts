import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialPosition, toFen } from "@robot/chess";
import { IntuitionBrain } from "../src/intuition";
import { ChatClient, ReflectiveBrain, parseAnswer, reflectionPrompt } from "../src/reflection";
import { describePosition } from "../src/describe";
import { FixedPolicy, chatAnswer, json, mockFetch } from "./helpers";

const START = toFen(initialPosition());
const policy = () => new IntuitionBrain(new FixedPolicy(() => [{ uci: "e2e4", prob: 0.5 }, { uci: "d2d4", prob: 0.3 }, { uci: "g1f3", prob: 0.2 }]), { topK: 3 });
const brainWith = (handler: Parameters<typeof mockFetch>[0], extra: Partial<ConstructorParameters<typeof ChatClient>[0]> = {}) => {
  const m = mockFetch(handler);
  const b = new ReflectiveBrain(policy(), new ChatClient({ baseUrl: "http://slm:8090/v1", model: "qwen3-1.7b", fetchImpl: m.fetch, ...extra }));
  return { b, m };
};
const input = {
  fen: START,
  history: [],
  context: { recent: ["cycle 3: my move Nf3: mismatch on f3 (missing), resolved by the human"], lastHumanMove: { uci: "e7e5", san: "e5" } },
};

describe("ReflectiveBrain", () => {
  it("chooses one of the candidates and sends a constrained request", async () => {
    const { b, m } = brainWith(() => chatAnswer('{"move":"d2d4","rationale":"Controls the centre."}'));
    const d = await b.decide(input);
    expect(d).toMatchObject({ uci: "d2d4", san: "d4", rationale: "Controls the centre.", brain: "reflective:fixed+slm" });
    const body = m.calls[0]!.body;
    expect(m.calls[0]!.url).toBe("http://slm:8090/v1/chat/completions");
    expect(body.response_format.json_schema.schema.properties.move.enum).toEqual(["e2e4", "d2d4", "g1f3"]);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const user = body.messages[1].content as string;
    expect(user).toMatch(/White to move/);
    expect(user).toMatch(/mismatch on f3/);
    expect(user).toMatch(/human just played e5/);
    expect(user).toMatch(/d2d4 \(d4\), intuition 30%/);
  });

  it("accepts SAN and strips a think block", async () => {
    const { b } = brainWith(() => chatAnswer('<think>hmm</think>{"move":"Nf3","rationale":"Develops."}'));
    expect((await b.decide(input)).uci).toBe("g1f3");
  });

  it.each([
    ["an illegal move", () => chatAnswer('{"move":"e2e5","rationale":"x"}'), /not one of the candidates/],
    ["a legal move that is not a candidate", () => chatAnswer('{"move":"a2a3","rationale":"x"}'), /not one of the candidates/],
    ["prose instead of JSON", () => chatAnswer("I would play e4."), /not JSON/],
    ["an HTTP error", () => json({ error: "boom" }, 500), /HTTP 500/],
    ["a network error", () => { throw new TypeError("fetch failed"); }, /fetch failed/],
  ])("falls back to the intuition's top move on %s", async (_name, handler, reason) => {
    const { b } = brainWith(handler as never);
    const d = await b.decide(input);
    expect(d.uci).toBe("e2e4");
    expect(d.brain).toBe("intuition:fixed");
    expect(d.fallbackReason).toMatch(reason);
  });

  it("falls back on the time limit", async () => {
    const { b } = brainWith(
      (_u, init) =>
        new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))),
      { timeoutMs: 30 },
    );
    const d = await b.decide(input);
    expect(d.uci).toBe("e2e4");
    expect(d.fallbackReason).toBe("time limit");
  });

  it("reads the key from a file, sends it as Bearer, and never puts it in the output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-key-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "test-key-123\n");
    const { b, m } = brainWith(() => chatAnswer('{"move":"e2e4","rationale":"ok"}'), { keyFile });
    const d = await b.decide(input);
    expect((m.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key-123");
    expect(JSON.stringify(d)).not.toContain("test-key-123");
  });

  it("a missing key file names the path only and falls back", async () => {
    const { b } = brainWith(() => chatAnswer("{}"), { keyFile: "/nonexistent/key" });
    const d = await b.decide(input);
    expect(d.fallbackReason).toBe("cannot read the API key file /nonexistent/key");
  });

  it("thinking mode is passed through", async () => {
    const { b, m } = brainWith(() => chatAnswer('{"move":"e2e4","rationale":"ok"}'), { thinking: true });
    await b.decide(input);
    expect(m.calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(m.calls[0]!.body.max_tokens).toBe(768);
  });

  it("commentary returns text, or null on failure", async () => {
    const ok = brainWith(() => chatAnswer("A solid central move."));
    expect(await ok.b.commentary({ fenBefore: START, san: "e4", uci: "e2e4", rationale: "", by: "robot" })).toBe("A solid central move.");
    const bad = brainWith(() => json({}, 500));
    expect(await bad.b.commentary({ fenBefore: START, san: "e4", uci: "e2e4", rationale: "", by: "robot" })).toBeNull();
  });
});

describe("prompt pieces", () => {
  it("describes the position in words", () => {
    const d = describePosition(START);
    expect(d).toMatch(/White: King e1; Queen d1; Rooks a1 h1; Bishops c1 f1; Knights b1 g1; Pawns a2 b2/);
    expect(d).toMatch(/White to move\./);
    expect(describePosition("4k3/8/8/8/8/8/8/4K2r w - - 0 1")).toMatch(/White is in check/);
  });

  it("parseAnswer rejects non-candidates", () => {
    const cands = [{ uci: "e2e4", san: "e4", prob: 1 }];
    expect(parseAnswer('{"move":"e2e4"}', cands).ok).toBe(true);
    expect(parseAnswer('{"move":"E2E4"}', cands).ok).toBe(true);
    expect(parseAnswer('{"move":"d2d4"}', cands).ok).toBe(false);
  });

  it("the prompt lists the candidates", () => {
    expect(reflectionPrompt({ fen: START, history: [] }, [{ uci: "e2e4", san: "e4", prob: 1 }])).toMatch(/- e2e4 \(e4\), intuition 100%/);
  });
});
