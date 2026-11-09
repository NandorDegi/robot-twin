import { defaultChain } from "@robot/robot-config";
import { FrankaAdapter, SimulatedAdapter } from "@robot/hardware";
import type { RobotAdapter } from "@robot/hardware";
import { RobotController } from "./controller";
import { startWebsocket } from "./ws";
import { ChessSession } from "./chess";
import { EngineDecider, deciderFromEnv } from "./decider";
import { VisionObserver } from "./observer";

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
const chess = new ChessSession(controller, {
  decider: deciderFromEnv(new EngineDecider(Number(process.env.CHESS_ELO ?? 1200))),
  observer: visionUrl ? new VisionObserver(visionUrl) : null,
  requireVision: process.env.CHESS_REQUIRE_VISION ? process.env.CHESS_REQUIRE_VISION === "1" : adapter.isReal,
});

async function main(): Promise<void> {
  await controller.start();
  // Simulation starts enabled for convenience. A real robot never does: a
  // person enables it in the twin after checking the robot and its stop.
  if (!adapter.isReal) controller.setEnabled(true);
  startWebsocket(controller, PORT, { host: HOST, chess });
  console.log(`[robot] decider: ${chess.deciderName}; vision: ${visionUrl || "none"}`);
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
