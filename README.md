# Robot Twin

Digital twin + vision for a robot arm (default model: Franka Emika Panda, 7-DOF; target: chess pick & place).

A lightweight Three.js web twin with an inverse-kinematics solver, a vision
subsystem, and a pluggable hardware adapter so the real arm can be wired in
later. The arm model is fully configurable, so you can drop in the real
dimensions when you have them (see `docs/MEASURE-THE-ARM.md`).

## What's in it

| Part | Location | What it does |
|---|---|---|
| Kinematics | `packages/kinematics` | Forward kinematics (DH-style chain), analytic geometric Jacobian, Levenberg–Marquardt (damped least squares) IK with joint limits, smooth trajectory generation |
| Arm model | `packages/robot-config` | Configurable robot: joints, axes, limits, link offsets; builds the kinematic chain |
| Chess | `packages/chess` | Board state, legal move generation (castling, en passant, promotion, check), FEN, and a move → pick/place planner |
| Protocol | `packages/protocol` | Shared WebSocket message types + zod validation |
| Hardware | `packages/hardware` | `RobotAdapter` interface, a `SimulatedAdapter` (twin only), a `SerialAdapter` (generic), and a `FrankaAdapter` (FCI, drives the Panda through `apps/franka`) |
| Twin (web) | `apps/twin` | Three.js scene: drag the end-effector target, joint sliders, gripper, live camera feed with clickable piece overlays, record/replay |
| Server | `apps/server` | Real-time robot controller + WebSocket bridge + trajectory record/replay |
| Vision | `apps/vision` | Python service: camera capture, MJPEG stream, piece detection (YOLO or heuristic), board calibration (ArUco), robot-frame targets |

## Architecture

