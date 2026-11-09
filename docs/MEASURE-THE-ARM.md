# Measure the arm

The twin and the IK solver work today with a placeholder 4-DOF arm
(`packages/robot-config/src/config.ts`, `defaultArmConfig`). To match the real
arm, edit that config. Here is exactly what to find and how to write it.

## What to collect

For each joint, note the **axis**, the **limit**, and the **offset from the
previous joint**.

1. **Number of joints and types.** Are they all revolute (rotate) or any
   prismatic (slide)?
2. **Rotation axis of each joint**, in its own local frame — write `x`, `y` or
   `z`, or a vector. Think of it from the joint's point of view, not the world:
   a shoulder that pitches the arm up/down is usually a single horizontal axis
   (say `y`); the base that turns left/right is `z`; a wrist that spins the
   gripper is `z`.
3. **Joint limits**, in degrees (min / max each).
4. **Offset from the parent link to this joint**, in metres. This is the common
   `origin.position`: the distance along X/Y/Z from the previous joint's frame to
   this joint's pivot. Example: a base that raises the shoulder by 4 cm is
   `position: [0, 0, 0.04]`; an upper arm 14 cm long toward the elbow is
   `position: [0.14, 0, 0]` on the shoulder joint.
5. **Tool/gripper offset** (`tool.position`): the small distance from the wrist
   to the gripper tip.
6. **Motor/gearbox type** (servo? stepper? ratio) — only needed for the hardware
   adapter, not the twin.
7. **Controller board** — the printed name on the board, its firmware, and how it
   talks to a PC (USB serial? library? ROS?). This is only for `SerialAdapter`.

## How to write it

Edit `packages/robot-config/src/config.ts` `defaultArmConfig`, e.g.:

```ts
joints: [
  { name: "base",     axis: "z", minDeg: -180, maxDeg: 180, origin: { position: [0, 0, 0] } },
  { name: "shoulder", axis: "y", minDeg: -90,  maxDeg: 90,  origin: { position: [0, 0, 0.04] } },
  { name: "elbow",    axis: "y", minDeg: -90,  maxDeg: 90,  origin: { position: [0.14, 0, 0] } },
  { name: "wrist",    axis: "z", minDeg: -180, maxDeg: 180, origin: { position: [0.13, 0, 0] } },
],
tool: { position: [0.02, 0, 0] }
```

If the joint frame is rotated (for example a slanted shoulder), add
`orientation: { x, y, z }` in degrees to `origin`.

## Verify

After editing, run:

```bash
pnpm --filter kinematics test   # FK/IK round-trip
pnpm dev:twin                   # drag the target; the twin should move like the arm
```

## Useful tips

- If a joint's `origin.position` points along a different axis than expected,
  the arm will look bent. The `origin.position` is **in the parent joint's
  frame**, after the parent's rotation, so write it as if you were standing in
  the parent link looking along its axes.
- If the IK cannot reach a target you expect to reach, the limits or the link
  lengths are probably wrong; check the HUD end-effector position against a tape
  measure.
- A photo of the arm (or the brand/model string) is often enough to derive the
  full spec — send it and the config can be filled in for you.
