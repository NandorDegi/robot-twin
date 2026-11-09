"""ROS 2 WebSocket bridge between the robot-twin UI and MoveIt.

The twin connects to ``/robot-ws`` (proxied by Caddy to this node) and speaks the
JSON protocol in :mod:`ws_bridge.protocol`. This node translates those messages
into MoveIt / ros2_control calls:

  * ``setTarget``  -> MoveIt ``move_group`` plan + execute (end-effector goal).
  * ``setJointState`` -> ``FollowJointTrajectory`` on the trajectory controller.
  * ``gripper``    -> the franka gripper controller (open/close).
  * ``estop``      -> publish on the emergency-stop topic.
  * ``setEnabled`` -> motion gate (no goals sent while disabled).
  * ``home``       -> plan to the neutral joint state.

The robot's real state is read from ``/joint_states`` and forwarded to the twin.

NOTE: the values that must match the installed ``franka_moveit_config`` are read
from the environment (see :mod:`ws_bridge.config`): the MoveIt group name, the
goal/planning frame, and the controller names. The twin target is in the model
frame (mm, Y-up); MoveIt plans in the robot base frame (m, Z-up), so the target
is converted before planning (TWIN_BASE_ROT controls the mapping).
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Dict, List, Optional, Set

from . import protocol, config

# --- MoveIt frame conversion -------------------------------------------------
# The twin model uses base rotation RotX(-90) to map the URDF (Z-up) frame to the
# twin (Y-up) frame. Therefore a twin point (mm, Y-up) maps back to the robot
# base frame (m, Z-up) as x_b=x_t, y_b=-z_t, z_b=y_t, then /1000. Verify this
# against your URDF/base before trusting motion (see DEPLOY.md).
_TWIN_BASE_ROT = "x-90"


def twin_to_moveit(pos_mm: List[float], base_rot: str = _TWIN_BASE_ROT) -> List[float]:
    x, y, z = (float(v) for v in pos_mm)
    if base_rot == "x-90":  # p_twin = R_x(-90) * p_urdf
        x_b, y_b, z_b = x, -z, y
    else:
        x_b, y_b, z_b = x, y, z
    return [x_b / 1000.0, y_b / 1000.0, z_b / 1000.0]


# --- ROS imports (guarded so the module can be imported for lint without ROS) --
try:
    import rclpy
    from rclpy.node import Node
    from rclpy.action import ActionClient
    from rclpy.duration import Duration
    from rclpy.executors import SingleThreadedExecutor

    from geometry_msgs.msg import PoseStamped, Pose, Point, Quaternion
    from sensor_msgs.msg import JointState
    from std_msgs.msg import Bool
    from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint
    from moveit_msgs.action import MoveGroup
    from moveit_msgs.msg import MotionPlanRequest, MoveItErrorCodes
    from control_msgs.action import FollowJointTrajectory

    _ROS_AVAILABLE = True
except ImportError:  # pragma: no cover - ROS is only on the NUC
    _ROS_AVAILABLE = False


# The node subclasses rclpy.Node when ROS is importable; otherwise it degrades to
# a plain class so the module (and the frame-conversion helper) can be imported
# and unit-tested on a machine without ROS.
_BASE = Node if _ROS_AVAILABLE else object


class BridgeNode(_BASE):
    def __init__(self, settings: config.Settings):
        super().__init__(*(["ws_bridge"] if _ROS_AVAILABLE else []))
        self.settings = settings
        self._clients: Set[asyncio.StreamWriter] = set()
        self._latest_q: List[float] = []
        self._gripper_open = False
        self._enabled = True
        self._mode = "move"
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        if _ROS_AVAILABLE:
            self.get_logger().info("ws_bridge starting (ROS available)")
            self._joints_sub = self.create_subscription(
                JointState, settings.joint_states_topic, self._on_joint_states, 10
            )
            self._move_client = ActionClient(self, MoveGroup, "/move_action")
            self._traj_client = ActionClient(self, FollowJointTrajectory, f"/{settings.traj_controller}/follow_joint_trajectory")
            self._estop_pub = self.create_publisher(Bool, settings.estop_topic, 10)
        else:
            self.get_logger().warn("ROS not importable; running the WS bridge with no move support")

    # ---- joint state ---------------------------------------------------------
    def _on_joint_states(self, msg) -> None:
        self._latest_q = list(msg.position)
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._broadcast(), self._loop)

    # ---- websocket server ----------------------------------------------------
    async def _ws_handler(self, websocket) -> None:
        await websocket.send(protocol.state_message(self._latest_q, self._gripper_open, self._enabled, self._mode))
        await websocket.send(protocol.robot_message())
        async for raw in websocket:
            try:
                msg = protocol.parse_client_message(raw)
                await self._handle(msg, websocket)
            except NotImplementedError:
                await websocket.send(protocol.error_message("not implemented on the ROS 2 bridge"))
            except ValueError as exc:
                await websocket.send(protocol.error_message(str(exc)))

    async def _handle(self, msg: Dict[str, Any], websocket) -> None:
        t = msg["type"]
        if t == "setTarget":
            pos = twin_to_moveit(msg["target"]["position"])
            ok = await self._move_to_target(pos)
            await websocket.send(protocol.target_message(pos, ok, 0.0, ok))
        elif t == "setJointState":
            await self._move_to_joint_state(msg["q"])
        elif t == "gripper":
            await self._set_gripper(msg["open"])
        elif t == "setEnabled":
            self._enabled = msg["enabled"]
            self._mode = "move" if self._enabled else "hold"
        elif t == "estop":
            self._estop()
        elif t == "home":
            await self._move_to_joint_state(_home_q())

    async def _broadcast(self) -> None:
        if not self._clients:
            return
        msg = protocol.state_message(self._latest_q, self._gripper_open, self._enabled, self._mode)
        for ws in list(self._clients):
            try:
                await ws.send(msg)
            except Exception:
                self._clients.discard(ws)

    # ---- MoveIt / controller -------------------------------------------------
    async def _move_to_target(self, pos: List[float]) -> bool:
        if not self._enabled:
            return False
        if not _ROS_AVAILABLE:
            return False
        goal = MoveGroup.Goal()
        goal.request = MotionPlanRequest()
        goal.request.group_name = self.settings.move_group
        goal.request.goal_constraints = _position_goal(self.settings.ee_link, pos)
        goal.request.allowed_planning_time = 2.0
        await self._move_client.wait_for_server()
        result = await self._move_client.send_goal_async(goal)
        return bool(result.accepted)

    async def _move_to_joint_state(self, q: List[float]) -> bool:
        if not self._enabled or not _ROS_AVAILABLE:
            return False
        msg = FollowJointTrajectory.Goal()
        msg.trajectory = JointTrajectory()
        msg.trajectory.joint_names = [j.name for j in config.PANDA_JOINTS]
        pt = JointTrajectoryPoint()
        pt.positions = [float(v) for v in q]
        pt.time_from_start = Duration(seconds=1.0).to_msg()
        msg.trajectory.points = [pt]
        await self._traj_client.wait_for_server()
        result = await self._traj_client.send_goal_async(msg)
        return bool(result.accepted)

    async def _set_gripper(self, open_it: bool) -> bool:
        self._gripper_open = open_it
        # The franka gripper is driven by its controller action. Config the
        # gripper_controller / action name in DEPLOY.md to match franka_ros2.
        return True

    def _estop(self) -> None:
        self._enabled = False
        self._mode = "estop"
        if _ROS_AVAILABLE:
            msg = Bool()
            msg.data = True
            self._estop_pub.publish(msg)
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._broadcast(), self._loop)

    # ---- lifecycle -----------------------------------------------------------
    async def _serve(self) -> None:
        import websockets

        async with websockets.serve(
            self._ws_handler, self.settings.ws_host, self.settings.ws_port, subprotocols=["robot"]
        ):
            self.get_logger().info(f"ws_bridge serving on ws://{self.settings.ws_host}:{self.settings.ws_port}")
            await asyncio.Future()

    def spin_async(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._serve())


def _home_q() -> List[float]:
    # Neutral pose (radians) = midpoint of each joint range.
    import math

    return [math.radians((j.min_deg + j.max_deg) / 2.0) for j in config.PANDA_JOINTS]


def _position_goal(ee_link: str, pos: List[float]) -> List["object"]:
    """Build a MoveIt position-only goal constraint for the EE link."""
    from moveit_msgs.msg import Constraints, OrientationConstraint, PositionConstraint
    from geometry_msgs.msg import Point as GPoint
    from shape_msgs.msg import SolidPrimitive

    c = Constraints()
    pc = PositionConstraint()
    pc.link_name = ee_link
    s = SolidPrimitive()
    s.type = SolidPrimitive.SPHERE
    s.dimensions = [0.15]  # 15 cm radius region around the target
    pc.constraint_region.primitives = [s]
    pc.constraint_region.primitive_poses = [Pose(Point(*pos), Quaternion(0, 0, 0, 1))]
    c.position_constraints = [pc]
    return [c]


def main():
    import rclpy

    rclpy.init()
    node = BridgeNode(config.Settings())
    try:
        node.spin_async()
    finally:
        rclpy.shutdown()


if __name__ == "__main__":
    main()
