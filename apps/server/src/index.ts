import { defaultChain } from "@robot/robot-config";
import { FrankaAdapter, SimulatedAdapter } from "@robot/hardware";
import type { RobotAdapter } from "@robot/hardware";
import { RobotController } from "./controller";
import { startWebsocket } from "./ws";

const PORT = Number(process.env.PORT ?? 3001);

const chain = defaultChain;

// Select the hardware adapter: ROBOT_ADAPTER=franka uses the real Panda via the
// FCI bridge (apps/franka/franka_bridge.py); anything else (default) simulates.
let adapter: RobotAdapter;
if (process.env.ROBOT_ADAPTER === "franka") {
  adapter = new FrankaAdapter();
  console.log("[robot] using FrankaAdapter (FCI bridge)");
} else {
  adapter = new SimulatedAdapter(chain.joints.length);
  console.log("[robot] using SimulatedAdapter");
}

const controller = new RobotController(chain, adapter, {
  controlHz: 120,
  broadcastHz: 30,
  velocityLimit: Math.PI,
});

async function main(): Promise<void> {
  await controller.start();
  // Default to enabled in simulation so the twin moves immediately.
  controller.setEnabled(true);
  startWebsocket(controller, PORT);
}

process.on("SIGINT", async () => {
  controller.emergencyStop();
  await controller.stop();
  process.exit(0);
});

void main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
