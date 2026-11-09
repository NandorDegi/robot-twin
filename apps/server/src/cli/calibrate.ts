/**
 * Calibration helper for the robot-twin. Two halves of "is the twin 100% like
 * reality":
 *
 *  1. Kinematics — already exact. The model uses the official Franka values and
 *     drives the SAME joint angles the robot reports, so relative motion matches
 *     one-to-one. Nothing to do.
 *  2. Board placement — the only thing you must measure. The twin's board and
 *     the physical board must agree on where each square is in the robot frame.
 *
 * Frames (memorise this one line):
 *   - Robot base frame (B): Z-up, mm. What FCI reports in O_T_EE.
 *   - Twin model frame (T): Y-up, mm. Where the chess BOARD and the IK live.
 *   - T = RotX(-90) * B. Point conversion: (x, y, z)_B  ->  (x, z, -y)_T.
 *
 * Run it interactively (recommended) — it tells you what to measure and then
 * asks for the numbers:
 *
 *     pnpm --filter @robot/server calibrate
 *
 * Non-interactive modes:
 *     pnpm --filter @robot/server calibrate --check
 *     pnpm --filter @robot/server calibrate --from-robot X Y Z [--h1 X Y Z]
 *     pnpm --filter @robot/server calibrate --out board_calibration.json
 */
import {
  APPROACH_HEIGHT_MM,
  buildChain,
  createPandaSolver,
  defaultArmConfig,
  seedToward,
  toolDownRotation,
} from "@robot/robot-config";
import type { Vec3 } from "@robot/kinematics";
import { BOARD } from "@robot/chess";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";


/** B -> T: (x, y, z)_B  ->  (x, z, -y)_T. */
function robotToTwin(p: Vec3): [number, number, number] {
  return [p[0], p[2], -p[1]];
}

/** Target for square (row, col) given a board origin/yaw (both in T). */
function squareTarget(
  origin: [number, number, number],
  rotationDeg: number,
  col: number,
  row: number,
): [number, number, number] {
  const s = BOARD.square;
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  // a-file at the high-X corner (origin); files run toward -X, ranks toward +Z.
  const lx = -(col + 0.5) * s;
  const lz = (row + 0.5) * s;
  return [origin[0] + lx * c + lz * sn, origin[1] + BOARD.grabHeight, origin[2] - lx * sn + lz * c];
}

function trayTarget(
  origin: [number, number, number],
  rotationDeg: number,
): [number, number, number] {
  const s = BOARD.square;
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const lx = -(BOARD.tray.file + 0.5) * s;
  const lz = (BOARD.tray.rank + 0.5) * s;
  return [origin[0] + lx * c + lz * sn, origin[1] + BOARD.grabHeight, origin[2] - lx * sn + lz * c];
}

/** Yaw (deg) that makes the board's a-h edge (= -X at 0) point along a given T vector. */
function yawFromAtoH(a1T: [number, number, number], h1T: [number, number, number]): number {
  const dx = h1T[0] - a1T[0];
  const dz = h1T[2] - a1T[2];
  return (Math.atan2(dz, -dx) * 180) / Math.PI;
}

function reachability(origin: [number, number, number], rotationDeg: number): void {
  const chain = buildChain(defaultArmConfig());
  const solver = createPandaSolver(chain);
  const down = toolDownRotation(chain);
  const cols = "abcdefgh";
  let ok = 0;
  const misses: string[] = [];
  // A square counts as reachable when the hand can point straight down at the
  // grab height AND at the approach height above it (the robot descends
  // vertically from there).
  const check = (name: string, t: [number, number, number]) => {
    for (const dy of [0, APPROACH_HEIGHT_MM]) {
      const p: [number, number, number] = [t[0], t[1] + dy, t[2]];
      const res = solver.solve({ position: p, orientation: down }, { seed: seedToward(p) });
      if (!res.success) {
        misses.push(`${name}${dy ? " (approach)" : ""} (err ${Number.isFinite(res.error) ? res.error.toFixed(1) : "no safe pose"}mm)`);
        return;
      }
    }
    ok++;
  };
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) check(`${cols[col]}${row + 1}`, squareTarget(origin, rotationDeg, col, row));
  }
  check("tray", trayTarget(origin, rotationDeg));

  console.log("\nReachability of every square + tray:");
  console.log(`  reachable: ${ok}/${65}`);
  if (misses.length) {
    console.log("  UNREACHABLE:");
    for (const m of misses) console.log(`    - ${m}`);
    console.log("  Move the board closer to the base or lower grabHeight.");
  } else {
    console.log("  all squares reachable — good.");
  }
}

