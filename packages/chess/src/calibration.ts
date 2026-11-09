/**
 * Board pose in the robot frame: fit from a touch-off, apply, check reach.
 *
 * Frames: the twin model frame T (Y up, mm) is where BOARD and the IK live.
 * The robot base frame B (Z up, mm) is what FCI reports. T = RotX(-90) * B:
 * (x, y, z)_B -> (x, z, -y)_T.
 *
 * Board pose = BOARD.origin (the a1 CORNER, T), BOARD.rotationDeg (yaw about
 * T's Y axis) and BOARD.square. At yaw 0 the files a..h run toward -X and the
 * ranks 1..8 toward +Z (see boardOffset in board.ts).
 */
import { BOARD } from "./board";

export type Vec3 = [number, number, number];

export interface BoardPose {
  /** a1 corner of the board, twin frame (mm). */
  origin: Vec3;
  rotationDeg: number;
  /** Side of one square (mm). */
  square: number;
}

export const TOUCH_POINTS = ["a1", "h1", "h8"] as const;
export type TouchPoint = (typeof TOUCH_POINTS)[number];

export function twinToBase(p: Vec3): Vec3 {
  return [p[0], -p[2], p[1]];
}

export function baseToTwin(p: Vec3): Vec3 {
  return [p[0], p[2], -p[1]];
}

export function currentBoardPose(): BoardPose {
  return { origin: [...BOARD.origin] as Vec3, rotationDeg: BOARD.rotationDeg, square: BOARD.square };
}

/**
 * Use a calibrated board pose everywhere (squareToTarget, trayTarget, the
 * planner). The calibration file is the source; this only applies it.
 */
export function setBoardPose(p: BoardPose): void {
  if (![...p.origin, p.rotationDeg, p.square].every(Number.isFinite) || p.square <= 0) {
    throw new Error("invalid board pose");
  }
  BOARD.origin = [...p.origin] as Vec3;
  BOARD.rotationDeg = p.rotationDeg;
  BOARD.square = p.square;
}

