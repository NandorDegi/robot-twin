/**
 * Intuition: a small learned move-policy network, no search tree.
 *
 * A PolicyModel returns raw (move, score) pairs. `legalTopK` keeps only the
 * moves that @robot/chess says are legal, renormalises and cuts to top-k. The
 * network is never trusted on legality.
 *
 * Backends:
 *  - HttpPolicyModel: the Python sidecar apps/intuition (DeepMind
 *    searchless_chess 9M/136M/270M, JAX on CPU).
 *  - Lc0PolicyModel: Maia weights through lc0 (`go nodes 1` = one network
 *    evaluation, the policy head read from VerboseMoveStats).
 */
import { legalMoves, moveToSan, parseFen, squareName, type Move, type Position } from "@robot/chess";
import type { Brain, Candidate, Decision, DecisionInput } from "./types";
import { UciProcess } from "./uci";

export interface RawPolicy {
  /** Move scores from the network. `prob` need not be normalised or legal-only. */
  moves: { uci: string; prob: number }[];
  model: string;
}

export interface PolicyModel {
  readonly name: string;
  policy(input: DecisionInput): Promise<RawPolicy>;
  close?(): Promise<void>;
}

export function moveUci(m: Move): string {
  return `${squareName(m.from)}${squareName(m.to)}${m.promotion ?? ""}`;
}

/** Filter to legal moves, renormalise, sort, cut to k. Throws if nothing legal remains. */
export function legalTopK(pos: Position, raw: RawPolicy, k: number): Candidate[] {
  const legal = new Map(legalMoves(pos, pos.turn).map((m) => [moveUci(m), m]));
  const seen = new Map<string, number>();
  for (const { uci, prob } of raw.moves) {
    const key = uci.trim().toLowerCase();
    if (!legal.has(key) || !Number.isFinite(prob) || prob < 0) continue;
    seen.set(key, Math.max(seen.get(key) ?? 0, prob));
  }
  const total = [...seen.values()].reduce((a, b) => a + b, 0);
  if (seen.size === 0 || total <= 0) {
    throw new Error(`policy model ${raw.model} returned no legal move with positive probability`);
  }
  return [...seen.entries()]
    .map(([uci, p]) => ({ uci, san: moveToSan(pos, legal.get(uci)!), prob: p / total }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, Math.max(1, k));
}

export interface IntuitionOptions {
  topK?: number;
  /**
   * 0 (default) = always play the most probable move. > 0 = sample from the
   * top-k with probabilities p^(1/T) (more human, less repetitive).
   */
  temperature?: number;
  random?: () => number;
}

/** A brain that plays from intuition alone: the network's top move. */
export class IntuitionBrain implements Brain {
  readonly name: string;
  constructor(
    readonly model: PolicyModel,
    private readonly opts: IntuitionOptions = {},
  ) {
    this.name = `intuition:${model.name}`;
  }

  async candidates(input: DecisionInput): Promise<{ candidates: Candidate[]; elapsedMs: number; model: string }> {
    const t0 = Date.now();
    const pos = parseFen(input.fen);
    const raw = await this.model.policy(input);
    return { candidates: legalTopK(pos, raw, this.opts.topK ?? 5), elapsedMs: Date.now() - t0, model: raw.model };
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const { candidates, elapsedMs, model } = await this.candidates(input);
    const pick = this.pick(candidates);
    return {
      uci: pick.uci,
      san: pick.san,
      brain: this.name,
      candidates,
      rationale:
        `Intuition (${model}, no search): ${pick.san} at ${(pick.prob * 100).toFixed(0)}%. ` +
        `Other candidates: ${candidates.filter((c) => c !== pick).map((c) => `${c.san} ${(c.prob * 100).toFixed(0)}%`).join(", ") || "none"}.`,
      elapsedMs,
    };
  }

  private pick(c: Candidate[]): Candidate {
    const t = this.opts.temperature ?? 0;
    if (t <= 0 || c.length === 1) return c[0]!;
    const w = c.map((x) => Math.pow(x.prob, 1 / t));
    let r = (this.opts.random ?? Math.random)() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < c.length; i++) {
      r -= w[i]!;
      if (r <= 0) return c[i]!;
    }
    return c[c.length - 1]!;
  }

  async close(): Promise<void> {
    await this.model.close?.();
  }
}

// --- backends -----------------------------------------------------------------

