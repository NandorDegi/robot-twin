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
      |  (the brain decides: robot-intuition :8095 + robot-reflection :8090,
      |   both 127.0.0.1, CPU only)
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

There is one game loop: the brain's `GameLoop` (`packages/brain`), wired to the
controller and the camera in `apps/server/src/chess.ts`. Details of the brain,
the self-check and the log: [`docs/BRAIN.md`](BRAIN.md).

```
camera --> pre-check --> decision --> predict --> pick/place --> camera verifies
  ^        (board ==      (brain:       (forward    (validated        |
  |         belief?)       intuition +   model)      motions)         |
  |                        reflection)                                |
  `---- mismatch: STOP, disable the robot, name the squares, ask <---'
```

1. **Start.** The loop is stopped when the server starts. A person presses
   **Start** in the twin's Robot brain panel. Start is refused without a valid
   calibration (section 10) and, on the real robot, without a camera.
2. **Observe.** Before every look the arm goes to the observe pose (out of the
   camera view). `GET /vision/board` gives, per square, empty / white / black
   and a confidence. On the human's turn the loop waits for two identical
   looks (hand out of view), then finds the one legal move that explains the
   change (also castling and en passant). An illegal or unclear change stops
   the loop and asks.
3. **Pre-check.** Before the robot's move the board must equal the position
   the robot believes in. If not, the arm does not touch the board.
4. **Decide.** The brain chooses the move: **intuition**, a searchless policy
   network (DeepMind searchless_chess 9M, `robot-intuition`), proposes the top
   candidates; **reflection**, a small LM (Qwen3-1.7B on llama.cpp,
   `robot-reflection`), chooses one with a short reason. If the reflection
   fails, the top candidate is played. There is no chess engine and no search.
   The answer is data: only a legal move is accepted, and the brain never
   commands the arm.
5. **Act.** For each pick and place: approach 100 mm above, descend with the
   hand pointing down, grasp or release, lift. Captures go to the tray.
   Every motion is checked (limits, self-collision, floor, the straight
   joint path) by the server and again by the bridge. A failed motion or
   grasp stops the loop.
6. **Verify.** Back in the observe pose, the camera must show the predicted
   board (up to 3 looks, for a short occlusion). If it does not, the loop
   **halts**, the robot is **disabled**, and the twin shows the squares that
   differ and the likely reasons (for example "piece missing on e5: dropped or
   not released?"). Nothing moves until you answer in the panel and press
   **Enable**.

Every cycle is one line in the JSONL log (`BRAIN_LOG`,
`/var/lib/robot-twin/brain/brain.jsonl`): prediction, observation, differences,
decision and reasons. It is the dataset for later learning.

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
| Board position | measured in step 10 (Calibrate wizard) | saved in `VISION_CALIBRATION_FILE`. |
| Observe pose | step 12 | `CHESS_OBSERVE_POSE`, a pose that does not hide the board. |
| Brain downloads | internet on the NUC during section 4.1 | about 1.2 GB (searchless 9M checkpoint, Qwen3-1.7B GGUF, llama.cpp source). |
| Brain CPU cost | section 4.1, the install bench | `p50_ms` of the intuition per move; the reflection takes about 5-10 s per move on 4 cores (estimate). |
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

### 4.1 Install the brain

The brain is the decision maker of the chess loop. There is no engine to fall
back to: without the brain the loop halts at the robot's first move with
"brain ... failed".

```bash
sudo bash /opt/robot-twin/app/deploy/brain/install-brain.sh
sudo systemctl start robot-intuition robot-reflection
curl -s 127.0.0.1:8095/health     # {"status": "ok", "model": "searchless-9M"}
curl -s 127.0.0.1:8090/health     # {"status": "ok"}
```

Expected: four `[brain] n/4` steps, one intuition `bench` line (note its
`p50_ms`: the time per move), `Done. Nothing was started.` It downloads about
1.2 GB and builds llama.cpp (10-20 min). It is safe to run again.

| Failure | Action |
|---|---|
| `run deploy/install.sh first` | Do section 4 first. |
| `9M checkpoint checksum mismatch` | Download changed or broken. Delete `/opt/robot-twin/brain/searchless/searchless_chess/checkpoints/9M.zip`, retry. |
| `the intuition bench failed` | Read the Python error. JAX needs an x86_64 CPU with AVX. |
| llama.cpp does not build | Read the cmake error. `LLAMA_CPP_REF=<tag>` pins another release. |
| `8090/health` says loading | The model loads for 10-30 s after the start. Retry. |

Options: `WITH_MAIA=1` adds Maia (human-like policy) run by lc0 with
`go nodes 1` (one network evaluation, no search); `WITH_136M=1` adds the
larger searchless network (5-10 s per move). Configuration:
`BRAIN_*`, `INTUITION_*`, `REFLECTION_*` in `/etc/robot-twin/robot-twin.env`.

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
sudo systemctl start robot-intuition robot-reflection robot-franka robot-vision robot-server caddy
systemctl status robot-intuition robot-reflection robot-franka robot-vision robot-server caddy --no-pager
journalctl -u robot-franka -n 5    # backend=dry-run dry_run=True ... listening on http://127.0.0.1:3002
journalctl -u robot-server -n 5    # using FrankaAdapter ... chess loop: brain ... stopped until Start ... listening on ws://127.0.0.1:3001
```