/** Twin-frame point of a board-local (file, rank) offset in squares, at `height` above the surface. */
export function boardPoint(pose: BoardPose, fileUnits: number, rankUnits: number, height = 0): Vec3 {
  const t = (pose.rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const lx = -fileUnits * pose.square;
  const lz = rankUnits * pose.square;
  return [pose.origin[0] + lx * c + lz * s, pose.origin[1] + height, pose.origin[2] - lx * s + lz * c];
}

/** Centre of a square ("e4") at `height` above the board surface (twin frame). */
export function squareCentre(pose: BoardPose, square: string, height = 0): Vec3 {
  const f = "abcdefgh".indexOf(square[0] ?? "");
  const r = Number(square[1]) - 1;
  if (f < 0 || !(r >= 0 && r < 8)) throw new Error(`bad square ${square}`);
  return boardPoint(pose, f + 0.5, r + 0.5, height);
}

export interface TouchOffFit {
  /** Pose with the chosen square size (fitted, or the fixed one). */
  pose: BoardPose;
  fittedSquare: number;
  /** Residual of the planar fit (mm). */
  residualRms: number;
  residualMax: number;
  perPoint: Record<TouchPoint, number>;
  /** max - min of the recorded heights (mm): board tilt or a bad touch. */
  heightSpread: number;
  /** The points fit a mirrored board better (a1/h8 swapped, wrong order?). */
  mirrored: boolean;
  warnings: string[];
}

const LOCAL: Record<TouchPoint, [number, number]> = {
  // (lx, lz) in squares for the square centres: lx = -(file + 0.5), lz = rank + 0.5.
  a1: [-0.5, 0.5],
  h1: [-7.5, 0.5],
  h8: [-7.5, 7.5],
};

interface Sim2 {
  phi: number;
  scale: number;
  tx: number;
  tz: number;
  res: number[];
}

/** Least-squares 2D similarity M = T + s * Rot(phi) * L (Umeyama). */
function similarity(L: [number, number][], M: [number, number][], fixedScale?: number): Sim2 {
  const n = L.length;
  const mL = [L.reduce((a, p) => a + p[0], 0) / n, L.reduce((a, p) => a + p[1], 0) / n];
  const mM = [M.reduce((a, p) => a + p[0], 0) / n, M.reduce((a, p) => a + p[1], 0) / n];
  let num = 0;
  let den = 0;
  let var2 = 0;
  for (let i = 0; i < n; i++) {
    const ax = L[i]![0] - mL[0]!;
    const ay = L[i]![1] - mL[1]!;
    const bx = M[i]![0] - mM[0]!;
    const by = M[i]![1] - mM[1]!;
    num += ax * by - ay * bx;
    den += ax * bx + ay * by;
    var2 += ax * ax + ay * ay;
  }
  const phi = Math.atan2(num, den);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const scale = fixedScale ?? (c * den + s * num) / var2;
  const tx = mM[0]! - scale * (c * mL[0]! - s * mL[1]!);
  const tz = mM[1]! - scale * (s * mL[0]! + c * mL[1]!);
  const res = L.map((p, i) => {
    const x = tx + scale * (c * p[0] - s * p[1]);
    const z = tz + scale * (s * p[0] + c * p[1]);
    return Math.hypot(x - M[i]![0], z - M[i]![1]);
  });
  return { phi, scale, tx, tz, res };
}

/**
 * Board pose from the TCP at the centres of a1, h1 and h8, recorded at
 * `hoverMm` above the board surface (twin frame, mm).
 * `fixedSquare`: use this square size (the nominal one) instead of the fit.
 */
export function fitBoardPose(points: Record<TouchPoint, Vec3>, hoverMm: number, fixedSquare?: number): TouchOffFit {
  for (const k of TOUCH_POINTS) {
    if (!points[k] || !points[k].every(Number.isFinite)) throw new Error(`touch-off point ${k} is missing`);
  }
  const L = TOUCH_POINTS.map((k) => LOCAL[k]);
  const M = TOUCH_POINTS.map((k) => [points[k][0], points[k][2]] as [number, number]);
  const free = similarity(L, M);
  const fit = fixedSquare ? similarity(L, M, fixedSquare) : free;
  const mirror = similarity(
    L.map(([x, z]) => [x, -z] as [number, number]),
    M,
  );
  const rms = (r: number[]) => Math.sqrt(r.reduce((a, v) => a + v * v, 0) / r.length);
  const freeRms = rms(free.res);
  const mirrored = rms(mirror.res) < 0.5 * freeRms && freeRms > 3;
  // Rot(phi) is the standard rotation; boardOffset rotates by -yaw.
  let rotationDeg = (-fit.phi * 180) / Math.PI;
  if (rotationDeg <= -180) rotationDeg += 360;
  const ys = TOUCH_POINTS.map((k) => points[k][1]);
  const y = ys.reduce((a, v) => a + v, 0) / ys.length - hoverMm;
  const pose: BoardPose = { origin: [fit.tx, y, fit.tz], rotationDeg, square: fit.scale };
  const heightSpread = Math.max(...ys) - Math.min(...ys);
  const warnings: string[] = [];
  if (mirrored) warnings.push("the points fit a MIRRORED board: record a1, h1, h8 in this order (rank 1 is the white side)");
  if (rms(fit.res) > 2) warnings.push(`large residual ${rms(fit.res).toFixed(1)} mm: re-touch the points more carefully`);
  if (heightSpread > 3) warnings.push(`the heights differ by ${heightSpread.toFixed(1)} mm: board tilted, or a point not at the hover height`);
  const nominal = fixedSquare ?? BOARD.square;
  if (Math.abs(free.scale - nominal) / nominal > 0.015) {
    warnings.push(`fitted square ${free.scale.toFixed(1)} mm differs from ${nominal} mm by more than 1.5%`);
  }
  return {
    pose,
    fittedSquare: free.scale,
    residualRms: rms(fit.res),
    residualMax: Math.max(...fit.res),
    perPoint: { a1: fit.res[0]!, h1: fit.res[1]!, h8: fit.res[2]! },
    heightSpread,
    mirrored,
    warnings,
  };
}

export interface Reachability {
  reachable: number;
  total: number;
  unreachable: string[];
}

/**
 * The same check as `calibrate --check`: every square and the tray must be
 * reachable with the hand pointing down at the grab height and `approachMm`
 * above it. `canReach` solves the IK (injected: robot-config owns the solver).
 */
export interface ReachabilityOptions {
  grabHeight?: number;
  approachMm?: number;
  tray?: { file: number; rank: number };
}

/** The points of the reach check: per square (and the tray) the grab point and the approach point. */
export function reachabilityChecks(pose: BoardPose, opts: ReachabilityOptions = {}): { name: string; points: [Vec3, Vec3] }[] {
  const grab = opts.grabHeight ?? BOARD.grabHeight;
  const approach = opts.approachMm ?? 100;
  const tray = opts.tray ?? BOARD.tray;
  const at = (f: number, r: number): [Vec3, Vec3] => [boardPoint(pose, f, r, grab), boardPoint(pose, f, r, grab + approach)];
  const out: { name: string; points: [Vec3, Vec3] }[] = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) out.push({ name: `${"abcdefgh"[f]}${r + 1}`, points: at(f + 0.5, r + 0.5) });
  out.push({ name: "tray", points: at(tray.file + 0.5, tray.rank + 0.5) });
  return out;
}

/** Result of one check: null when reachable, else the name to report. */
export function reachabilityMiss(c: { name: string; points: [Vec3, Vec3] }, canReach: (p: Vec3) => boolean): string | null {
  if (!canReach(c.points[0])) return c.name;
  if (!canReach(c.points[1])) return `${c.name} (approach)`;
  return null;
}

/**
 * The same check as `calibrate --check`: every square and the tray must be
 * reachable with the hand pointing down at the grab height and `approachMm`
 * above it. `canReach` solves the IK (injected: robot-config owns the solver).
 */
export function boardReachability(pose: BoardPose, canReach: (p: Vec3) => boolean, opts: ReachabilityOptions = {}): Reachability {
  const checks = reachabilityChecks(pose, opts);
  const unreachable = checks.map((c) => reachabilityMiss(c, canReach)).filter((m): m is string => m !== null);
  return { reachable: checks.length - unreachable.length, total: checks.length, unreachable };
}
