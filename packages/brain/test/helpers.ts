import type { PolicyModel, RawPolicy } from "../src/intuition";
import type { DecisionInput } from "../src/types";

/** A scripted policy: returns the given (uci, prob) list for every position. */
export class FixedPolicy implements PolicyModel {
  readonly name = "fixed";
  calls: DecisionInput[] = [];
  constructor(private readonly fn: (input: DecisionInput) => { uci: string; prob: number }[]) {}
  async policy(input: DecisionInput): Promise<RawPolicy> {
    this.calls.push(input);
    return { model: this.name, moves: this.fn(input) };
  }
}

export function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

export const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export const chatAnswer = (content: string) => json({ choices: [{ message: { role: "assistant", content } }] });
