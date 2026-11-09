import { afterEach, describe, expect, it } from "vitest";
import { BOARD, squareToTarget, trayTarget } from "../src/board";
import {
  baseToTwin,
  boardReachability,
  currentBoardPose,
  fitBoardPose,
  setBoardPose,
  squareCentre,
  twinToBase,
  type BoardPose,
  type TouchPoint,
  type Vec3,
} from "../src/calibration";

const HOVER = 20;
const saved = currentBoardPose();
afterEach(() => setBoardPose(saved));

/** Deterministic pseudo-random noise in [-a, a]. */
function noise(seed: number) {
  let s = seed;
  return (a: number) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return ((s / 2147483648) * 2 - 1) * a;
  };
}

function touch(pose: BoardPose, n = 0, seed = 1): Record<TouchPoint, Vec3> {
  const r = noise(seed);
  const p = (sq: string): Vec3 => {
    const c = squareCentre(pose, sq, HOVER);
    return [c[0] + r(n), c[1] + r(n), c[2] + r(n)];
  };
  return { a1: p("a1"), h1: p("h1"), h8: p("h8") };
}

describe("board pose from a 3-point touch-off", () => {
  it("recovers an axis-aligned pose exactly", () => {
    const truth: BoardPose = { origin: [600, 0, -160], rotationDeg: 0, square: 40 };
    const fit = fitBoardPose(touch(truth), HOVER);
    expect(fit.pose.origin[0]).toBeCloseTo(600, 6);
    expect(fit.pose.origin[1]).toBeCloseTo(0, 6);
    expect(fit.pose.origin[2]).toBeCloseTo(-160, 6);
    expect(fit.pose.rotationDeg).toBeCloseTo(0, 6);
    expect(fit.pose.square).toBeCloseTo(40, 6);
    expect(fit.residualRms).toBeLessThan(1e-6);
    expect(fit.mirrored).toBe(false);
    expect(fit.warnings).toEqual([]);
  });

  it.each([7.5, -12, 90, 179])("recovers a rotated, shifted, raised board (yaw %s deg)", (yaw) => {
    const truth: BoardPose = { origin: [520, 12, -95], rotationDeg: yaw, square: 41.2 };
    const fit = fitBoardPose(touch(truth), HOVER);
    expect(fit.pose.rotationDeg).toBeCloseTo(yaw, 6);
    expect(fit.pose.origin[0]).toBeCloseTo(520, 5);
    expect(fit.pose.origin[1]).toBeCloseTo(12, 5);
    expect(fit.pose.origin[2]).toBeCloseTo(-95, 5);
    expect(fit.fittedSquare).toBeCloseTo(41.2, 6);
  });

  it("stays within the touch-off noise (±1 mm) and reports a small residual", () => {
    const truth: BoardPose = { origin: [600, 0, -160], rotationDeg: 4, square: 40 };
    for (let seed = 1; seed < 30; seed++) {
      const fit = fitBoardPose(touch(truth, 1, seed), HOVER, 40);
      expect(Math.abs(fit.pose.rotationDeg - 4)).toBeLessThan(0.5);
      expect(Math.hypot(fit.pose.origin[0] - 600, fit.pose.origin[2] + 160)).toBeLessThan(2.5);
      expect(Math.abs(fit.pose.origin[1])).toBeLessThan(1);
      expect(fit.pose.square).toBe(40);
      expect(fit.residualRms).toBeLessThan(2);
      // Every square centre lands within 2.5 mm of the truth.
      for (const sq of ["a1", "h1", "h8", "a8", "e4"]) {
        const a = squareCentre(fit.pose, sq);
        const b = squareCentre(truth, sq);
        expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(2.5);
      }
    }
  });

  it("detects points touched in a mirrored order (h8 recorded where a8 is)", () => {
    const truth: BoardPose = { origin: [600, 0, -160], rotationDeg: 0, square: 40 };
    const pts = touch(truth);
    // The operator thinks rank 8 is on the other side: h8 at h1's mirror image.
    const a8 = squareCentre(truth, "a8", HOVER);
    const a1 = squareCentre(truth, "a1", HOVER);
    const mirrored = { a1: a8, h1: squareCentre(truth, "h8", HOVER), h8: squareCentre(truth, "h1", HOVER) };
    expect(fitBoardPose(pts, HOVER).mirrored).toBe(false);
    const fit = fitBoardPose(mirrored, HOVER);
    expect(fit.mirrored).toBe(true);
    expect(fit.warnings.join(" ")).toMatch(/MIRRORED/);
    expect(a1).not.toEqual(a8);
  });

  it("warns about a tilted board and a wrong square size", () => {
    const truth: BoardPose = { origin: [600, 0, -160], rotationDeg: 0, square: 44 };
    const pts = touch(truth);
    pts.h8 = [pts.h8[0], pts.h8[1] + 6, pts.h8[2]];
    const fit = fitBoardPose(pts, HOVER, 40);
    expect(fit.warnings.some((w) => w.includes("heights differ"))).toBe(true);
    expect(fit.warnings.some((w) => w.includes("fitted square"))).toBe(true);
    expect(fit.residualRms).toBeGreaterThan(2);
  });

  it("refuses a missing point", () => {
    const pts = touch({ origin: [600, 0, -160], rotationDeg: 0, square: 40 }) as any;
    delete pts.h8;
    expect(() => fitBoardPose(pts, HOVER)).toThrow(/h8/);
  });
});

describe("board pose application", () => {
  it("squareCentre equals squareToTarget minus the grab height, for any applied pose", () => {
    const pose: BoardPose = { origin: [550, 5, -120], rotationDeg: 12, square: 42 };
    setBoardPose(pose);
    for (const sq of ["a1", "e4", "h8"]) {
      const t = squareToTarget(sq);
      const c = squareCentre(pose, sq, BOARD.grabHeight);
      expect(t[0]).toBeCloseTo(c[0], 9);
      expect(t[1]).toBeCloseTo(c[1], 9);
      expect(t[2]).toBeCloseTo(c[2], 9);
    }
    expect(trayTarget()[1]).toBeCloseTo(5 + BOARD.grabHeight, 9);
    expect(() => setBoardPose({ origin: [NaN, 0, 0], rotationDeg: 0, square: 40 })).toThrow();
  });

  it("converts between the twin and the robot base frame", () => {
    const b: Vec3 = [600, 160, 12];
    expect(baseToTwin(b)).toEqual([600, 12, -160]);
    expect(twinToBase(baseToTwin(b))).toEqual(b);
  });

  it("counts reachability over 64 squares and the tray", () => {
    const pose: BoardPose = { origin: [600, 0, -160], rotationDeg: 0, square: 40 };
    expect(boardReachability(pose, () => true)).toEqual({ reachable: 65, total: 65, unreachable: [] });
    // Unreachable beyond x < 400 (the far files) and the approach above h1.
    const r = boardReachability(pose, (p) => p[0] >= 400);
    expect(r.reachable).toBeLessThan(65);
    expect(r.unreachable).toContain("h1");
    expect(r.unreachable).not.toContain("a1");
  });
});
