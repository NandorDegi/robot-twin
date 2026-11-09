# robot-twin — deploy on the lab mini PC / NUC

This runbook installs the whole stack on the compute box that drives the Panda:
**ROS 2 Humble + franka_ros2 + ros2_control + MoveIt**, the **ws_bridge** (the
piece that lets the twin talk to MoveIt), the **twin UI**, and the **vision**
service. It prepares the box only; it does not touch the robot.

The deployment is **native** (not containers) because FCI +
`franka_hardware` + `ros2_control` need real-time access to a dedicated NIC.

## 1. Hardware you need

- **Compute box / NUC**: x86_64, **Ubuntu 22.04 LTS** with the **PREEMPT_RT**
  kernel (required by libfranka/FCI). A Raspberry Pi is NOT supported here.
- Two network interfaces:
  - **NIC 1 (dedicated):** real-time FCI, wired to the Panda control unit.
  - **NIC 2 / WiFi:** LAN/internet, only for the twin and remote access.
- **Camera:** a UVC USB webcam (or the NUC's built-in camera) plugged into the
  compute box. Only needed for autonomous pick-and-place.
- **User** `robot-twin` (non-root) to run the stack.

## 2. One-time install

From the repo root on the box (as root):

```bash
sudo bash deploy/install.sh
```

This installs ROS 2 Humble + ros2_control + MoveIt, builds `franka_ros2`
from source if it is not in apt, builds the `ws_bridge` package, builds the twin,
installs Caddy, copies the vision service, and installs the systemd units.

## 3. Configure the environment

Edit `/etc/robot-twin.env` (copied from `deploy/.env.example`):

```bash
FRANKA_HOST=192.168.1.4     # Panda control unit IP (FCI)
FRANKA_NIC=eno1             # the dedicated real-time NIC
BRIDGE_MOVE_GROUP=panda_arm # must match franka_moveit_config
BRIDGE_EE_LINK=panda_hand   # must match your URDF tip frame
VISION_CAMERA_INDEX=0
```

## 4. Configure the Panda control unit (the black box)

1. Wire **NIC 1** to the **Control (shop-floor) LAN port** on the control unit —
   *not* the port on the arm's base.
2. Give the control unit a static IP (e.g. `192.168.1.4`) and the NIC a matching
   `/24` (e.g. `192.168.1.10`).
3. On the control unit: **Desk → Settings → System → Installed Features** →
   install **FCI** (needs an FCI license on Franka World).
4. In Desk: release the brakes, then **Activate FCI**.

## 5. Start the stack

```bash
systemctl enable --now robot.stack robot.vision caddy
```

- `robot.stack`  → the ROS 2 stack + ws_bridge (port 3001).
- `robot.vision` → camera + detection (port 8081).
- `caddy`        → serves the twin and proxies `/robot-ws` + `/vision`.

## 6. Verify

```bash
# 1. FCI reachable + joint state publishing:
ros2 topic echo /joint_states --once

# 2. ws_bridge up on the WS port:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001

# 3. Twin serves + vision streams (open in a browser):
#    http://<nuc-ip>:5909
```

Open `http://<nuc-ip>:5909`. You should see the arm mirrored from `/joint_states`.
Drag the green sphere — the bridge sends a MoveIt goal and the arm moves.

## 7. Values you MUST verify (they differ per install)

The bridge is correct-by-construction but these must match your `franka_ros2` /
URDF; set them in `/etc/robot-twin.env`:

| Env | Meaning | Where to check |
|---|---|---|
| `BRIDGE_MOVE_GROUP` | MoveIt planning group | `franka_moveit_config` SRDF |
| `BRIDGE_EE_LINK` | end-effector/tip link | your URDF (`panda_hand` is typical) |
| Frame mapping | twin target (mm, Y-up) → robot base (m, Z-up) | `twin_to_moveit` in `ws_bridge/node.py`; verify `TWIN_BASE_ROT` against your URDF base |
| Controller names | `joint_trajectory_controller`, `franka_gripper` | `ws_bridge/config/ros2_control.yaml` |

**Before any motion**, do a dry run in simulation:
```bash
# run the stack with a simulated arm (no Panda) to test the twin -> MoveIt path
ros2 run ws_bridge ws_bridge   # state only; motion gated until FCI is connected
```

## 8. Troubleshooting

- **`/joint_states` empty** → FCI not active or NIC on the wrong port. Re-check
  step 4 and `FRANKA_NIC`.
- **Twin shows the arm but does not move** → the bridge is up but `setEnabled`
  is off, or MoveIt `move_group` is not running. Check `ros2 node list` for
  `move_group` and the bridge log.
- **Twin opens but no camera** → `VISION_CAMERA_INDEX` wrong; `ls /dev/video*`.
- **Frame is rotated 90°** → the `TWIN_BASE_ROT` mapping / `BRIDGE_EE_LINK` don't
  match the URDF. Re-verify step 7 — never tune by eye on a live arm.
