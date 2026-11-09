/**
 * The decision step of the chess loop: given the board, choose the robot's move.
 *
 * This is the plug-in point. The loop does not care how a move is chosen:
 *  - EngineDecider: the local minimax engine in @robot/chess (default);
 *  - HttpDecider: any service (an LLM agent, a learned policy, a UCI engine
 *    behind a small HTTP wrapper) that answers POST {fen, legal} with a move;
 *  - FallbackDecider: try one, then another.
 *
 * A decider only proposes. Its answer is DATA: the loop accepts it only if it
 * is one of the legal moves, and the robot then plans and validates the
 * motion itself. A decider never commands the arm.
 *
 * HTTP contract (CHESS_DECIDER_URL):
 *   request : {"fen": "<FEN>", "legal": ["e2e4", ...], "side": "w"|"b"}
 *   response: {"uci": "e7e5"}  or {"san": "e5"}  or {"move": "..."}
 */
import { chooseMove, legalMoves, moveToUci, parseSan, toFen, type Move, type Position } from "@robot/chess";

export interface MoveDecider {
  readonly name: string;
  decide(pos: Position): Promise<Move | null>;
}

export class EngineDecider implements MoveDecider {
  readonly name = "engine";
  constructor(public elo = 1200) {}
  async decide(pos: Position): Promise<Move | null> {
    return chooseMove(pos, this.elo);
  }
}

export class HttpDecider implements MoveDecider {
  readonly name: string;
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 8000,
    private readonly f: typeof fetch = fetch,
  ) {
    this.name = `http(${new URL(url).host})`;
  }

  async decide(pos: Position): Promise<Move | null> {
    const legal = legalMoves(pos, pos.turn);
    try {
      const res = await this.f(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen: toFen(pos), legal: legal.map(moveToUci), side: pos.turn }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await res.json()) as { uci?: unknown; san?: unknown; move?: unknown };
      const text = [data.uci, data.san, data.move].find((v) => typeof v === "string") as string | undefined;
      if (!text) return null;
      return legal.find((m) => moveToUci(m) === text.trim()) ?? parseSan(pos, text.trim());
    } catch {
      return null;
    }
  }
}

export class FallbackDecider implements MoveDecider {
  readonly name: string;
  constructor(private readonly chain: MoveDecider[]) {
    this.name = chain.map((d) => d.name).join(" -> ");
  }
  async decide(pos: Position): Promise<Move | null> {
    for (const d of this.chain) {
      const m = await d.decide(pos);
      if (m) return m;
    }
    return null;
  }
}

/** CHESS_DECIDER_URL (or the older LLM_AGENT_URL) selects an HTTP decider with the engine as fallback. */
export function deciderFromEnv(engine: EngineDecider, env = process.env): MoveDecider {
  const url = env.CHESS_DECIDER_URL || env.LLM_AGENT_URL;
  return url ? new FallbackDecider([new HttpDecider(url), engine]) : engine;
}
