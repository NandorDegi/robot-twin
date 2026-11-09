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
  opponentEnabled: boolean;
  elo: number;
  lastError: string;
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
  opponentEnabled: true,
  elo: 1200,
  lastError: "",
  setQ: (q) => set({ q }),
  setState: (partial) => set(partial),
}));