Open `http://<nuc-lan-ip>:5909` from a computer in `TWIN_ALLOWED_CIDRS`.

Check, in this order:

1. Status shows `connected · real · disabled`. The arm does not move.
2. Press **Home**: refused ("disabled").
3. Press **Enable**, then **Home**: the arm goes to the ready pose.
4. Move one joint slider and release it: one motion.
5. One brain move on the simulated board. For this dry-run only, set
   `BRAIN_OBSERVER=sim`, `CHESS_REQUIRE_VISION=0` and
   `CHESS_REQUIRE_CALIBRATION=0`, restart `robot-server`, Enable. In the Robot
   brain panel press **Start (robot = White)**: the panel shows the decision
   ("I play e4 (reflective:http+slm, ... ms)" with the reason and the intuition candidates),
   then approach, descend, close, lift, move, place, observe pose, and
   "verified e4". Type `e5`, **Play** (the simulated hand plays it): the robot
   answers. Press **Fault: drop** and play a move: the robot stops, says which
   squares differ and why, and is disabled. Answer "The board is right,
   continue", Enable. Press **Stop**. Then set the three values back
   (`BRAIN_OBSERVER=vision`, `CHESS_REQUIRE_VISION=1`, calibration required)
   and restart `robot-server`.
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

## 10. Calibration with the wizard (camera, board, robot frame)

The **Calibrate** wizard in the twin does the whole calibration: camera, board
geometry, empty-board reference, detection thresholds, the board pose in the
robot frame, save and final check. Open it with the **Calibrate** button in the
main panel (or `http://<nuc-lan-ip>:5909/#calibrate`). Each step can be done
again at any time; the steps you do not repeat keep their values.

**The chess loop refuses to run without a valid saved calibration** (the twin
shows "Chess loop blocked: ..." in the chess section). Valid means: saved by the
wizard, orientation confirmed, and the final check of that revision passed.
For the first dry-run without a camera (section 7) set
`CHESS_REQUIRE_CALIBRATION=0` and `CHESS_REQUIRE_VISION=0`, and remove both
again afterwards.

Where the result goes: `VISION_CALIBRATION_FILE`
(`/var/lib/robot-twin/vision/calibration.json`). The vision service writes it;
the robot server reads the same file. It is the one source of truth for the
board pose: `BOARD` in `packages/chess/src/board.ts` and `VISION_BOARD_*` are
only the defaults before the first calibration. Every save is a new revision in
`/var/lib/robot-twin/vision/calibration.d/` (file and reference image), so you
can roll back. Both services use a new calibration at once, without a restart.

Before you start: camera mounted above the board, looking down, the whole board
visible; the light as it will be during a game. If you need another observe
pose than the default, set `CHESS_OBSERVE_POSE` first (section 12, item 1).

1. **Camera.** Choose the camera and the resolution, press **Apply**. When the
   image looks right, tick the **Exposure**, **White balance** and **Focus**
   locks (UVC controls; "not supported" when the camera has none). Expected:
   brightness between 60 and 200, focus "sharp", clipped under 1 %.
   - **Lens distortion** (same page; do it for a cheap or wide-angle webcam,
     and always when step 4 misreads squares at the board edges). A webcam lens
     bends straight lines, most at the image edges. One homography cannot follow
     a bent board, so the edge files and ranks are read from the wrong place.
     1. Open **Print the pattern** (default 9 x 6 inner corners, 25 mm squares).
        Print it at 100 % (no "fit to page"). Measure one square, and enter the
        measured size. Glue the sheet flat on card: a bent sheet gives a bad model.
     2. Lock the focus first (the model is valid for one focus and one resolution).
     3. Hold the sheet in front of the camera and press **Capture view**:
        centre, the four corners, the four edges, and tilted about 30 degrees left,
        right, up and down. Keep the whole sheet in view and hold it still. Green
        cells on the image show where the sheet has been. Fill all of them.
     4. With 15-20 views, press **Solve**. Expected: RMS under 0.5 px and no
        warning. **Straightened view** must show straight board edges.
     The model is saved in the calibration file (`camera.intrinsics`). A new
     model resets the orientation confirmation: confirm step 2 again and run
     the auto-tune in step 4 again. A change of the camera or the resolution
     removes the model. Without a model the raw image is used, as before.
