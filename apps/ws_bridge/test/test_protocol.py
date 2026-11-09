"""Unit tests for the twin WebSocket protocol layer.

These run without ROS, so they exercise the encoding/validation and the frame
conversion. Run with: pytest (from apps/ws_bridge).
"""

import json

from ws_bridge import protocol, config
from ws_bridge.node import twin_to_moveit


def test_parse_settarget():
    msg = protocol.parse_client_message(json.dumps({"type": "setTarget", "target": {"position": [1, 2, 3]}}))
    assert msg == {"type": "setTarget", "target": {"position": [1.0, 2.0, 3.0]}}


def test_parse_settarget_with_orientation():
    msg = protocol.parse_client_message(
        json.dumps({"type": "setTarget", "target": {"position": [0, 0, 0], "orientation": [1, 0, 0]}})
    )
    assert msg["target"]["orientation"] == [1.0, 0.0, 0.0]


def test_parse_gripper():
    assert protocol.parse_client_message(json.dumps({"type": "gripper", "open": True})) == {"type": "gripper", "open": True}


def test_parse_rejects_bad_json():
    try:
        protocol.parse_client_message("not json")
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_parse_rejects_unknown_type():
    try:
        protocol.parse_client_message(json.dumps({"type": "nope"}))
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_chess_not_implemented():
    try:
        protocol.parse_client_message(json.dumps({"type": "playSan", "san": "e4"}))
    except NotImplementedError:
        return
    raise AssertionError("expected NotImplementedError")


def test_state_message_shape():
    s = protocol.state_message([0.1, 0.2], gripper_open=True, enabled=False, mode="hold")
    assert s["type"] == "state"
    assert s["q"] == [0.1, 0.2]
    assert s["gripperOpen"] is True
    assert s["enabled"] is False


def test_robot_message_has_seven_panda_joints():
    r = config.robot_message()
    assert r["name"] == "franka-panda"
    assert len(r["joints"]) == 7
    assert r["joints"][3]["name"] == "panda_joint4"
    assert r["joints"][5]["maxDeg"] == 215.0  # Panda (FER), not FR3


def test_twin_to_moveit_x90_mapping():
    # twin (mm, Y-up) -> robot base (m, Z-up): x_b=x_t, y_b=-z_t, z_b=y_t.
    assert twin_to_moveit([100.0, 200.0, 300.0]) == [0.1, -0.3, 0.2]


def test_settings_defaults():
    s = config.Settings()
    assert s.ws_port == 3001
    assert s.move_group == "panda_arm"


def test_bridge_sends_json_and_disables_on_last_disconnect():
    import asyncio

    from ws_bridge import node as node_mod
    from ws_bridge.node import BridgeNode

    if node_mod._ROS_AVAILABLE:
        import rclpy

        rclpy.init()

    class FakeWs:
        def __init__(self, incoming):
            self.sent = []
            self._in = list(incoming)

        async def send(self, data):
            assert isinstance(data, str)  # websockets needs str/bytes, not dict
            self.sent.append(json.loads(data))

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._in:
                raise StopAsyncIteration
            return self._in.pop(0)

    node = BridgeNode(config.Settings())
    assert node._enabled is False  # motion disabled at start
    ws = FakeWs([json.dumps({"type": "setEnabled", "enabled": True}),
                 json.dumps({"type": "setTarget", "target": {"position": [400, 200, 0]}}),
                 json.dumps({"type": "setJointState", "q": [0] * 7})])
    asyncio.run(node._ws_handler(ws))
    types = [m["type"] for m in ws.sent]
    assert types[0] == "state" and types[1] == "robot"
    target = [m for m in ws.sent if m["type"] == "target"][0]
    assert target["success"] is False  # experimental motion is off by default
    assert any(m["type"] == "error" and "not implemented" in m["message"] for m in ws.sent)
    assert node._enabled is False  # last client gone -> disabled
    if node_mod._ROS_AVAILABLE:
        node.destroy_node()
        rclpy.shutdown()
