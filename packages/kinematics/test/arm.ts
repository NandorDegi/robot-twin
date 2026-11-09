import { mat4Identity, mat4Translation } from "../src/math3d";
import type { KinematicChain, KinematicJoint } from "../src/types";

/**
 * A representative 4-DOF arm (base yaw + shoulder + elbow + wrist yaw),
 * used by the tests and as the default placeholder model.
 *
 * Geometry (metres):
 *   base height 0.04, upper arm 0.14, forearm 0.13, tool tip 0.02.
 */
export function makeTestArm(includeLimits = true): KinematicChain {
  const axisZ = [0, 0, 1] as [number, number, number];
  const axisY = [0, 1, 0] as [number, number, number];

  const joints: KinematicJoint[] = [
    {
      name: "base",
      min: includeLimits ? -Math.PI : -Infinity,
      max: includeLimits ? Math.PI : Infinity,
      axis: axisZ,
      origin: mat4Identity(),
    },
    {
      name: "shoulder",
      min: includeLimits ? -Math.PI / 2 : -Infinity,
      max: includeLimits ? Math.PI / 2 : Infinity,
      axis: axisY,
      origin: mat4Translation(0, 0, 0.04),
    },
    {
      name: "elbow",
      min: includeLimits ? -Math.PI / 2 : -Infinity,
      max: includeLimits ? Math.PI / 2 : Infinity,
      axis: axisY,
      origin: mat4Translation(0.14, 0, 0),
    },
    {
      name: "wrist",
      min: includeLimits ? -Math.PI : -Infinity,
      max: includeLimits ? Math.PI : Infinity,
      axis: axisZ,
      origin: mat4Translation(0.13, 0, 0),
    },
  ];

  return {
    name: "test-arm",
    base: mat4Identity(),
    joints,
    tool: mat4Translation(0.02, 0, 0),
  };
}
