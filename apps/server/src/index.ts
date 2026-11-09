import { defaultChain } from "@robot/robot-config";
import { FrankaAdapter, SimulatedAdapter } from "@robot/hardware";
import type { RobotAdapter } from "@robot/hardware";
import { RobotController } from "./controller";
import { startWebsocket } from "./ws";
import { ChessSession } from "./chess";
import { CalibrationService } from "./calib/service";
import { CalibrationStore, defaultCalibrationFile } from "./calib/store";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.ROBOT_WS_HOST ?? "127.0.0.1";

const chain = defaultChain;

// Select the hardware adapter. Default: simulation.
// ROBOT_ADAPTER=franka drives the Panda through the Franka bridge
// (apps/franka/franka_bridge.py). It is the only supported real-robot path.
let adapter: RobotAdapter;
const which = process.env.ROBOT_ADAPTER ?? "simulated";
if (which === "franka") {
  adapter = new FrankaAdapter();
  console.log("[robot] using FrankaAdapter (Franka bridge, panda-py)");
} else if (which === "simulated") {
  adapter = new SimulatedAdapter(chain.joints.length);
  console.log("[robot] using SimulatedAdapter");
} else {
  console.error(`[robot] unknown ROBOT_ADAPTER=${which} (use simulated | franka)`);
  process.exit(2);
}

const controller = new RobotController(chain, adapter, {
  controlHz: 120,
  broadcastHz: 30,
  speedScaling: Number(process.env.ROBOT_SIM_SPEED_SCALING ?? 1),
});

const visionUrl = process.env.VISION_URL ?? "";

function parsePose(v: string | undefined): number[] | undefined {
  if (!v) return undefined;
  const q = v.split(",").map((x) => Number(x.trim()));
  if (q.length !== 7 || !q.every(Number.isFinite)) {
    console.error(`[robot] CHESS_OBSERVE_POSE must be 7 comma-separated radians, got "${v}"`);
    process.exit(2);
  }
  return q;
}
// Calibration wizard: the loop refuses to run without a valid saved
// calibration whenever the camera is part of the loop (or on a real robot).
const calib = new CalibrationService(controller, {
  store: new CalibrationStore(defaultCalibrationFile()),
  visionUrl,
  required: process.env.CHESS_REQUIRE_CALIBRATION
    ? process.env.CHESS_REQUIRE_CALIBRATION === "1"
    : Boolean(visionUrl) || adapter.isReal,
});
calib.reload();
{
  const st = calib.store.state;
  console.log(`[robot] calibration ${st.file}: ${st.valid ? `r${st.calibration?.revision} valid` : st.reasons.join("; ")}`);
}

// The one chess loop: the brain decides, the controller acts, the camera checks.
const chess = new ChessSession(controller, {
  calibrationGate: () => calib.gate(),
  visionUrl,
  requireVision: process.env.CHESS_REQUIRE_VISION ? process.env.CHESS_REQUIRE_VISION === "1" : adapter.isReal,
  observePose: parsePose(process.env.CHESS_OBSERVE_POSE),
  settleMs: Number(process.env.CHESS_SETTLE_MS ?? 500),
});
calib.attach(chess);

async function main(): Promise<void> {
  await controller.start();
  // Simulation starts enabled for convenience. A real robot never does: a
  // person enables it in the twin after checking the robot and its stop.
  if (!adapter.isReal) controller.setEnabled(true);
  startWebsocket(controller, PORT, { host: HOST, chess, calib });
  console.log(`[robot] chess loop: brain (${process.env.BRAIN_INTUITION ?? "searchless"} + reflection ${process.env.BRAIN_REFLECTION ?? "local"}); camera ${chess.observerKind}; vision ${visionUrl || "none"}; stopped until Start`);
}

const shutdown = async () => {
  controller.emergencyStop();
  await controller.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
