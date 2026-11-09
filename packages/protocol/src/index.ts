import { z } from "zod";
import { brainCommandSchema, type BrainServerMessage } from "./brain";

export * from "./brain";

export const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
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
  q: z.array(z.number()),
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

export const playSanSchema = z.object({
  type: z.literal("playSan"),
  san: z.string().min(1),
});

export const setOpponentSchema = z.object({
  type: z.literal("setOpponent"),
  enabled: z.boolean(),
  elo: z.number().min(100).max(2800).optional(),
});

export const resetGameSchema = z.object({
  type: z.literal("resetGame"),
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
  setOpponentSchema,
  resetGameSchema,
  brainCommandSchema,
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
  | { type: "chess"; fen: string; turn: string; lastSan: string; check: boolean; opponentEnabled: boolean; elo: number }
  | { type: "error"; message: string }
  | BrainServerMessage;
