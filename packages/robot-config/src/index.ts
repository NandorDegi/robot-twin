export * from "./config";
export type { RobotConfig } from "./config";
import { buildChain, defaultArmConfig } from "./config";
import type { KinematicChain } from "@robot/kinematics";

export const defaultChain: KinematicChain = (() => {
  const cfg = defaultArmConfig();
  return buildChain(cfg);
})();

export function chainFromConfig(config: ReturnType<typeof defaultArmConfig>): KinematicChain {
  return buildChain(config);
}
