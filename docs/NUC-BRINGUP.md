# NUC bring-up: from the bundle to a chess move with the real Panda

This runbook is for the operator. It installs robot-twin on the Intel NUC
(x86_64, Ubuntu 22.04), connects the Franka Emika Panda (FER), and goes step
by step from simulation to a real chess move. Do the steps in order. Each step
has an expected result and what to do when it fails.

> **Safety rules for every step with the real robot**
> - Keep the **user stop** (external activation device) in your hand. It is
>   the safety function. The E-Stop button in the twin is only a software stop.
> - Keep people out of the robot's reach. Clear the table except for the board.
> - Start with `FRANKA_SPEED_FACTOR=0.05`. Increase only after a full test.
> - If anything is unexpected: press the user stop first, then investigate.

---

## 0. What the system is

```
Browser (twin UI) --https/ws--> Caddy :5909 (LAN, IP allowlist)
                                  |-- /            static twin (Three.js)
                                  |-- /robot-ws -> robot-server :3001 (Node, 127.0.0.1)
                                  `-- /vision/* -> robot-vision :8081 (Python, 127.0.0.1)

robot-server: controller (IK, limits, collision and floor check), chess loop
      |  HTTP 127.0.0.1:3002, one lease + heartbeat
      v
robot-franka: Franka bridge (panda-py 1.1.1 = libfranka 0.9.2), the ONLY
      process that commands the arm; validates every goal again
      |  FCI, dedicated NIC, 1 kHz, PREEMPT_RT
      v
Panda control unit (shop-floor port)  ->  arm + Franka Hand

robot-vision: overhead USB camera -> board homography (ArUco) -> /board
```

**Only one process may command the arm.** That is enforced in four ways: FCI
accepts one client; the bridge holds a lock file (a second bridge exits); the
bridge listens on 127.0.0.1 only; and a command needs the single lease, which
the robot server keeps alive with a heartbeat (no heartbeat for 1 s: the
bridge stops the arm). `robot-ros.service` (optional ROS 2) conflicts with
`robot-franka.service`, so systemd never runs both.

### The closed loop the system supports

```
camera --> board state --> decision --> pick/place --> camera verifies
  ^        (occupancy        (pluggable    (validated       |
  |         per square,       decider)      motions)        |
  |         -> FEN from the                                 |
  |         tracked game)                                   |
  `------------- mismatch: STOP, name the squares <---------'
```

1. **Observe.** The arm moves to the observe pose (out of the camera view).
   `GET /vision/board` gives, per square, empty / white / black. The server
   compares it with the tracked game (FEN). If the human made one legal move,
   the server finds it (also castling and en passant) and applies it.
2. **Decide.** A `MoveDecider` proposes the robot's move. Default: the local
   chess engine. Plug-in: set `CHESS_DECIDER_URL` to any HTTP service (an LLM
   agent, a learned policy, a UCI engine wrapper) that answers
   `POST {"fen", "legal": [uci...], "side"}` with `{"uci": "e7e5"}` (or
   `{"san": ...}`). The answer is data: only a legal move is accepted, and the
   decider never commands the arm. Interface: `apps/server/src/decider.ts`.
   The learning part is not implemented.
3. **Act.** For each pick and place: approach 100 mm above, descend with the
   hand pointing down, grasp or release, lift. Captures go to the tray.
   Every motion is checked (limits, self-collision, floor, the straight
   joint path) by the server and again by the bridge.
4. **Verify.** Back in the observe pose, the camera board must equal the
   expected position. If it does not, the loop stops in **fault**, the robot
   is disabled, and the twin shows the squares that differ. Nothing continues
   until you fix the board and press **Clear fault**.

The same check runs **before** each robot move: the arm does not touch a
board that does not match the game.

---

## 1. What you must look up or decide on site

| Item | Where | Why |
|---|---|---|
| **Robot system image version** | Desk -> Settings -> System -> Version | panda-py 1.1.1 bundles **libfranka 0.9.2**, which needs a Panda system image **4.2.x** (>= 4.2.1). With 4.0.x/4.1.x or 3.x, see step 5.1. |
| FCI feature installed | Desk -> Settings -> System -> Installed features | Without FCI there is no external control. Needs an FCI license (Franka World). |
| End effector in Desk | Desk -> Settings -> End effector | Must be "Franka Hand" so that the TCP (F_T_EE) is 103.4 mm. |
| Control unit IP | Desk -> Settings -> Network (shop floor) | `FRANKA_HOST`. Static. Example 172.16.0.2/24. |
| NUC FCI NIC name | `ip -br link` on the NUC | `FCI_NIC`. The NIC that does NOT carry the LAN. |
| NUC FCI address | your choice, same /24 | `FCI_HOST_CIDR`, e.g. 172.16.0.1/24. |
| Operator network | your LAN | `TWIN_ALLOWED_CIDRS` in `/etc/robot-twin/caddy.env`. |
| Camera index | `v4l2-ctl --list-devices` | `VISION_CAMERA_INDEX`. |
| Board position | measured in step 10 | `packages/chess/src/board.ts` and `VISION_BOARD_*`. |
| Observe pose | step 12 | `CHESS_OBSERVE_POSE`, a pose that does not hide the board. |
| Ubuntu Pro token | ubuntu.com/pro (free personal tier) | For the real-time kernel. It is a secret: type it only into `pro attach`, never into a file. |

All configuration is in `/etc/robot-twin/robot-twin.env` (template:
`deploy/robot-twin.env.template`). It holds no secrets.

---

## 2. Real-time kernel

libfranka needs a PREEMPT_RT kernel for the 1 kHz FCI loop.

**Recommended: the Ubuntu Pro real-time kernel** (maintained, signed, works
with Secure Boot).

```bash
sudo apt update && sudo apt install -y ubuntu-advantage-tools
sudo pro attach                 # magic attach: shows a code for ubuntu.com/pro/attach
sudo pro enable realtime-kernel # answer "y"; installs linux-realtime (5.15 on 22.04)
sudo reboot
```

Expected after the reboot:

```bash
uname -a                     # ... SMP PREEMPT_RT ...
cat /sys/kernel/realtime     # 1
```

If GRUB still boots the generic kernel: `sudo grub-reboot` with the realtime
entry, or set it as default in `/etc/default/grub` and run `sudo update-grub`.

**Alternative (no Ubuntu Pro): build the PREEMPT_RT patch** as in the Franka
documentation ("Setting up the real-time kernel"): download a 5.15.x kernel
and the matching `patch-5.15.x-rtNN`, `patch -p1`, `make olddefconfig`,
select "Fully Preemptible Kernel (Real-Time)" in `make menuconfig`, disable
`CONFIG_DEBUG_INFO` and the trusted/revocation keys, `make -j$(nproc) deb-pkg`,
`sudo dpkg -i ../linux-*.deb`, reboot. With Secure Boot on you must sign the
kernel or turn Secure Boot off.

**BIOS of the NUC** (reduces latency): turn off deep C-states (C6 and lower)
and "Intel SpeedStep" power saving if the latency test below is bad.

**Latency test** (after `install.sh`, which installs `rt-tests`):

```bash
sudo cyclictest --mlockall --smp --priority=80 --interval=200 --distance=0 --duration=5m -q
```

Expected: the **Max** column under 100 us on every CPU (good NUCs: 20-60 us).
Over 200 us: check the BIOS settings, the CPU governor (`performance`), and
that no other heavy load runs (browser with the twin on the NUC itself, video).

---

## 3. Copy and unpack the bundle

On the dev machine (spark1) the bundle is
`~/robot-twin/dist/robot-twin-nuc-<date>.tar.gz` with a `.sha256` file.

```bash
scp robot-twin-nuc-<date>.tar.gz robot-twin-nuc-<date>.tar.gz.sha256 <user>@<nuc>:~
ssh <user>@<nuc>
sha256sum -c robot-twin-nuc-<date>.tar.gz.sha256     # OK
tar -xzf robot-twin-nuc-<date>.tar.gz                 # creates ./robot-twin
```

The bundle has source, lockfiles and `deploy/`. It has no `node_modules` or
build output: `install.sh` builds on the NUC (needs internet for apt,
nodejs.org, the npm registry and PyPI).

---

## 4. Install

```bash
cd ~/robot-twin
sudo bash deploy/install.sh --with-libfranka-examples
```

Expected: nine `[install] n/9` steps and `Done. Nothing was started.` The
script stops with `ERROR:` at the first problem; it never continues silently.
It is safe to run again.

| Failure | Action |
|---|---|
| `Ubuntu 22.04 expected` / `x86_64` | Wrong machine or OS. |
| Node.js checksum mismatch | Network proxy changes downloads. Retry; check the proxy. |
| `pnpm install` fails | Needs the npm registry. Check DNS/proxy. |
| `panda-py does not import` | `/opt/robot-twin/franka-venv/bin/pip install panda-python==1.1.1` and read the error. Needs Python 3.10 x86_64. |
| libfranka examples do not build | Optional. Read the cmake error; `libpoco-dev`, `libeigen3-dev` must be installed. Use `fci_check.py` instead (step 6). |

Then edit the configuration:

```bash
sudo nano /etc/robot-twin/robot-twin.env      # FRANKA_HOST, FCI_NIC, FCI_HOST_CIDR, VISION_CAMERA_INDEX
sudo nano /etc/robot-twin/caddy.env           # TWIN_ALLOWED_CIDRS = your operator network
```

Keep `FRANKA_DRY_RUN=1` for now.

---

## 5. Robot and network

1. Wire the FCI NIC of the NUC to the **Control unit's shop-floor port**
   (the "LAN" port on the control box), **not** the port on the arm base.
   Use a direct cable, no switch.
2. In Desk, give the control unit its static IP (`FRANKA_HOST`).
3. Configure the NUC NIC:

   ```bash
   sudo bash /opt/robot-twin/app/deploy/setup-fci-network.sh
   ```

   Expected: `<nic> UP 172.16.0.1/24`, `MTU: 1500`, and the NIC is
   `unmanaged` in `nmcli device`. The script refuses the NIC that has the
   default route.
4. Run the preflight:

   ```bash
   sudo bash /opt/robot-twin/app/deploy/preflight.sh
   ```

   Expected: all `PASS` (the robot-franka lines need step 4 done). Key lines:
   `PREEMPT_RT kernel`, `CPU governor: performance`
   (`sudo systemctl start robot-cpu-performance` if not),
   `LimitRTPRIO=99 LimitMEMLOCK=infinity`, `route ... via <nic>`,
   `ping: 0% loss`, `max rtt < 1 ms`.

   | FAIL | Action |
   |---|---|
   | link is down | Cable, port (shop-floor port on the control unit), robot powered. |
   | ping loss | IP/netmask on both sides; another device with the same IP. |
   | max rtt >= 1 ms | Switch or USB NIC in the path, power saving on the NIC (`ethtool --show-eee <nic>`), no RT kernel. |
   | NetworkManager manages the NIC | Run `setup-fci-network.sh` again; `sudo systemctl restart NetworkManager`. |

5. In Desk: unlock the joints (brakes), then **Activate FCI**.

### 5.1 If the robot system image is not 4.2.x

libfranka 0.9.2 talks to Panda system images >= 4.2.1 (robot server version
5). With an older image, `fci_check.py` fails with an "incompatible library
version" error. Options, best first:

- Update the robot system image to the latest 4.2.x in Desk (needs the image
  from Franka World). Do not install an FR3 image (5.x) on a Panda.
- Build panda-py from source against the libfranka version that matches the
  image (Franka compatibility table: 4.0.x -> libfranka 0.8.x; 3.x -> 0.6/0.7).
  Then pin that build in `/etc/robot-twin/franka-constraints.txt`.

---

## 6. FCI communication test (read-only first)

Stop the bridge first: FCI accepts only one client.

```bash
sudo systemctl stop robot-franka robot-server
cd /opt/robot-twin/app/apps/franka
sudo -u robot-twin /opt/robot-twin/franka-venv/bin/python -I fci_check.py $FRANKA_HOST
```

Expected (read-only, the arm does not move):

```
connected to 172.16.0.2 in 0.xx s
q (deg): [ ... 7 values ... ]
TCP in the base frame (mm): X=... Y=... Z=...
F_T_EE z offset (mm, expect 103.4 for the Franka Hand): 103.4
robot_mode: RobotMode.kIdle
current_errors: (all False)
gripper width: ... mm
```

With the libfranka examples (`--with-libfranka-examples`):

```bash
L=/opt/robot-twin/libfranka-0.9.2/build/examples
sudo -u robot-twin $L/echo_robot_state $FRANKA_HOST      # read-only, prints robot states
```

`communication_test` runs a short **zero-motion control loop**. It prints a
warning that the robot may move; keep the user stop in your hand and press
Enter. Expected: a success rate close to 1.0 (well above 0.95) and no
`communication_constraints_violation`.

```bash
sudo -u robot-twin $L/communication_test $FRANKA_HOST
```

| Failure | Action |
|---|---|
| `Connection refused` / timeout | FCI not activated in Desk; wrong IP; wrong port on the control unit. |
| `incompatible library version` | Step 5.1 (system image vs libfranka 0.9.2). |
| `unable to set realtime scheduling` | Not a PREEMPT_RT kernel, or the user is not in group `realtime` (log in again). |
| success rate low / `communication_constraints_violation` | Latency: cyclictest, BIOS C-states, governor, NIC power saving, no switch. |
| `the robot is already in use` | Another client is connected (robot-franka, robot-ros, a notebook). |

---

## 7. First run in simulation (dry-run)

`FRANKA_DRY_RUN=1` (default): the bridge simulates the arm with the same
validation and timing. The real robot is not contacted.

```bash
sudo systemctl start robot-franka robot-vision robot-server caddy
systemctl status robot-franka robot-vision robot-server caddy --no-pager
journalctl -u robot-franka -n 5    # backend=dry-run dry_run=True ... listening on http://127.0.0.1:3002
journalctl -u robot-server -n 5    # using FrankaAdapter ... listening on ws://127.0.0.1:3001
```

Open `http://<nuc-lan-ip>:5909` from a computer in `TWIN_ALLOWED_CIDRS`.

Check, in this order:

1. Status shows `connected · real · disabled`. The arm does not move.
2. Press **Home**: refused ("disabled").
3. Press **Enable**, then **Home**: the arm goes to the ready pose.
4. Move one joint slider and release it: one motion.
5. Type `e4`, **Play**: approach, descend, close, lift, move, place, observe
   pose. The loop line says `e4 done` (or a vision fault if the camera is not
   calibrated yet: then set `CHESS_REQUIRE_VISION=0` only for this dry-run).
6. Press **E-Stop** during a motion: the motion stops, the robot is disabled.
7. Close the browser tab during a motion: the server log says
   `last client disconnected: stopping and disabling the robot`.
8. `sudo systemctl kill -s SIGKILL robot-server` during a motion: the bridge
   log says `lease of robot-server ... expired` and `STOP` within about 1 s.

Each item must behave as described before you continue.

---

## 8. Real robot, low speed

```bash
sudo systemctl stop robot-server robot-franka
sudo sed -i 's/^FRANKA_DRY_RUN=.*/FRANKA_DRY_RUN=0/; s/^FRANKA_SPEED_FACTOR=.*/FRANKA_SPEED_FACTOR=0.05/' /etc/robot-twin/robot-twin.env
sudo systemctl start robot-franka && journalctl -u robot-franka -n 5   # backend=panda-py dry_run=False
sudo systemctl start robot-server
```

Desk: joints unlocked, FCI active. Release the user stop: the base lights go
**blue** (ready). With the user stop pressed they are **white** and the
robot does not move.

1. The twin mirrors the real pose. Move the arm by hand-guiding in Desk is not
   possible while FCI is active; compare the twin with the real arm instead.
2. **Enable**. Move joint 7 by +10 deg with the slider: the arm turns its
   wrist slowly. Joint 7 back.
3. **Home** (ready pose). Watch the whole path; user stop in hand.
4. During a move, press **E-Stop** in the twin: the arm stops; robot disabled.
5. During a move, press the **user stop**: the arm stops (reflex). The twin
   shows `fault: ...`. Release the user stop, then recover:

   ```bash
   sudo bash /opt/robot-twin/app/deploy/franka-recover.sh
   sudo systemctl start robot-server
   ```

6. Kill the server during a move (step 7.8): the bridge stops the arm in
   about 1 s.

| Failure | Action |
|---|---|
| bridge log `connect failed` | Step 6 table. The bridge keeps reporting `connected: false`; the server will not start (`no robot connection`). |
| `rejected: joint... outside` | The goal is outside the Panda limits with margin: expected; choose another pose. |
| `rejected: path goes below the table` | The straight joint path would hit the table: expected protection. |
| reflex during slow moves (`cartesian_reflex`, `joint_reflex`) | Collision thresholds or payload: set the Franka Hand and the payload in Desk; check that nothing touches the arm. |
| `communication_constraints_violation` | Latency (step 2 and 5). |

Only after all items pass: `FRANKA_SPEED_FACTOR=0.1`.

---

## 9. Gripper

With the robot enabled:

1. **Gripper** (open): the fingers open to 80 mm.
2. **Gripper** (close) with nothing between the fingers: the server reports
   `grasp failed (no object?)`. That is correct: the grasp expects an object of
   `FRANKA_GRASP_WIDTH_M` (20 mm) within the tolerances.
3. Hold a pawn between the fingers and close: grasp succeeds with 20 N
   (`FRANKA_GRASP_FORCE_N`).

If your pieces are wider or narrower, set `FRANKA_GRASP_WIDTH_M` and the
tolerances. If the gripper does not respond: `fci_check.py` must show a
gripper width; run homing from Desk.

---

## 10. Board placement (robot frame)

The kinematics are the official Panda values. You must measure only where the
board is relative to the robot base.

1. With the robot **disabled** in the twin and FCI deactivated in Desk,
   hand-guide the TCP (center between the fingertips) onto the outer corner
   of square **a1**. Activate FCI again.
2. Read the TCP position:

   ```bash
   sudo systemctl stop robot-server robot-franka
   sudo -u robot-twin /opt/robot-twin/franka-venv/bin/python -I /opt/robot-twin/app/apps/franka/fci_check.py $FRANKA_HOST
   ```

   Note `TCP in the base frame (mm): X Y Z`. Optional: repeat for the h1
   corner (board yaw).
3. Convert and check reachability (on the NUC or the dev machine):

   ```bash
   cd /opt/robot-twin/app && PATH=/opt/robot-twin/node/bin:$PATH \
     pnpm --filter server calibrate --from-robot X Y Z [--h1 X Y Z]
   ```

   Expected: the twin `BOARD.origin` and `reachable: 65/65` (64 squares + tray,
   each with the hand pointing down at grab height and 100 mm above).
4. Put the printed values into `packages/chess/src/board.ts` (BOARD.origin,
   rotationDeg) and into `/etc/robot-twin/robot-twin.env`
   (`VISION_BOARD_ORIGIN_X/Y/Z`, `VISION_BOARD_ROTATION_DEG`). Restart
   `robot-server` and `robot-vision`.

If squares are unreachable: move the board (center about 450 mm in front of
the base) or lower `grabHeight` only if the pieces allow it.

---

## 11. Vision calibration

1. Mount the camera above the board, looking down, the whole board visible.
2. Print four ArUco markers (`DICT_4X4_50`, ids 0-3). Put the **center** of
   each marker on an outer board corner: **0 = a8, 1 = h8, 2 = a1, 3 = h1**.
3. Calibrate (writes `/var/lib/robot-twin/vision/calibration.json`):

   ```bash
   curl -s -X POST http://127.0.0.1:8081/calibrate      # "fitted": true, 4 markers
   ```

4. Remove the markers if they cover squares. With the **empty board** and the
   arm in the observe pose, save the reference image:

   ```bash
   curl -s -X POST http://127.0.0.1:8081/reference      # "ok": true
   ```

5. Set up the start position and check:

   ```bash
   curl -s 'http://127.0.0.1:8081/board?debug' | python3 -m json.tool
   ```

   Expected: ranks 1-2 `"w"`, ranks 7-8 `"b"`, the rest `null`. `scores` is
   the fraction of changed pixels per square.

| Failure | Action |
|---|---|
| `fitted: false` | Fewer than 4 markers seen: light, focus, marker size, ids. |
| ranks or files swapped | Markers in the wrong corners (0 must be a8). |
| empty squares seen as occupied | Light changed since the reference: retake it; raise `VISION_DIFF_THRESHOLD` or `VISION_OCCUPIED_FRACTION`. |
| wrong colour | Tune `VISION_WHITE_THRESHOLD` (mean grey of a piece). |

Check three different positions before you trust the camera. The camera and
the light must not move after the reference; if they do, repeat 3-5.

---

## 12. A chess move

1. Choose the observe pose: a pose where the arm does not hide any square
   from the camera (default: ready pose turned 90 deg about joint 1). Check
   it: enable, Home, then set the joint-1 slider to +90 deg and look at
   `/vision/board?debug`. Put the 7 joint values (radians) into
   `CHESS_OBSERVE_POSE` if you need another pose. Restart `robot-server`.
2. `CHESS_REQUIRE_VISION=1` (default for a real robot).
3. Start position on the board. **New game** in the twin.
4. You play white: move a white piece by hand, e.g. e2-e4.
5. Press **Sync from camera**. Expected loop lines:
   `human played e4` -> `asking engine` -> `checking the board before the move`
   -> `playing e5` -> `checking e5 with the camera` -> `e5 done and verified`.
6. Test the mismatch stop once: during the robot's move, take a piece away
   from the board. Expected: `fault: after ... the board does not match`,
   the mismatch squares listed, the robot disabled. Put the board in the
   position the twin shows (FEN), **Clear fault**, **Enable**.

Promotion: the robot places the pawn; the twin asks you to swap it for the
new piece (colour-only vision cannot see the piece type).

---

## 13. Optional: ROS 2 / franka_ros2 / MoveIt (off by default)

Why it is off: the franka_ros2 main line targets the **FR3** and a newer
libfranka (0.13+). A Panda (FER) with system image 4.2.x needs libfranka
**0.9.x**, so it needs an older franka_ros2 release (0.1.x line, joint names
`panda_joint1..7`) built against libfranka 0.9.2. That combination is not
tested here. The ws_bridge package builds and its tests pass in `ros:humble`,
but its motion is experimental (`BRIDGE_EXPERIMENTAL_MOTION=0` by default).

To try it: look up a franka_ros2 tag whose README/CHANGELOG supports the Panda
and libfranka 0.9.x, then
`sudo FRANKA_ROS2_REF=<tag> bash deploy/install.sh --with-ros`, build and
install libfranka 0.9.2 system-wide, and build the workspace. Never run
`robot-ros` and `robot-franka` together (systemd prevents it).

---

## 14. Quick reference

| Task | Command |
|---|---|
| Start / stop | `sudo systemctl start|stop robot-franka robot-vision robot-server caddy` |
| Logs | `journalctl -u robot-franka -u robot-server -f` |
| Bridge state | `curl -s 127.0.0.1:3002/state` |
| Software stop | `curl -s -X POST 127.0.0.1:3002/stop` |
| Recover after reflex | `sudo bash /opt/robot-twin/app/deploy/franka-recover.sh` |
| Preflight | `sudo bash /opt/robot-twin/app/deploy/preflight.sh` |
| Board state | `curl -s '127.0.0.1:8081/board?debug'` |
