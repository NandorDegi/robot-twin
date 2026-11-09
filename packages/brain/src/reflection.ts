/**
 * Reflection: a small language model looks at the intuition network's
 * candidates, the board, and the robot's own recent self-check notes, and
 * chooses ONE candidate with a short reason.
 *
 * Constrained: the answer must be JSON whose `move` is one of the listed
 * candidates (llama.cpp enforces this with a JSON-schema grammar; we validate
 * again). Any invalid, late or failed answer -> the intuition's top move.
 *
 * Backends: a local llama.cpp `llama-server` on the NUC (default), or a remote
 * OpenAI-compatible endpoint (the fleet), off by default. Same client.
 */
import { readFileSync } from "node:fs";
import { describePosition } from "./describe";
import { IntuitionBrain } from "./intuition";
import type { Brain, Candidate, CommentaryInput, Decision, DecisionInput } from "./types";

export interface ChatOptions {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:8090/v1 (llama-server). */
  baseUrl: string;
  /** Model name sent in the request (llama-server ignores it; vLLM needs it). */
  model: string;
  /** File that holds the API key (one line). Optional for a local llama-server. Never logged. */
  keyFile?: string;
  /** Hard time limit per request. */
  timeoutMs?: number;
  /** Let the model think before answering (Qwen3 thinking mode). Default false. */
  thinking?: boolean;
  /**
   * Output token cap. With thinking on, this bounds the thinking too; also set
   * llama-server --reasoning-budget N for a server-side thinking budget.
   */
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

export class ChatClient {
  private key: string | null | undefined;
  constructor(readonly opts: ChatOptions) {}

  private apiKey(): string | null {
    if (this.key !== undefined) return this.key;
    if (!this.opts.keyFile) return (this.key = null);
    try {
      this.key = readFileSync(this.opts.keyFile, "utf8").trim() || null;
    } catch {
      // Name the path, never the content.
      throw new Error(`cannot read the API key file ${this.opts.keyFile}`);
    }
    return this.key;
  }

  /** Returns the assistant's text (thinking stripped). Throws on HTTP/timeout errors. */
  async complete(messages: { role: string; content: string }[], schema?: object): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = this.apiKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: this.opts.temperature ?? 0.2,
      max_tokens: this.opts.maxTokens ?? (this.opts.thinking ? 768 : 160),
      // Qwen3 chat template switch (llama-server --jinja, vLLM).
      chat_template_kwargs: { enable_thinking: Boolean(this.opts.thinking) },
      cache_prompt: true, // llama-server: reuse the KV cache of the fixed system prompt
    };
    if (schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", strict: true, schema } };
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20000),
    });
    if (!res.ok) throw new Error(`language model HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("language model: no message content");
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
}

export const REFLECTION_SYSTEM = [
  "You are the reflective mind of a chess-playing robot arm.",
  "Your fast intuition proposes candidate moves with probabilities.",
  "Choose exactly ONE of the candidates. Check briefly: does it leave a piece undefended,",
  "does it answer the opponent's threat, does it fit what you remember from the last moves.",
  'Reply only with JSON: {"move": "<one candidate in UCI, exactly as listed>", "rationale": "<at most 25 words>"}.',
].join(" ");

export function reflectionPrompt(input: DecisionInput, candidates: Candidate[]): string {
  const parts = [`Position (FEN): ${input.fen}`, describePosition(input.fen)];
  if (input.context?.lastHumanMove) parts.push(`The human just played ${input.context.lastHumanMove.san}.`);
  const recent = input.context?.recent ?? [];
  if (recent.length) parts.push(`Your recent self-check notes:\n- ${recent.slice(-5).join("\n- ")}`);
  parts.push(
    "Candidates from your intuition:\n" +
      candidates.map((c) => `- ${c.uci} (${c.san}), intuition ${(c.prob * 100).toFixed(0)}%`).join("\n"),
  );
  return parts.join("\n\n");
}

export function answerSchema(candidates: Candidate[]): object {
  return {
    type: "object",
    properties: {
      move: { type: "string", enum: candidates.map((c) => c.uci) },
      rationale: { type: "string", maxLength: 240 },
    },
    required: ["move", "rationale"],
    additionalProperties: false,
  };
}

/** Parse and validate an answer. Returns the candidate or a reason it is invalid. */
export function parseAnswer(
  text: string,
  candidates: Candidate[],
): { ok: true; pick: Candidate; rationale: string } | { ok: false; reason: string } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { ok: false, reason: "answer is not JSON" };
  let obj: { move?: unknown; rationale?: unknown };
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return { ok: false, reason: "answer is not valid JSON" };
  }
  const mv = typeof obj.move === "string" ? obj.move.trim() : "";
  const pick =
    candidates.find((c) => c.uci === mv.toLowerCase()) ??
    candidates.find((c) => c.san.replace(/[+#]/g, "") === mv.replace(/[+#]/g, ""));
  if (!pick) return { ok: false, reason: `"${mv.slice(0, 16)}" is not one of the candidates` };
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, 240) : "";
  return { ok: true, pick, rationale };
}

/**
 * Intuition + reflection. The intuition always runs first; the language model
 * can only choose among its legal candidates, so it can never play an illegal
 * move and never blocks the game: on any failure the top candidate is played.
 */
export class ReflectiveBrain implements Brain {
  readonly name: string;
  constructor(
    readonly intuition: IntuitionBrain,
    readonly chat: ChatClient,
    readonly label = "slm",
  ) {
    this.name = `reflective:${intuition.model.name}+${label}`;
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const t0 = Date.now();
    const { candidates } = await this.intuition.candidates(input);
    const top = candidates[0]!;
    const fallback = (reason: string): Decision => ({
      uci: top.uci,
      san: top.san,
      brain: this.intuition.name,
      candidates,
      fallbackReason: reason,
      rationale: `Reflection failed (${reason}); playing the intuition's top move ${top.san} (${(top.prob * 100).toFixed(0)}%).`,
      elapsedMs: Date.now() - t0,
    });
    if (candidates.length === 1) {
      return { ...fallback("only one candidate"), rationale: `Only one sensible candidate: ${top.san}.` };
    }
    let text: string;
    try {
      text = await this.chat.complete(
        [
          { role: "system", content: REFLECTION_SYSTEM },
          { role: "user", content: reflectionPrompt(input, candidates) },
        ],
        answerSchema(candidates),
      );
    } catch (err) {
      return fallback((err as Error).name === "TimeoutError" ? "time limit" : (err as Error).message);
    }
    const a = parseAnswer(text, candidates);
    if (!a.ok) return fallback(a.reason);
    return {
      uci: a.pick.uci,
      san: a.pick.san,
      brain: this.name,
      candidates,
      rationale: a.rationale || `Chose ${a.pick.san} from the intuition's candidates.`,
      elapsedMs: Date.now() - t0,
    };
  }

  /** Explain a move in one or two sentences. Null on any failure (commentary is optional). */
  async commentary(input: CommentaryInput): Promise<string | null> {
    try {
      const text = await this.chat.complete([
        {
          role: "system",
          content: "You comment on chess moves for spectators. One or two short sentences. Plain text, no markdown.",
        },
        {
          role: "user",
          content: `${describePosition(input.fenBefore)}\n${input.by === "robot" ? "The robot" : "The human"} played ${input.san}. Reason given: ${input.rationale || "none"}. Comment on the move.`,
        },
      ]);
      return text.slice(0, 400) || null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.intuition.close();
  }
}
