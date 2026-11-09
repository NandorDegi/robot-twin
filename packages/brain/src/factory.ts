/**
 * Build the brain from environment variables. See docs/BRAIN.md for the list.
 * Nothing here reads a key: only the key file PATH is passed on.
 */
import { HttpPolicyModel, IntuitionBrain, Lc0PolicyModel, UniformPolicyModel, type PolicyModel } from "./intuition";
import { LearnedPolicyModel } from "./learned";
import { ChatClient, ReflectiveBrain } from "./reflection";
import type { Brain } from "./types";

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const flag = (v: string | undefined) => v === "1" || v === "true" || v === "on";

export function policyFromEnv(env: Env = process.env): PolicyModel {
  const kind = env.BRAIN_INTUITION ?? "searchless";
  switch (kind) {
    case "searchless":
      return new HttpPolicyModel({ baseUrl: env.INTUITION_URL ?? "http://127.0.0.1:8095", timeoutMs: num(env.INTUITION_TIMEOUT_MS, 30000) });
    case "maia": {
      const weights = env.INTUITION_MAIA_WEIGHTS;
      if (!weights) throw new Error("BRAIN_INTUITION=maia needs INTUITION_MAIA_WEIGHTS (path to maia-XXXX.pb.gz)");
      return new Lc0PolicyModel({ path: env.INTUITION_LC0_PATH, weights, backend: env.INTUITION_LC0_BACKEND, threads: num(env.INTUITION_LC0_THREADS, 1) });
    }
    case "learned":
      return new LearnedPolicyModel(env.INTUITION_LEARNED_MODEL);
    case "uniform":
      return new UniformPolicyModel();
    default:
      throw new Error(`unknown BRAIN_INTUITION=${kind} (searchless | maia | learned | uniform)`);
  }
}

export function brainFromEnv(env: Env = process.env): Brain {
  const intuition = new IntuitionBrain(policyFromEnv(env), {
    topK: num(env.INTUITION_TOPK, 5),
    temperature: num(env.INTUITION_TEMPERATURE, 0),
  });
  const mode = env.BRAIN_REFLECTION ?? "local";
  if (mode === "off") return intuition;
  const common = {
    timeoutMs: num(env.REFLECTION_TIMEOUT_MS, 20000),
    thinking: flag(env.REFLECTION_THINKING),
    maxTokens: env.REFLECTION_MAX_TOKENS ? num(env.REFLECTION_MAX_TOKENS, 160) : undefined,
  };
  if (mode === "local") {
    const chat = new ChatClient({ baseUrl: env.REFLECTION_URL ?? "http://127.0.0.1:8090/v1", model: env.REFLECTION_MODEL ?? "qwen3-1.7b", keyFile: env.REFLECTION_KEY_FILE, ...common });
    return new ReflectiveBrain(intuition, chat, "slm");
  }
  if (mode === "remote") {
    const baseUrl = env.FLEET_LLM_URL;
    const model = env.FLEET_LLM_MODEL;
    if (!baseUrl || !model) throw new Error("BRAIN_REFLECTION=remote needs FLEET_LLM_URL and FLEET_LLM_MODEL (and FLEET_LLM_KEY_FILE)");
    return new ReflectiveBrain(intuition, new ChatClient({ baseUrl, model, keyFile: env.FLEET_LLM_KEY_FILE, ...common }), "fleet");
  }
  throw new Error(`unknown BRAIN_REFLECTION=${mode} (local | remote | off)`);
}