export interface HttpPolicyOptions {
  /** Base URL of apps/intuition, e.g. http://127.0.0.1:8095 */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Client for the Python intuition sidecar (apps/intuition/server.py):
 * POST /policy {fen, history, startFen} -> {model, moves: [{uci, prob}]}.
 */
export class HttpPolicyModel implements PolicyModel {
  readonly name: string;
  constructor(private readonly opts: HttpPolicyOptions) {
    this.name = "http";
  }

  async policy(input: DecisionInput): Promise<RawPolicy> {
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen: input.fen, history: input.history, startFen: input.startFen }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30000),
      });
    } catch (err) {
      throw new Error(
        `intuition service unreachable at ${this.opts.baseUrl} (${(err as Error).message}). ` +
          "Start it on the NUC: see docs/BRAIN.md 'Intuition service'.",
      );
    }
    if (!res.ok) throw new Error(`intuition service HTTP ${res.status}`);
    const data = (await res.json()) as { model?: string; moves?: { uci: string; prob: number }[] };
    if (!Array.isArray(data.moves)) throw new Error("intuition service: response has no moves[]");
    return { model: String(data.model ?? "searchless"), moves: data.moves };
  }
}

export interface Lc0Options {
  /** lc0 binary (default "lc0" on PATH). */
  path?: string;
  /** Maia weights file, e.g. /opt/maia/maia-1500.pb.gz */
  weights: string;
  /** lc0 backend; CPU choices: "blas" (OpenBLAS), "eigen", "onednn". Default: lc0's own choice. */
  backend?: string;
  threads?: number;
  timeoutMs?: number;
}

/** Parse lc0 VerboseMoveStats lines: `info string e2e4  (322 ) N: 0 (+ 0) (P: 12.34%) ...` */
export function parseLc0VerboseStats(lines: string[]): { uci: string; prob: number }[] {
  const out: { uci: string; prob: number }[] = [];
  const re = /^info string ([a-h][1-8][a-h][1-8][qrbn]?)\s.*\(P:\s*([\d.]+)%\)/;
  for (const l of lines) {
    const m = re.exec(l);
    if (m) out.push({ uci: m[1]!, prob: Number(m[2]) / 100 });
  }
  return out;
}

/**
 * Maia via lc0. Maia is a policy network trained to predict human moves at a
 * rating band. With `nodes 1` lc0 runs the network once; we read the policy
 * head, not lc0's chosen move.
 */
export class Lc0PolicyModel implements PolicyModel {
  readonly name: string;
  private readonly uci: UciProcess;

  constructor(private readonly opts: Lc0Options) {
    const base = opts.weights.split("/").pop() ?? "maia";
    this.name = `maia:${base.replace(/\.pb(\.gz)?$/, "")}`;
    this.uci = new UciProcess({
      path: opts.path ?? "lc0",
      // No --backend: lc0 picks the best one it was built with (blas/eigen/onednn on a CPU-only NUC).
      args: [`--weights=${opts.weights}`, ...(opts.backend ? [`--backend=${opts.backend}`] : []), `--threads=${opts.threads ?? 1}`],
      options: { VerboseMoveStats: "true" },
      installHint:
        "lc0 has no apt package: build it on the NUC (docs/BRAIN.md 'Maia via lc0'), or set INTUITION_LC0_PATH.",
    });
  }

  async policy(input: DecisionInput): Promise<RawPolicy> {
    await this.uci.start();
    return this.uci.exclusive(async () => {
      const pos = input.startFen ? `fen ${input.startFen}` : "startpos";
      const moves = input.history.length ? ` moves ${input.history.join(" ")}` : "";
      // Without history lc0 sees only the current FEN; Maia works best with history.
      this.uci.send(input.history.length || !input.fen ? `position ${pos}${moves}` : `position fen ${input.fen}`);
      const mark = this.uci.mark();
      const done = this.uci.waitFor((l) => l.startsWith("bestmove"), this.opts.timeoutMs ?? 15000);
      this.uci.send("go nodes 1");
      await done;
      const stats = parseLc0VerboseStats(this.uci.since(mark));
      return { model: this.name, moves: stats };
    });
  }

  async close(): Promise<void> {
    await this.uci.stop();
  }
}

/**
 * Uniform over legal moves. Not a brain: a wiring placeholder for the
 * simulator when no network is installed. Selected only explicitly.
 */
export class UniformPolicyModel implements PolicyModel {
  readonly name = "uniform-placeholder";
  async policy(input: DecisionInput): Promise<RawPolicy> {
    const pos = parseFen(input.fen);
    const ms = legalMoves(pos, pos.turn);
    return { model: this.name, moves: ms.map((m) => ({ uci: moveUci(m), prob: 1 / ms.length })) };
  }
}