function printConfig(origin: [number, number, number], rotationDeg: number): void {
  console.log("\n=== Result: twin board config (model frame T, Y-up, mm) ===");
  console.log(`  BOARD.origin = [${origin[0]}, ${origin[1]}, ${origin[2]}]`);
  console.log(`  BOARD.rotationDeg = ${rotationDeg.toFixed(2)}`);
  console.log(`  BOARD.square = ${BOARD.square}   grabHeight = ${BOARD.grabHeight}`);
  console.log("\nPaste these into:");
  console.log("  packages/chess/src/board.ts         (BOARD.origin, BOARD.rotationDeg)");
  console.log("  apps/vision/vision/config.py        (VISION_BOARD_ORIGIN_X/Y/Z, VISION_BOARD_ROTATION_DEG)");
  console.log("  or export VISION_BOARD_* env vars for the vision service");
}

function writeConfig(out: string, origin: [number, number, number], rotationDeg: number): void {
  const data = {
    origin,
    rotationDeg: Number(rotationDeg.toFixed(2)),
    square: BOARD.square,
    grabHeight: BOARD.grabHeight,
    frames: "board origin/rotation in the twin model frame (T, Y-up, mm); T = RotX(-90)_B",
  };
  writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`\nWrote ${out}`);
}

async function interactive(): Promise<void> {
  const rl = createInterface({ input, output });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();

  console.log("\n=== Board placement calibration ===");
  console.log("The model kinematics are already correct. You only need to tell the");
  console.log("twin where the physical board sits in the ROBOT base frame (B, Z-up, mm).");
  console.log("The twin converts it to its model frame (T = RotX(-90)*B) for you.\n");

  console.log("What to measure — three board corners, in the robot base frame B:");
  console.log("  1. a1 corner: the board corner where the a-file meets rank 1 (the");
  console.log("     bottom-left corner of square a1). This is the board ORIGIN.");
  console.log("  2. h1 corner: the corner where the h-file meets rank 1 (bottom-right).");
  console.log("     Gives the board's rotation (yaw) on the table. Optional if the");
  console.log("     board is set square to the robot.");
  console.log("\nEasiest way to get these in B: put the gripper's grasp centre on a");
  console.log("corner, then read the position from FCI (O_T_EE). Enter X Y Z, mm.\n");

  const a1 = await ask("a1 corner (X Y Z B, mm) [e.g. 210 160 0]: ");
  const a1B = parseVec(a1);
  if (!a1B) return finish(rl, "bad a1 value");

  const h1Raw = await ask("\nh1 corner (X Y Z B, mm) — or press Enter to assume axis-aligned: ");
  let rotationDeg = 0;
  if (h1Raw) {
    const h1B = parseVec(h1Raw);
    if (!h1B) return finish(rl, "bad h1 value");
    const a1T = robotToTwin(a1B);
    const h1T = robotToTwin(h1B);
    rotationDeg = yawFromAtoH(a1T, h1T);
    console.log(`\n  Detected board yaw: ${rotationDeg.toFixed(2)} deg`);
    if (Math.abs(rotationDeg) < 0.5) {
      console.log("  Board is essentially square to the robot — you can set rotationDeg: 0.");
    } else {
      console.log("  The board is rotated. The config below applies this yaw; make sure you");
      console.log("  also set VISION_BOARD_ROTATION_DEG to the same value.");
    }
  }

  const origin = robotToTwin(a1B);
  printConfig(origin, rotationDeg);
  reachability(origin, rotationDeg);

  const out = (await ask("\nWrite to board_calibration.json? [Y/n]: ")).toLowerCase();
  if (out !== "n") writeConfig("board_calibration.json", origin, rotationDeg);
  finish(rl, null);
}

function parseVec(s: string): Vec3 | null {
  const nums = s.split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.length !== 3 || nums.some((n) => Number.isNaN(n))) return null;
  return nums as Vec3;
}

function finish(rl: ReturnType<typeof createInterface>, err: string | null): void {
  rl.close();
  if (err) {
    console.error(err);
    process.exit(1);
  }
  process.exit(0);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    void interactive();
    return;
  }

  if (argv.includes("--check")) {
    reachability(BOARD.origin, BOARD.rotationDeg);
    return;
  }

  const fromIdx = argv.indexOf("--from-robot");
  if (fromIdx !== -1) {
    const a1B = parseVec(argv.slice(fromIdx + 1, fromIdx + 4).join(" ") + " ");
    if (!a1B) {
      console.error("--from-robot expects three numbers: X Y Z (robot frame B, mm)");
      process.exit(1);
    }
    const origin = robotToTwin(a1B);
    let rotationDeg = 0;
    const h1Idx = argv.indexOf("--h1");
    if (h1Idx !== -1) {
      const h1B = parseVec(argv.slice(h1Idx + 1, h1Idx + 4).join(" ") + " ");
      if (!h1B) {
        console.error("--h1 expects three numbers: X Y Z (robot frame B, mm)");
        process.exit(1);
      }
      rotationDeg = yawFromAtoH(origin, robotToTwin(h1B));
    }
    printConfig(origin, rotationDeg);
    reachability(origin, rotationDeg);
    const outIdx = argv.indexOf("--out");
    if (outIdx !== -1) writeConfig(argv[outIdx + 1]!, origin, rotationDeg);
    return;
  }

  console.error("unknown flags. Run without args for the interactive guide.");
  process.exit(1);
}

main();
