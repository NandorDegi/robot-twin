"""Read-only FCI check for bring-up. It never commands a motion.

    sudo -u robot-twin /opt/robot-twin/franka-venv/bin/python -I fci_check.py 172.16.0.2

Connects with panda-py (libfranka 0.9.2, real-time enforced), reads the robot
state 100 times and prints the joint angles, the robot mode, the active errors,
and the gripper width. Stop robot-franka.service first: FCI accepts one client.
"""

import math
import sys
import time


def main() -> int:
    host = sys.argv[1] if len(sys.argv) > 1 else "172.16.0.2"
    import panda_py
    from panda_py import libfranka

    t0 = time.monotonic()
    panda = panda_py.Panda(host, realtime_config=libfranka.RealtimeConfig.kEnforce)
    print(f"connected to {host} in {time.monotonic() - t0:.2f} s")
    last = None
    t0 = time.monotonic()
    for _ in range(100):
        last = panda.get_state()
        time.sleep(0.01)
    dt = time.monotonic() - t0
    print("q (deg):", [round(math.degrees(v), 1) for v in last.q])
    # O_T_EE is column-major 4x4; the translation is elements 12..14 (m).
    # It is the TCP set in Desk (Franka Hand: 0.1034 m below the flange).
    t = last.O_T_EE
    print(f"TCP in the base frame (mm): X={t[12] * 1000:.1f} Y={t[13] * 1000:.1f} Z={t[14] * 1000:.1f}")
    f = last.F_T_EE
    print(f"F_T_EE z offset (mm, expect 103.4 for the Franka Hand): {f[14] * 1000:.1f}")
    print("robot_mode:", last.robot_mode)
    print("current_errors:", last.current_errors)
    print(f"100 state reads in {dt:.2f} s")
    try:
        g = libfranka.Gripper(host)
        print(f"gripper width: {g.read_once().width * 1000:.1f} mm")
    except Exception as exc:  # noqa: BLE001
        print(f"gripper: not available ({exc})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