2. **Board geometry.** Put the four ArUco markers (`DICT_4X4_50`, ids 0-3) with
   their **centre** on the outer corners: **0 = a8, 1 = h8, 2 = a1, 3 = h1**,
   or show an empty board. Press **Detect automatically**. The grid and the
   corner names are drawn on the live image. Expected: reprojection error under
   1.5 px mean, "a1 is dark: yes". A mean error above about 2 px with straight
   board edges in the stream, but bent ones near the image border, means lens
   distortion: do the lens part of step 1.
   - If nothing is found: **Click 4 corners** and click the outer corners in
     the order the guidance shows (a1, h1, h8, a8, counterclockwise on the
     screen). A mirrored order is refused.
   - **Orientation:** the green dot must be on a1 and the thick white edge on
     rank 1 (the White side). If not, **Pick the a1 corner on the image**.
     a1 is always a dark square; the wizard warns when it is not. Then press
     **Confirm orientation**. This fixes the rank/file mapping.
   - "The camera image is mirrored" only for a camera with a mirror setting.
3. **Empty-board reference.** Remove all pieces and the markers. Press
   **Move arm to observe pose** (robot enabled), then **Capture reference**
   (10 frames, averaged). Read the warnings and the per-square brightness:
   glare, shadow, noise or "uneven" squares. Fix the light and capture again
   until there is no warning.
4. **Detection.** Set up the start position. Press **Auto-tune for the start
   position**. Expected: `64/64 squares, 32/32 pieces` and positive margins.
   Adjust the sliders only if needed. **Test:** press **Start test**, make a
   legal move on the board, press **Detect move**; the wizard names the move.
   Do this for three or four moves (a capture too).
5. **Robot frame (board pose in the robot base frame).** Do this in dry-run
   first (`FRANKA_DRY_RUN=1`), then with the real robot at
   `FRANKA_SPEED_FACTOR=0.05`.

   > **The arm moves only when you press a button.** The robot must be
   > enabled. For the real robot tick "I hold the user stop" first and keep
   > the user stop in your hand. Each jog is at most 10 mm.

   - Set **Hover height**: the height of the TCP (centre between the
     fingertips) above the board surface when you record, e.g. 20 mm with a
     gauge block.
   - **Go above a1**: the hand goes, pointing down, 30 mm above the hover
     height over a1 of the current board pose. Lower it with **-Z** and centre
     it over the middle of a1 with **±X/±Y** (robot base frame: X forward, Y
     left, Z up). Press **Record a1**.
   - The same for **h1** and **h8**.
   - **Fit board pose**. Expected: residual under 2 mm, `Reachable 65/65`, no
     warning (mirrored order, tilted board, square size). The wizard shows the
     difference to the current pose.
   - Instead of the touch-off you can type the a1 **corner** in the robot base
     frame (for example from `fci_check.py`, as in the old procedure), the yaw
     and the square size, and press **Use manual pose**.
   - Without a robot server (twin only) the twin's own simulated arm is used,
     so you can practise the whole wizard on a laptop.
6. **Save and validate.** Write an operator note, press **Save calibration**.
   Set up the **start position**, press **Move arm to observe pose**, then
   **Run final check**. Expected: `PASSED · pieces 32/32 · squares 64/64 ·
   reachable 65/65` and "Chess loop: allowed". If it fails, the wrong squares
   or the unreachable squares are listed: fix the cause, repeat the step, save
   again and check again.

| Failure | Action |
|---|---|
| no board found | Light, focus, all 4 markers visible, ids 0-3; or click the corners. |
| "a1 looks LIGHT" | Wrong a1 corner: pick the dark corner on the White side. |
| "the corners are mirrored" | Click in the order a1, h1, h8, a8 (counterclockwise on the screen). |
| reference warnings | Glare: move the light or use a diffuser, lower the exposure. Shadow: move the light or the arm. |
| auto-tune below 64/64 | Retake the reference with the same light; check that the pieces contrast with both square colours. |
| fit warns "MIRRORED" | You recorded the points in the wrong order or at the wrong squares. Clear points, repeat. |
| residual > 2 mm | Re-touch more carefully, slower jogs (1-2 mm). Check that the board does not move. |
| squares unreachable | Move the board closer to the base (centre about 450 mm in front of it). |
| final check fails | The camera or the light moved since the reference: repeat steps 3-4, save, check. |

