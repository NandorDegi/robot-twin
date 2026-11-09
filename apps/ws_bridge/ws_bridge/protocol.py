"""Twin WebSocket protocol (encoding / validation), in plain Python.

The bridge must speak the same JSON protocol as the Node server that the twin
already talks to (``@robot/protocol`` in the monorepo). This module is
dependency-free so it can be unit-tested on any host without ROS. The twin moves
the arm with ``setTarget`` and reads ``state`` / ``robot`` messages.

Server messages:
    {type:"state", q:[...], gripperOpen:bool, enabled:bool, mode:str}
    {type:"robot", name:str, joints:[{name,minDeg,maxDeg}]}
    {type:"target", position:[x,y,z], reached:bool, error:number, success:bool}
    {type:"error", message:str}

Client messages (the ones this bridge acts on):
    {type:"setTarget", target:{position:[x,y,z], orientation?:[..]}}
    {type:"setJointState", q:[...]}
    {type:"gripper", open:bool}
    {type:"setEnabled", enabled:bool}
    {type:"estop"}
    {type:"home"}
    {type:"replay", steps:[...]}
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple


def _vec3(v: Any) -> List[float]:
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        raise ValueError("expected a [x,y,z] vector")
    if not all(isinstance(x, (int, float)) for x in v):
        raise ValueError("vector values must be numbers")
    return [float(x) for x in v]


def _bool(v: Any) -> bool:
    if not isinstance(v, bool):
        raise ValueError("expected a boolean")
    return v


def _joint_state(v: Any) -> List[float]:
    if not isinstance(v, (list, tuple)) or not v:
        raise ValueError("expected a non-empty joint state array")
    if not all(isinstance(x, (int, float)) for x in v):
        raise ValueError("joint values must be numbers")
    return [float(x) for x in v]


def parse_client_message(text: str) -> Dict[str, Any]:
    """Parse and validate one client message. Raises ValueError on bad input."""
    import json

    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc

    if not isinstance(raw, dict) or not isinstance(raw.get("type"), str):
        raise ValueError("message must be an object with a 'type' string")

    t = raw["type"]

    if t == "setTarget":
        target = raw.get("target")
        if not isinstance(target, dict) or "position" not in target:
            raise ValueError("setTarget needs target.position")
        out: Dict[str, Any] = {"type": t, "target": {"position": _vec3(target["position"])}}
        if target.get("orientation") is not None:
            out["target"]["orientation"] = _vec3(target["orientation"])
        return out

    if t == "setJointState":
        return {"type": t, "q": _joint_state(raw.get("q"))}

    if t == "gripper":
        return {"type": t, "open": _bool(raw.get("open"))}

    if t == "setEnabled":
        return {"type": t, "enabled": _bool(raw.get("enabled"))}

    if t in ("estop", "home", "recordStart", "recordStop", "resetGame"):
        return {"type": t}

    # Chess / record playback need extra state on the bridge; reject with a clear
    # message rather than silently accepting a message the bridge cannot honor.
    if t in ("playSan", "setOpponent", "replay", "recordStep"):
        raise NotImplementedError(f"{t} is not implemented on the ROS 2 bridge yet")

    raise ValueError(f"unknown message type: {t}")


def state_message(q: List[float], gripper_open: bool = False, enabled: bool = True, mode: str = "move") -> dict:
    return {"type": "state", "q": [float(x) for x in q], "gripperOpen": bool(gripper_open),
            "enabled": bool(enabled), "mode": mode}


def target_message(position: Tuple[float, float, float], reached: bool, error: float, success: bool) -> dict:
    return {"type": "target", "position": [float(p) for p in position], "reached": bool(reached),
            "error": float(error), "success": bool(success)}


def error_message(message: str) -> dict:
    return {"type": "error", "message": message}
