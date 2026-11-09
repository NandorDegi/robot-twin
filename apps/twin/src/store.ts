import { create } from "zustand";
import type { JointInfo, RecordedStep } from "@robot/protocol";

interface TwinState {
  q: number[];
  gripperOpen: boolean;
  /** Slow gripper travel: the full stroke takes ~2.5 s instead of ~0.7 s. */
  gripperSlow: boolean;
  enabled: boolean;
  connected: boolean;
  mode: string;
  target: [number, number, number];
  jointInfo: JointInfo[];
  lastRecorded: RecordedStep[];
  recording: boolean;
  fen: string;
  turn: string;
  lastSan: string;
  check: boolean;
  /** True while a game of the chess loop is running on the server. */
  loopRunning: boolean;
  lastError: string;
  /** True once the server reported a real robot: never fall back to the local sim then. */
  everReal: boolean;
  loopStage: string;
  loopMessage: string;
  loopMismatches: string[];
  decider: string;
  setQ(q: number[]): void;
  setState(partial: Partial<Omit<TwinState, "setQ" | "setState">>): void;
}

export const useTwin = create<TwinState>((set) => ({
  q: [0, 0, 0, 0, 0, 0, 0],
  gripperOpen: false,
  gripperSlow: false,
  enabled: false,
  connected: false,
  mode: "sim",
  target: [300, 300, 0],
  jointInfo: [],
  lastRecorded: [],
  recording: false,
  fen: "",
  turn: "w",
  lastSan: "",
  check: false,
  loopRunning: false,
  lastError: "",
  everReal: false,
  loopStage: "stopped",
  loopMessage: "",
  loopMismatches: [],
  decider: "",
  setQ: (q) => set({ q }),
  setState: (partial) => set(partial),
}));