Check three different positions in the move test before you trust the camera.
If the camera, the light or the board moves later, repeat the affected steps
(2-6), save and run the final check again.

---

## 11. Calibration files, rollback and checks

- **Versions and rollback:** wizard step 6 lists every revision. **Roll back**
  makes an old revision active again (as a new revision; history stays). The
  final check of the old revision carries over.
- **Status from the shell:**

  ```bash
  curl -s http://127.0.0.1:8081/calib/status | python3 -m json.tool   # revision, complete, reasons
  curl -s 'http://127.0.0.1:8081/board?debug' | python3 -m json.tool  # live board state
  ```

- **Reachability of the saved pose** (the same check as the final check):

  ```bash
  cd /opt/robot-twin/app && PATH=/opt/robot-twin/node/bin:$PATH \
    VISION_CALIBRATION_FILE=/var/lib/robot-twin/vision/calibration.json \
    pnpm --filter server calibrate --check
  ```

- The old `POST /calibrate` and `POST /reference` endpoints refuse to change a
  wizard calibration. Use the wizard.
- The file holds: camera source, resolution and locked controls (intrinsics are
  not computed), the homography and the image corners, the orientation, the
  reference image path, the thresholds, the board pose (twin frame and the a1
  corner in the robot base frame), the operator note, the date and the result
  of the final check.

---

## 12. A chess move

1. Choose the observe pose: a pose where the arm does not hide any square
   from the camera (default: ready pose turned 90 deg about joint 1). Check
   it: enable, Home, then set the joint-1 slider to +90 deg and look at
   `/vision/board?debug`. Put the 7 joint values (radians) into
   `CHESS_OBSERVE_POSE` if you need another pose. Restart `robot-server`.
2. `BRAIN_OBSERVER=vision`, `CHESS_REQUIRE_VISION=1` (defaults for a real
   robot), the brain healthy (section 4.1), the calibration valid (section 10).
3. Start position on the board, arm enabled. In the Robot brain panel press
   **Start (robot = Black)**. The loop line says `awaiting-human`.
4. You play white: move a white piece by hand, e.g. e2-e4, and take your hand
   out of the camera view. Expected panel and loop lines: `you played e4` ->
   `robot-turn` (pre-check) -> `I play e5 (reflective:http+slm, ... ms)` with the reason ->
   `acting` -> `verifying` -> `verified e5` -> `awaiting-human`. While it is
   the robot's turn, keep your hands out of the camera view.
5. Test the mismatch stop once: during the robot's move, take the piece away
   that it carries or puts down. Expected: `I stopped (mismatch)`, the
   squares that differ with the likely reasons, the robot disabled. Fix the
   board, press **I fixed the board, look again**, then **Enable**. The other
   answers: **The board is right, continue** (the camera was wrong) and
   **Set the true position (FEN)**.
6. Look at the log: `sudo tail -n 3 /var/lib/robot-twin/brain/brain.jsonl`.
   One line per cycle, `verdict` `human-move`, `ok`, `mismatch`, `resolved`.

When the robot halts, manual motion (sliders, Home, gripper) is allowed again
for the person who fixes the board. While the loop runs, the server refuses
manual motion: the loop is the only commander of the arm. **Stop** ends the
game; **Resume** continues after a pause (for example after a recalibration).

Promotion: the robot places the pawn; the loop line asks you to swap it for the
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
| Start / stop | `sudo systemctl start|stop robot-intuition robot-reflection robot-franka robot-vision robot-server caddy` |
| Logs | `journalctl -u robot-franka -u robot-server -f` |
| Bridge state | `curl -s 127.0.0.1:3002/state` |
| Software stop | `curl -s -X POST 127.0.0.1:3002/stop` |
| Recover after reflex | `sudo bash /opt/robot-twin/app/deploy/franka-recover.sh` |
| Preflight | `sudo bash /opt/robot-twin/app/deploy/preflight.sh` |
| Board state | `curl -s '127.0.0.1:8081/board?debug'` |
| Brain health | `curl -s 127.0.0.1:8095/health; curl -s 127.0.0.1:8090/health` |
| Brain logs | `journalctl -u robot-intuition -u robot-reflection -f` |
| Loop log (JSONL) | `sudo tail -f /var/lib/robot-twin/brain/brain.jsonl` |
| Calibration status | `curl -s 127.0.0.1:8081/calib/status` (wizard: twin -> Calibrate) |
