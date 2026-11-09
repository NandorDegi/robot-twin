import { z } from "zod";
import { calibClientSchemas, type CalibServerMessage } from "./calibration";
import { brainCommandSchema, type BrainServerMessage } from "./brain";

export * from "./brain";

export * from "./calibration";

export const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof vec3Schema>;

export const setTargetSchema = z.object({
  type: z.literal("setTarget"),
  target: z.object({
    position: vec3Schema,
    orientation: z.tuple([z.number(), z.number(), z.number()]).optional(),
  }),
});

export const setJointStateSchema = z.object({
  type: z.literal("setJointState"),
  q: z.array(z.number().finite()).max(16),
});

export const gripperSchema = z.object({
  type: z.literal("gripper"),
  open: z.boolean(),
});

export const setEnabledSchema = z.object({
  type: z.literal("setEnabled"),
  enabled: z.boolean(),
});

export const estopSchema = z.object({
  type: z.literal("estop"),
});

export const homeSchema = z.object({
  type: z.literal("home"),
});

export const recordStartSchema = z.object({
  type: z.literal("recordStart"),
});

export const recordStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("target"), position: vec3Schema, wait: z.number().optional() }),
  z.object({ type: z.literal("gripper"), open: z.boolean() }),
  z.object({ type: z.literal("wait"), ms: z.number() }),
]);
export type RecordedStep = z.infer<typeof recordStepSchema>;

export const recordStopSchema = z.object({
  type: z.literal("recordStop"),
});

export const replaySchema = z.object({
  type: z.literal("replay"),
  steps: z.array(recordStepSchema),
});

/** The human's move as text or speech (with the simulated board only: with a camera, play it on the board). */
export const playSanSchema = z.object({
  type: z.literal("playSan"),
  san: z.string().min(1),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  setTargetSchema,
  setJointStateSchema,
  gripperSchema,
  setEnabledSchema,
  estopSchema,
  homeSchema,
  recordStartSchema,
  recordStopSchema,
  replaySchema,
  playSanSchema,
  brainCommandSchema,
  ...calibClientSchemas,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface JointInfo {
  name: string;
  minDeg: number;
  maxDeg: number;
}

export type ServerMessage =
  | { type: "state"; q: number[]; gripperOpen: boolean; enabled: boolean; mode: string }
  | { type: "robot"; name: string; joints: JointInfo[] }
  | { type: "target"; position: Vec3; reached: boolean; error: number; success: boolean }
  | { type: "piece"; piece: { color: string; type: string; square: [number, number] } }
  | { type: "recorded"; steps: RecordedStep[] }
  | { type: "chess"; fen: string; turn: string; lastSan: string; check: boolean; running: boolean }
  | {
      type: "loop";
      /** The brain loop state, "stopped" (no game) or "paused" (refused by a gate). */
      stage: "stopped" | "paused" | "idle" | "awaiting-human" | "robot-turn" | "acting" | "verifying" | "halted" | "game-over";
      message: string;
      mismatches: string[];
      verified: boolean;
      decider: string;
    }
  | CalibServerMessage
  | BrainServerMessage
  | { type: "error"; message: string };