```
Browser (twin) --> Caddy :5909 --> /robot-ws --> robot server (Node, 127.0.0.1:3001)
                                |                 controller + chess loop
                                |                    | HTTP + lease + heartbeat
                                |                    v
                                |               Franka bridge (panda-py 1.1.1 /
                                |               libfranka 0.9.2, 127.0.0.1:3002)
                                |                    | FCI (dedicated NIC, RT kernel)
                                |                    v
                                |               Panda control unit
                                `--> /vision/* --> vision service (127.0.0.1:8081)
```

- The **Franka bridge** (`apps/franka`) is the only process that commands the
  arm (lock file, loopback only, one lease with heartbeat watchdog). It
  validates every goal again and runs in dry-run mode by default.
- The **robot server** (`apps/server`) validates every goal (Panda limits,
  self-collision, floor, the straight joint path), sends only whole goals to
  the real robot, starts disabled, and runs the chess loop:
  camera -> board state -> decision -> pick/place -> camera verification.
  The decision step is pluggable (`apps/server/src/decider.ts`).
- The ROS 2 / MoveIt bridge (`apps/ws_bridge`) is optional and off by default.

Bring-up on the NUC: [`docs/NUC-BRINGUP.md`](docs/NUC-BRINGUP.md).

## Run it

Prerequisites: Node 22+, pnpm, Python 3.10+.

```bash
pnpm install

# 1. Robot server (WebSocket + controller). Optional for the twin, required for
#    live motion / IK over the network.
pnpm dev:server

# 2. Digital twin (Vite dev server at http://localhost:5173)
pnpm dev:twin

# 3. Vision service (camera + board detection). Runs standalone; the twin
#    auto-connects to its /stream feed.
cd apps/vision
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m vision   # http://localhost:8081
```

The twin works offline too: if the server is unreachable it falls back to a
local simulation (drag target -> local IK -> move), so you can play with it
before anything else is running.

### Vision endpoints

- `GET /health` -> `{"status":"ok"}`
- `GET /stream` -> MJPEG feed (shown in the twin)
- `GET /detect` -> JSON list of detected pieces (board square + robot-frame target) and frame size
- `GET /calibrate` -> fits and saves the board homography from ArUco corner markers

### Calibrate the board (once)

Place ArUco markers `0..3` at the four board corners, then (from `apps/vision`):

```bash
.venv/bin/python calibrate.py --camera 0 --out calibration.json
```

The server and twin use this so a detected piece becomes a robot-frame target.

### Connect to the real Panda (FCI)

Use the runbook [`docs/NUC-BRINGUP.md`](docs/NUC-BRINGUP.md): real-time
kernel, FCI network, read-only FCI check, dry-run, then low speed. For a quick
local dry-run without a robot:

```bash
FRANKA_DRY_RUN=1 python3 apps/franka/franka_bridge.py &        # 127.0.0.1:3002
ROBOT_ADAPTER=franka CHESS_REQUIRE_VISION=0 pnpm dev:server
```

### Calibrate the board placement

The model's kinematics are the official Franka values, so the arm's *relative*
motion matches one-to-one. The only thing that must be measured is **where the
board sits relative to the robot base**. The twin's board lives in the model
frame `T` (Y-up); the robot reports positions in its base frame `B` (Z-up). The
fixed relationship is `T = RotX(-90) · B`, so a naive copy of a robot-frame
measurement would be rotated 90° wrong.

To set the twin's `BOARD.origin` from a measurement taken in the robot frame:

1. Get the board's **a1-corner** position in `B` (mm, X forward / Y left / Z up).
   Hand-guide the TCP onto the a1 corner and run `apps/franka/fci_check.py`.
2. Convert it and check reachability:

```bash
pnpm --filter @robot/server calibrate --from-robot X Y Z
```

This prints the twin `BOARD.origin` and a reachability report for all 64 squares
+ tray. Update `packages/chess/src/board.ts` (and
`apps/vision/vision/config.py`) with the printed `origin`. Then run the ArUco
camera calibration (section above) so detected pieces map to the same board.


### Try detection on a static image

```bash
.venv/bin/python detect_image.py board.jpg
```

## Controls in the twin

- **Orbit / pan / zoom** with the mouse.
- **Joint sliders** set each joint (deg).
- **Drag the green target sphere**, then press **Move -> Target** to IK the arm
  there (goes through the server when connected, else local).
- **Enable** to arm motion, **Home** to go to the neutral pose, **Gripper** to
  open/close, **E-Stop** to stop immediately.
- **Record / Replay**: record a sequence of moves and gripper actions, then
  replay them on the arm.
- **Click a detected piece** on the camera feed to set the target to its
  robot-frame position.
- The green axis line marks the target; the HUD shows end-effector and target
  positions.

### Chess + voice

A full chess loop is wired in:

- **3D chessboard** (built-in) renders the start position; it mirrors the
  server's FEN.
- **Play a move in standard notation** (e.g. `e4`, `Nf3`, `O-O`) in the text
  box (or speak it — the mic button uses the browser Web Speech API). The
  spoken phrase is interpreted by a chess-domain recogniser (`spokenToSan` in
  `packages/chess`) that resolves against the current position, so it
  understands captures (`e takes d5` → `exd5`, `knight takes c6` → `Nxc6`),
  castling (`long castle` / `queen side castle` / `o-o-o` → `O-O-O`; `castle
  king side` → `O-O`), checks, promotions, and ignores filler words. Light
  mis-hearings of piece names (`night` for `knight`) are handled too. The
  server parses the SAN, plans the pick/place steps, and the arm plays the move
  (grab → lift → place; captures go to a tray).
- **Opponent mode**: toggle a bot with a variable-ElO slider (minimax with
  alpha-beta + material/piece-square eval; depth & noise scale with Elo).
  Alternatively, set `CHESS_DECIDER_URL` to a service that gets
  `{"fen", "legal", "side"}` and returns `{"uci": "..."}` or `{"san": "..."}`
  (an LLM agent or a learned policy). Only legal moves are accepted.

```bash
# optional: play against an agent through the model router
CHESS_DECIDER_URL=http://<router>/move pnpm dev:server
```

### Chess

The chess engine lives in `packages/chess`. A move (UCI, e.g. `e2e4`) is turned
into an ordered pick/place plan (captures go to a tray; castling moves the rook
first). Example:

```ts
import { parseFen, planMove, uciToMove } from "@robot/chess";
const pos = parseFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
planMove(pos, uciToMove(pos, "e2e4")); // [{pick e2}, {place e4}]
```

## Safety

- The user stop (external activation device) on the robot is the safety
  function. The twin's E-Stop is a software stop.
- The server starts disabled with a real robot; a person must press Enable.
- Every goal is validated twice (server and bridge); an IK target that is not
  reached is never executed; the real robot only gets whole goals.
- Losing the twin connection, the server heartbeat, or a motion failure stops
  and disables the robot. Recovery is an operator action.

## Quality gates

```bash
pnpm -r typecheck
pnpm -r test       # TS unit tests
pnpm -r lint
(cd apps/franka && python -m pytest tests)   # bridge
(cd apps/vision && python -m pytest tests)   # vision
pnpm -r build
```
