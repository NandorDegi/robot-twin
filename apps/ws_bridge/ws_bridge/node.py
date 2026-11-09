"""ROS 2 WebSocket bridge between the robot-twin UI and MoveIt (OPTIONAL).

Status: OPTIONAL and EXPERIMENTAL. It is not part of the v1 deployment. The
supported real-robot path for the Panda (FER) is apps/franka (panda-py with
libfranka 0.9.2) behind the Node server. The franka_ros2 main line targets the
FR3 and a newer libfranka; a Panda needs an older franka_ros2 release and
libfranka 0.9.x (see docs/NUC-BRINGUP.md, "Optional: ROS 2"). Never run this
stack and the Franka bridge at the same time: only one process may command
the arm (the systemd units conflict).

What it does:
  * mirrors /joint_states (mapped by joint NAME) to the twin protocol;
  * with BRIDGE_EXPERIMENTAL_MOTION=1 only: ``setTarget`` -> MoveIt
    move_group plan+execute, hand pointing down, 5 mm / 0.05 rad tolerance,
    velocity and acceleration scaling 0.1 (capped at 0.3);
  * ``estop`` cancels the MoveIt goal and publishes "stop" on
    /trajectory_execution_event;
  * motion is disabled at start, and when the last client disconnects.

Joint goals, gripper, chess and replay are not implemented here.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, Dict, List, Optional, Set

from . import protocol, config


def twin_to_moveit(pos_mm: List[float]) -> List[float]:
    """Twin point (mm, Y-up, T = RotX(-90) * B) -> robot base frame (m, Z-up)."""
    x, y, z = (float(v) for v in pos_mm)
    return [x / 1000.0, -z / 1000.0, y / 1000.0]


try:
    import rclpy
    from rclpy.node import Node
    from rclpy.action import ActionClient
    from rclpy.executors import MultiThreadedExecutor

    from geometry_msgs.msg import Pose, Point, Quaternion
    from sensor_msgs.msg import JointState
    from std_msgs.msg import String
    from moveit_msgs.action import MoveGroup
    from moveit_msgs.msg import (
        Constraints,
        MotionPlanRequest,
        OrientationConstraint,
        PositionConstraint,
    )
    from shape_msgs.msg import SolidPrimitive

    _ROS_AVAILABLE = True
except ImportError:  # pragma: no cover - ROS is only on the NUC
    _ROS_AVAILABLE = False

_BASE = Node if _ROS_AVAILABLE else object


class BridgeNode(_BASE):
    def __init__(self, settings: config.Settings):
        super().__init__(*(["ws_bridge"] if _ROS_AVAILABLE else []))
        self.settings = settings
        self._clients: Set[Any] = set()
        self._latest_q: List[float] = []
        self._q_stamp = 0.0
        self._gripper_open = False
        self._enabled = False
        self._mode = "hold"
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._goal_handle = None
        self._names = [j.name for j in config.PANDA_JOINTS]

        if _ROS_AVAILABLE:
            self.create_subscription(JointState, settings.joint_states_topic, self._on_joint_states, 10)
            self._move_client = ActionClient(self, MoveGroup, "/move_action")
            self._exec_event_pub = self.create_publisher(String, "/trajectory_execution_event", 10)
            self.get_logger().info(
                f"ws_bridge starting; experimental motion={'ON' if config.EXPERIMENTAL_MOTION else 'OFF'}"
            )

    # ---- joint state (ROS executor thread) ----------------------------------
    def _on_joint_states(self, msg) -> None:
        pos = dict(zip(msg.name, msg.position))
        if all(n in pos for n in self._names):
            self._latest_q = [float(pos[n]) for n in self._names]
            self._q_stamp = time.monotonic()
            if self._loop:
                asyncio.run_coroutine_threadsafe(self._broadcast(), self._loop)

    # ---- websocket server (asyncio thread) ----------------------------------
    async def _send(self, ws, msg: dict) -> None:
        await ws.send(json.dumps(msg))

    async def _ws_handler(self, websocket, _path: str = "") -> None:
        # websockets >= 10.1 calls handler(ws); 9.x (Ubuntu 22.04 apt) calls handler(ws, path).
        self._clients.add(websocket)
        try:
            await self._send(websocket, self._state())
            await self._send(websocket, config.robot_message())
            async for raw in websocket:
                try:
                    msg = protocol.parse_client_message(raw)
                    await self._handle(msg, websocket)
                except NotImplementedError as exc:
                    await self._send(websocket, protocol.error_message(str(exc) or "not implemented on the ROS 2 bridge"))
                except ValueError as exc:
                    await self._send(websocket, protocol.error_message(str(exc)))
        finally:
            self._clients.discard(websocket)
            if not self._clients:
                self._enabled = False
                self._mode = "hold"
                await self._stop_motion()

    def _state(self) -> dict:
        return protocol.state_message(self._latest_q, self._gripper_open, self._enabled, self._mode)

    async def _handle(self, msg: Dict[str, Any], websocket) -> None:
        t = msg["type"]
        if t == "setTarget":
            pos = twin_to_moveit(msg["target"]["position"])
            ok, err = await self._move_to_target(pos)
            await self._send(websocket, protocol.target_message(msg["target"]["position"], ok, 0.0, ok))
            if not ok:
                await self._send(websocket, protocol.error_message(err))
        elif t == "setEnabled":
            self._enabled = msg["enabled"]
            self._mode = "move" if self._enabled else "hold"
            if not self._enabled:
                await self._stop_motion()
            await self._broadcast()
        elif t == "estop":
            self._enabled = False
            self._mode = "estop"
            await self._stop_motion()
            await self._broadcast()
        elif t in ("setJointState", "home", "gripper"):
            raise NotImplementedError(f"{t} is not implemented on the ROS 2 bridge")
        # recordStart/recordStop/resetGame: accepted, nothing to do here.

    async def _broadcast(self) -> None:
        msg = json.dumps(self._state())
        for ws in list(self._clients):
            try:
                await ws.send(msg)
            except Exception:  # noqa: BLE001
                self._clients.discard(ws)

    # ---- MoveIt -------------------------------------------------------------
    async def _ros_future(self, fut):
        """Await an rclpy future from the asyncio loop."""
        loop = asyncio.get_running_loop()
        afut = loop.create_future()

        def done(f):
            loop.call_soon_threadsafe(lambda: afut.done() or afut.set_result(f.result()))

        fut.add_done_callback(done)
        return await afut

    async def _move_to_target(self, pos: List[float]):
        if not config.EXPERIMENTAL_MOTION:
            return False, "motion through the ROS 2 bridge is disabled (BRIDGE_EXPERIMENTAL_MOTION=0)"
        if not self._enabled:
            return False, "disabled"
        if not _ROS_AVAILABLE:
            return False, "ROS not available"
        if time.monotonic() - self._q_stamp > 0.5:
            return False, "no fresh /joint_states; refusing to plan"
        if not self._move_client.wait_for_server(timeout_sec=2.0):
            return False, "move_group action server not available"
        goal = MoveGroup.Goal()
        goal.request = _pose_request(self.settings, pos)
        goal.planning_options.plan_only = False
        goal.planning_options.planning_scene_diff.is_diff = True
        goal.planning_options.planning_scene_diff.robot_state.is_diff = True
        handle = await self._ros_future(self._move_client.send_goal_async(goal))
        if not handle.accepted:
            return False, "MoveIt rejected the goal"
        self._goal_handle = handle
        result = await self._ros_future(handle.get_result_async())
        self._goal_handle = None
        code = result.result.error_code.val
        return (code == 1), ("" if code == 1 else f"MoveIt error code {code}")

    async def _stop_motion(self) -> None:
        if not _ROS_AVAILABLE:
            return
        msg = String()
        msg.data = "stop"
        self._exec_event_pub.publish(msg)
        if self._goal_handle is not None:
            try:
                await self._ros_future(self._goal_handle.cancel_goal_async())
            except Exception:  # noqa: BLE001
                pass

    # ---- lifecycle -----------------------------------------------------------
    async def _serve(self) -> None:
        import websockets

        major, minor = (int(x) for x in websockets.__version__.split(".")[:2])
        if (major, minor) < (10, 4):
            raise SystemExit(
                f"websockets {websockets.__version__} is too old (Ubuntu 22.04 apt ships a broken 9.1); "
                "pip install 'websockets>=10.4,<14'"
            )

        async with websockets.serve(self._ws_handler, self.settings.ws_host, self.settings.ws_port):
            self.get_logger().info(f"ws_bridge serving on ws://{self.settings.ws_host}:{self.settings.ws_port}")
            await asyncio.Future()

    def run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._serve())


def _pose_request(settings: "config.Settings", pos: List[float]):
    """Pose goal for the hand link: TCP at pos, hand pointing straight down."""
    req = MotionPlanRequest()
    req.group_name = settings.move_group
    req.num_planning_attempts = 5
    req.allowed_planning_time = 5.0
    req.max_velocity_scaling_factor = config.VELOCITY_SCALING
    req.max_acceleration_scaling_factor = config.VELOCITY_SCALING
    req.start_state.is_diff = True
    # The goal link is the hand (panda_hand); its origin is TCP_OFFSET_M above
    # the TCP when the hand points down.
    target = Point(x=pos[0], y=pos[1], z=pos[2] + config.TCP_OFFSET_M)
    pc = PositionConstraint()
    pc.header.frame_id = config.BASE_FRAME
    pc.link_name = settings.ee_link
    sphere = SolidPrimitive(type=SolidPrimitive.SPHERE, dimensions=[0.005])
    pc.constraint_region.primitives = [sphere]
    pc.constraint_region.primitive_poses = [Pose(position=target, orientation=Quaternion(w=1.0))]
    pc.weight = 1.0
    oc = OrientationConstraint()
    oc.header.frame_id = config.BASE_FRAME
    oc.link_name = settings.ee_link
    oc.orientation = Quaternion(x=1.0, y=0.0, z=0.0, w=0.0)  # RotX(180): z down
    oc.absolute_x_axis_tolerance = 0.05
    oc.absolute_y_axis_tolerance = 0.05
    oc.absolute_z_axis_tolerance = 3.15  # yaw free
    oc.weight = 1.0
    req.goal_constraints = [Constraints(position_constraints=[pc], orientation_constraints=[oc])]
    return req


def main():
    rclpy.init()
    node = BridgeNode(config.Settings())
    executor = MultiThreadedExecutor()
    executor.add_node(node)
    spin = threading.Thread(target=executor.spin, daemon=True)
    spin.start()
    try:
        node.run()
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
