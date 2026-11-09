/**
 * The camera step of the chess loop: what is on the board now.
 *
 * The vision service (apps/vision, GET /board) reports, per square, empty or
 * the colour of the piece on it. That is enough to (1) infer the human's move
 * against the tracked game, and (2) verify that the robot's move happened.
 */
import { ALL_SQUARES, type Occupancy } from "@robot/chess";

export type Observation = { ok: true; occupancy: Occupancy } | { ok: false; error: string };

export interface BoardObserver {
  readonly name: string;
  observe(): Promise<Observation>;
}

export class VisionObserver implements BoardObserver {
  readonly name = "vision";
  constructor(
    private readonly baseUrl: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  async observe(): Promise<Observation> {
    try {
      const res = await this.f(`${this.baseUrl.replace(/\/$/, "")}/board`, { signal: AbortSignal.timeout(5000) });
      const data = (await res.json()) as { ok?: boolean; error?: string; squares?: Record<string, unknown> };
      if (!data.ok || !data.squares) return { ok: false, error: data.error ?? "vision returned no board" };
      const occ: Occupancy = {};
      for (const sq of ALL_SQUARES) {
        const v = data.squares[sq];
        if (v !== "w" && v !== "b" && v !== null) return { ok: false, error: `vision: bad value for ${sq}` };
        occ[sq] = v;
      }
      return { ok: true, occupancy: occ };
    } catch (err) {
      return { ok: false, error: `vision unreachable: ${String(err)}` };
    }
  }
}
