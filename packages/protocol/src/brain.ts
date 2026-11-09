import { z } from "zod";

/** Commands for the chess loop (the brain's GameLoop, apps/server/src/chess.ts). */
export const brainCommandSchema = z.object({
  type: z.literal("brain"),
  cmd: z.enum(["start", "stop", "resume", "resolve", "simHuman", "simFault", "status"]),
  /** start: initial FEN (default: standard start). resolve/set-fen: the true position. */
  fen: z.string().optional(),
  robotColor: z.enum(["w", "b"]).optional(),
  /** resolve: what the human answers. */
  action: z.enum(["retry", "accept-prediction", "set-fen", "choose-move"]).optional(),
  /** resolve/choose-move and simHuman: a move in UCI. */
  uci: z.string().optional(),
  /** simFault: a fault for the simulated board. */
  fault: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("miss-grasp") }),
      z.object({ kind: z.literal("drop") }),
      z.object({ kind: z.literal("offset"), to: z.string().regex(/^[a-h][1-8]$/) }),
    ])
    .optional(),
});

export type BrainCommand = z.infer<typeof brainCommandSchema>;

/** Server -> twin brain messages. `event` is a @robot/brain LoopEvent. */
export type BrainServerMessage =
  | { type: "brain"; event: { type: string; [k: string]: unknown } }
  | { type: "brainStatus"; status: unknown };
