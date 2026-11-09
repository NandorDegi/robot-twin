/**
 * Observer backed by the vision service: GET <VISION_URL>/observe returns the
 * per-square observation (apps/vision/vision/observe.py).
 */
import type { Color, PieceType } from "@robot/chess";
import type { Observer } from "./loop";
import { ALL_SQUARES } from "./selfcheck";
import type { Observation, SquareObservation } from "./types";

export class ObservationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ObservationError";
  }
}

const COLORS = new Set(["w", "b"]);
const TYPES = new Set(["p", "n", "b", "r", "q", "k"]);

/** Validate the JSON from /observe. Unknown or malformed squares become "unknown" (confidence 0). */
export function parseObservation(data: unknown): Observation {
  const d = data as { calibrated?: boolean; squares?: Record<string, Partial<SquareObservation>>; source?: string; timestamp?: string; frame_id?: string; error?: string };
  if (!d || typeof d !== "object") throw new ObservationError("vision: response is not an object");
  if (d.error) throw new ObservationError(`vision: ${d.error}`);
  if (d.calibrated === false) throw new ObservationError("vision: the board is not calibrated (run calibration first)");
  if (!d.squares || typeof d.squares !== "object") throw new ObservationError("vision: no squares in response");
  const squares: Record<string, SquareObservation> = {};
  for (const sq of ALL_SQUARES) {
    const s = d.squares[sq];
    const conf = Number(s?.confidence);
    const color = s && COLORS.has(String(s.color)) ? (s.color as Color) : null;
    const type = color && s && TYPES.has(String(s.type)) ? (s.type as PieceType) : null;
    squares[sq] = { color, type, confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0 };
  }
  return { squares, source: String(d.source ?? "vision"), timestamp: String(d.timestamp ?? new Date().toISOString()), frameId: d.frame_id };
}

export class VisionObserver implements Observer {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  async observe(): Promise<Observation> {
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.baseUrl.replace(/\/$/, "")}/observe`, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000) });
    } catch (err) {
      throw new ObservationError(`vision service unreachable at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ObservationError(`vision HTTP ${res.status}`);
    return parseObservation(await res.json());
  }
}
