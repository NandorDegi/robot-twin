"""Robot model and runtime configuration for the ws_bridge.

The bridge needs the Panda joint names and limits so it can send the twin the
same ``robot`` message that the Node server sends. Franka publishes ``/joint_states``
in the order joint1..joint7, so the order here must match.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List


@dataclass
class Joint:
    name: str
    min_deg: float
    max_deg: float


# Arm prefix of the joint names in the URDF: "panda" gives panda_joint1..7
# (franka_ros2 0.1.x with a Panda); "fr3" gives fr3_joint1..7.
ARM_ID = os.environ.get("BRIDGE_ARM_ID", "panda")

# Official Franka Emika Panda (FER) limits in degrees (packages/robot-config/
# panda-limits.json). Used to describe the arm to the twin UI.
PANDA_JOINTS: List[Joint] = [
    Joint(f"{ARM_ID}_joint1", -166.0, 166.0),
    Joint(f"{ARM_ID}_joint2", -101.0, 101.0),
    Joint(f"{ARM_ID}_joint3", -166.0, 166.0),
    Joint(f"{ARM_ID}_joint4", -176.0, -4.0),
    Joint(f"{ARM_ID}_joint5", -166.0, 166.0),
    Joint(f"{ARM_ID}_joint6", -1.0, 215.0),
    Joint(f"{ARM_ID}_joint7", -166.0, 166.0),
]

# EXPERIMENTAL: motion through MoveIt. Off unless BRIDGE_EXPERIMENTAL_MOTION=1.
# The supported real-robot path is apps/franka (panda-py); see docs/NUC-BRINGUP.md.
EXPERIMENTAL_MOTION = os.environ.get("BRIDGE_EXPERIMENTAL_MOTION", "0") == "1"
VELOCITY_SCALING = min(float(os.environ.get("BRIDGE_VELOCITY_SCALING", "0.1")), 0.3)
TCP_OFFSET_M = float(os.environ.get("BRIDGE_TCP_OFFSET_M", "0.1034"))
BASE_FRAME = os.environ.get("BRIDGE_BASE_FRAME", f"{ARM_ID}_link0")

# The end-effector reference the twin drags to is the gripper tip. In the twin
# model this is 130 mm along the tool +Z axis; MoveIt's Panda tip frame must
# agree. Adjust EE_LINK/LINK_NAME to the target frame in franka_moveit_config.
EE_LINK = os.environ.get("BRIDGE_EE_LINK", "panda_hand")
MOVE_GROUP = os.environ.get("BRIDGE_MOVE_GROUP", "panda_arm")

# TCP/WS listener for the twin. The twin connects to the same origin; the Caddy
# reverse proxy forwards /robot-ws here.
WS_HOST = os.environ.get("BRIDGE_WS_HOST", "127.0.0.1")
WS_PORT = int(os.environ.get("BRIDGE_WS_PORT", "3001"))

# ros2_control controller names. These must match the controllers loaded in the
# ros2_control config (franka_ros2). Defaults follow the franka_moveit_config.
TRAJ_CONTROLLER = os.environ.get("BRIDGE_TRAJ_CONTROLLER", f"{ARM_ID}_arm_controller")
GRIPPER_CONTROLLER = os.environ.get("BRIDGE_GRIPPER_CONTROLLER", f"{ARM_ID}_gripper")

# Topics / actions.
JOINT_STATES_TOPIC = os.environ.get("BRIDGE_JOINT_STATES", "/joint_states")
EMERGENCY_STOP_TOPIC = os.environ.get("BRIDGE_ESTOP_TOPIC", "/robot/emergency_stop")


@dataclass
class Settings:
    ws_host: str = field(default_factory=lambda: WS_HOST)
    ws_port: int = field(default_factory=lambda: WS_PORT)
    ee_link: str = field(default_factory=lambda: EE_LINK)
    move_group: str = field(default_factory=lambda: MOVE_GROUP)
    traj_controller: str = field(default_factory=lambda: TRAJ_CONTROLLER)
    gripper_controller: str = field(default_factory=lambda: GRIPPER_CONTROLLER)
    joint_states_topic: str = field(default_factory=lambda: JOINT_STATES_TOPIC)
    estop_topic: str = field(default_factory=lambda: EMERGENCY_STOP_TOPIC)


def robot_message(robot_name: str = "franka-panda") -> dict:
    """Build the twin's ``robot`` server message (joint names + limits)."""
    return {
        "type": "robot",
        "name": robot_name,
        "joints": [{"name": j.name, "minDeg": j.min_deg, "maxDeg": j.max_deg} for j in PANDA_JOINTS],
    }
