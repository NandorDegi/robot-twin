# The robot's brain

The robot plays chess with its own perception, its own decision and its own
self-check. It looks at the board, thinks of a move, **predicts** what the board
will look like after the move, makes the move, looks again, and compares. If
what it sees is not what it predicted, it stops and asks the human. It does not
assume that its actions worked.

The decision has two parts, both small AI models that run on the NUC's CPU:

- **Intuition**: a learned move-policy network. One look at the position gives
  a probability for each move. There is no search tree.
- **Reflection**: a small language model (SLM) that reads the position, the
  intuition's top candidates and the robot's own recent self-check notes, and
  chooses one candidate with a short reason.

No chess engine (Stockfish or similar) and no search is in the decision path;
the local minimax engine of the first version is removed. A remote fleet LLM is
an optional reflection backend and is off by default.

This is the server's only game loop. `apps/server/src/chess.ts` wires the
`GameLoop` to the controller (single commander), the calibrated camera, the
calibration gate and the twin. The bring-up steps are in
[`docs/NUC-BRINGUP.md`](NUC-BRINGUP.md) (sections 0, 4.1, 7, 12).

## Architecture

```
            USB camera over the board
                       |
          +------------v-------------+
          | vision service (Python)  |  GET /board (default): 64 squares,
          | calibrated by the wizard |    colour + confidence (empty-board
          |                          |    reference); GET /observe: colour,
          |                          |    type, confidence (YOLO/heuristic)
          +------------+-------------+
                       | Observation
+----------------------v-----------------------------------------------+
| GameLoop (@robot/brain, in apps/server)                              |
|                                                                      |
|  observe --> pre-check --> decide --> predict --> act --> observe    |
|     ^        (board ==      |           (forward    |       |        |
|     |         belief?)      |            model)     |       v        |
|     |                       |                       |    compare     |
|     |                       v                       |   prediction   |
|     |      +---------------------------------+      |   vs. sight    |
|     |      | Brain.decide(fen, history, ...) |      |     |    |     |
|     |      |  intuition: policy net, top-k   |      |   match  diff  |
|     |      |      |  (legal moves only)      |      |     |    |     |
|     |      |      v                          |      |     |    v     |
|     |      |  reflection: SLM picks one      |      |     |  STOP:   |
|     |      |  (JSON, must be a candidate;    |      |     |  squares,|
|     |      |   on failure: top candidate)    |      |     |  reasons,|
|     |      +---------------------------------+      |     |  ask the |
|     |                                               |     |  human   |
|     +---- human's move: diff observations, --------+-----+          |
|           find the legal move that explains it                       |
|                                                                      |
|  every cycle --> BRAIN_LOG JSONL (prediction, observation, diff,     |
|                  decision, rationale): the dataset for learning      |
+---------+-------------------------------+----------------------------+
          | pick/place steps              | events (WebSocket)
          v                               v
  RobotController -> RobotAdapter     twin: brain panel (Start/Stop/Resume,
  (Simulated by default; Franka        state, rationale, questions + answers)
   via the panda-py bridge)

  safety in apps/server/src/chess.ts: stopped at server start; calibration
  gate before start and every step; the arm parks out of the camera view
  before every look; any halt DISABLES the robot; no step while disabled;
  manual motion refused while the loop runs; the simulated board is refused
  on a real robot.

  sidecars on the NUC:  intuition  127.0.0.1:8095  (searchless_chess, JAX CPU)
                        reflection 127.0.0.1:8090  (llama.cpp llama-server)
```

Code:

| Part | Where |
|---|---|
| Decision interface, intuition, reflection, self-check, loop, simulator | `packages/brain/src/` |
| Server wiring: the one chess loop, arm actor, parked observer, safety | `apps/server/src/chess.ts` |
| Calibrated occupancy observer (`GET /board`) | `packages/brain/src/vision.ts` (`OccupancyObserver`) |
| WebSocket messages | `packages/protocol/src/brain.ts` |
| Twin panel | `apps/twin/src/brainpanel.ts` |
| Intuition sidecar (searchless_chess) | `apps/intuition/intuition_server.py` |
| Per-square observation | `apps/vision/vision/observe.py` (`GET /observe`) |
| Detector dataset + training | `apps/vision/training/` (see its `README.md`) |
| NUC install | `deploy/brain/install-brain.sh`, `deploy/brain/systemd/` |

## The decision interface

```ts
interface Brain {
  name: string;
  decide(input: DecisionInput): Promise<Decision>;
  commentary?(input: CommentaryInput): Promise<string | null>;
  close?(): Promise<void>;
}
// DecisionInput: { fen, history (UCI from startFen), startFen?, clock?, context? }
//   context = { lastHumanMove?, recent: string[] }  -- the robot's short-term memory
// Decision: { uci, san, rationale, brain, candidates?, fallbackReason?, elapsedMs }
```

The loop checks every move against `packages/chess` again before the arm
moves. A brain cannot make the arm play an illegal move.

### Intuition (`IntuitionBrain` + a `PolicyModel`)

A `PolicyModel` returns raw `(move, probability)` pairs. `legalTopK` removes
every move that `packages/chess` says is illegal, renormalises and keeps the
top k (default 5). With `INTUITION_TEMPERATURE` > 0 the intuition samples among
the top k instead of always taking the first one.

| Backend | `BRAIN_INTUITION` | What it is | Licence |
|---|---|---|---|
| `HttpPolicyModel` -> `apps/intuition` | `searchless` (default) | DeepMind searchless_chess action-value transformer, 9M (default), 136M or 270M parameters. For each legal move it predicts the win probability in one batched forward pass; the sidecar turns these into a distribution (softmax, T = 0.05). No lookahead, no tree. | code Apache-2.0, weights CC-BY-4.0 |
| `Lc0PolicyModel` | `maia` | Maia (CSSLab), a human-like policy network per rating band (1100..1900), run by lc0 with `go nodes 1` (one network evaluation). The policy is read from lc0's `VerboseMoveStats`, not lc0's chosen move. | Maia and lc0 GPL-3.0 |
| `LearnedPolicyModel` | `learned` | Stub for a policy trained on the robot's own games. Throws. | - |
| `UniformPolicyModel` | `uniform` | Wiring placeholder (uniform over legal moves) for the simulator. Not a brain. | - |

Notes on searchless_chess (verified 2026-11-09 against commit `90ae0e6`):

- The repository publishes `9M.zip` (66 MB), `136M.zip` (1.0 GB), `270M.zip`
  (2.0 GB), and `9M_behavioral_cloning.zip` (33 MB). The engine code builds only
  the three action-value models. The behavioural-cloning checkpoint uses other
  parameter names (`Dense_0`, ...) than the repository's Haiku transformer, so
  it is not wired in.
- It needs JAX. On the NUC that is the CPU wheel (`pip install jax`); no
  conversion is needed. The cost is memory: the XLA runtime and one compiled
  program per batch shape take about 1.2 GB RSS for the 9M model (measured, see
  below). An ONNX/OpenVINO export would be leaner but is not done.
- `src/constants.py` imports Apache Beam and Grain for the training data
  pipeline. The sidecar stubs these two modules, so the NUC does not need them.

### Reflection (`ReflectiveBrain` + `ChatClient`)

The reflection gets:

- the FEN and a plain-language description of the position (`describe.ts`);
- the human's last move;
- up to five recent self-check notes ("cycle 12: my move Nf3: mismatch on f3 (missing)");
- the intuition's candidates, in UCI and SAN, with probabilities.

It must answer JSON `{"move": "<one candidate>", "rationale": "<= 25 words"}`.
The request carries a JSON schema whose `move` is an `enum` of the candidates,
so llama.cpp constrains the output with a grammar. The answer is validated
again. On invalid JSON, a move that is not a candidate, an HTTP error, a network
error or the time limit, the robot plays the intuition's top move and records
`fallbackReason`. A broken language model never stops the game.

Backends (same client, OpenAI-compatible `/v1/chat/completions`):

| `BRAIN_REFLECTION` | Endpoint | Default |
|---|---|---|
| `local` | llama.cpp `llama-server` on the NUC, `REFLECTION_URL` (default `http://127.0.0.1:8090/v1`) | yes |
| `remote` | fleet LLM: `FLEET_LLM_URL`, `FLEET_LLM_MODEL`, `FLEET_LLM_KEY_FILE` | no |
| `off` | intuition only | no |

Model for `local`: Qwen3-1.7B, GGUF Q4_K_M (1.11 GB,
`unsloth/Qwen3-1.7B-GGUF`, revision `d7f544e`, Apache-2.0). The official
`Qwen/Qwen3-1.7B-GGUF` has only Q8_0 (1.83 GB). A stronger choice if the time
budget allows: `Qwen/Qwen3-4B-GGUF` Q4_K_M (2.5 GB). (Verified 2026-11-09.)

Thinking: `REFLECTION_THINKING=1` sends `chat_template_kwargs.enable_thinking`
(Qwen3 thinking mode). The budget is server-side, `llama-server
--reasoning-budget N` (token budget), plus the per-request cap
`REFLECTION_MAX_TOKENS`. The time limit per move is `REFLECTION_TIMEOUT_MS`
(default 20000). Not verified on a live server: whether llama.cpp applies the
JSON-schema grammar only after the thinking block. Our own validation covers
that case.

The key, if any, is read from the file `REFLECTION_KEY_FILE` /
`FLEET_LLM_KEY_FILE`. It is sent only as the `Authorization` header and never
logged; an unreadable file gives an error that names the path only.

`commentary()` (`BRAIN_COMMENTARY=1`) asks the same model for one or two
sentences about a move, for spectators. Failure returns nothing.

## The loop

States: `awaiting-human`, `robot-turn`, `acting`, `verifying`, `halted`, `game-over`.

Robot turn (`GameLoop.robotTurn`):

1. **Observe and pre-check.** If the board does not match the position the robot
   believes in, it does not move (`pre-check-failed`).
2. **Decide.** `brain.decide()` with the history and the short-term memory.
3. **Validate.** The move must be legal in `packages/chess`.
4. **Predict.** `applyMove()` gives the expected board (the forward model).
5. **Act.** `planMove()` gives pick/place steps; the actor carries them out. The
   server actor (`ControllerActor`) approaches each square from
   `APPROACH_HEIGHT_MM` (100 mm) above, descends, grips, rises; a failed motion
   or gripper command throws, and the loop halts.
6. **Observe again and compare.** Up to `verifyAttempts` (3) looks, `settleMs`
   apart, so a short occlusion by the arm does not count as a failure.
7. **Match**: commit the move, continue. **Mismatch**: stop, report, ask.

A camera failure (vision unreachable, not calibrated, the arm cannot reach the
observe pose) is a halt too, with the reason: the loop never guesses.

Human turn (`GameLoop.humanTurn`): observe; wait until `stableFrames` (2)
consecutive observations are identical (hand out of view); then find the legal
move that explains the change (below).

When halted, the human answers through the twin panel (WebSocket `brain`
`resolve`):

| Answer | Meaning |
|---|---|
| `retry` | "I fixed the board, look again." The robot verifies again. |
| `accept-prediction` | "The board is right, the camera is wrong." Continue with the prediction. |
| `set-fen` | "This is the true position." The history restarts from it. |
| `choose-move` | For an ambiguous human move: "this is what I played." |

## The self-check

`diffBoard(expected, observation)` compares square by square:

| Kind | Expected | Seen |
|---|---|---|
| `missing` | a piece | empty |
| `unexpected` | empty | a piece |
| `wrong-color` | a piece | a piece of the other colour |
| `wrong-type` | a piece | another type (only when the detector knows types) |

A colour-only observation (heuristic detector, `type: null`) agrees with any
piece of that colour. A square below `BRAIN_MIN_CONFIDENCE` (0.6) is flagged:
as `uncertain` when it agrees, as `lowConfidence` when it differs.

`explainDiff` turns differences into hypotheses for the human, for example:

- piece still on the source square -> the grasp failed;
- neither on source nor destination -> dropped in transit;
- a piece next to the destination -> placed off-centre or fell over;
- a piece missing elsewhere -> knocked over by the arm, or occluded;
- low confidence -> misdetection, glare or occlusion: look again;
- eight or more differences -> the board or camera moved: recalibrate.

**The human's move**: `detectHumanMove(position, observation)` applies every
legal move and keeps those whose predicted board matches the observation.
Exactly one -> `move`. Several -> `ambiguous` (for example a promotion seen by
a colour-only detector) -> the robot asks. None -> `illegal` (or not finished,
or misread) -> the robot stops and shows the changed squares. Castling and en
passant work, because the whole board is compared, not two squares.

## The JSONL log

`BRAIN_LOG` (default `logs/brain.jsonl`, relative to the server's working
directory). One JSON object per cycle; `v` is the format version.

| Field | Meaning |
|---|---|
| `v`, `ts`, `game`, `cycle`, `phase` | version, time, game id, cycle number, `robot` / `human` / `resolve` |
| `fenBefore`, `fenAfter` | position before; position the robot believes in afterwards |
| `decision` | `uci`, `san`, `brain`, `rationale`, `candidates` [{uci, san, prob}], `fallbackReason`, `elapsedMs` |
| `plan` | pick/place steps |
| `predicted` | 64 labels in FEN order (a8..h8, a7, ..., h1): `.` empty, `PNBRQK` / `pnbrqk` |
| `observed` | `board` (64 labels, plus `W`/`B` = piece of unknown type), `confidence` (64 numbers), `source`, `frameId` |
| `diff`, `uncertain` | square differences (see the self-check); agreeing squares with low confidence |
| `verdict` | `ok`, `mismatch`, `pre-check-failed`, `human-move`, `illegal`, `ambiguous`, `resolved`, `error` |
| `hints`, `humanMove`, `commentary`, `error` | as named |

Example (a failed grasp in the simulator, shortened):

```json
{"v":1,"cycle":4,"phase":"robot","fenBefore":"r1bqkbnr/pppppppp/n7/8/4P3/N7/PPPP1PPP/R1BQKBNR b KQkq - 2 2",
 "verdict":"mismatch","decision":{"uci":"a8b8","san":"Rb8","brain":"intuition:uniform-placeholder", "...":"..."},
 "plan":[{"op":"pick","square":"a8"},{"op":"place","square":"b8"}],
 "predicted":".rbqkbnrppppppppn...................P...N.......PPPP.PPPR.BQKBNR",
 "observed":{"board":"r.bqkbnrppppppppn...................P...N.......PPPP.PPPR.BQKBNR","confidence":[0.95,"..."],"source":"sim"},
 "diff":[{"square":"a8","kind":"unexpected","expected":".","observed":"r","confidence":0.95,"lowConfidence":false},
         {"square":"b8","kind":"missing","expected":"r","observed":".","confidence":0.95,"lowConfidence":false}],
 "hints":["The piece is still on a8: the grasp at a8 probably failed (gripper closed on nothing)."]}
```

## Learning path

Nothing here trains the language model yet. The log is built so that it can:

- **Reflection SLM**: LoRA fine-tuning on the robot's own JSONL logs with
  rde-weightlab. Each robot cycle is a training example: the prompt
  (position, candidates, self-check notes) and the chosen move + rationale,
  weighted by what followed (verified, mismatch, game result). The fine-tuned
  GGUF replaces the base model in `llama-server`; nothing else changes.
- **Intuition**: implement `LearnedPolicyModel.policy()` (`packages/brain/src/learned.ts`)
  for a policy trained on the robot's games, or fine-tune the searchless 9M
  network. Any `PolicyModel` plugs into `IntuitionBrain`; the legal-move filter
  and the reflection stay the same.
- **Perception**: the piece detector is trained from frames labelled with the
  positions the robot verified (`apps/vision/training/`).

To add a brain: implement `Brain` (or only a `PolicyModel`), add a case in
`packages/brain/src/factory.ts`, and add a test that it returns legal moves.

## Configuration (server environment)

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_INTUITION` | `searchless` | `searchless`, `maia`, `learned`, `uniform` |
| `INTUITION_URL` | `http://127.0.0.1:8095` | searchless sidecar |
| `INTUITION_TOPK`, `INTUITION_TEMPERATURE` | 5, 0 | candidates; 0 = always the top move |
| `INTUITION_MAIA_WEIGHTS`, `INTUITION_LC0_PATH`, `INTUITION_LC0_BACKEND`, `INTUITION_LC0_THREADS` | -, `lc0`, lc0's choice, 1 | Maia |
| `BRAIN_REFLECTION` | `local` | `local`, `remote`, `off` |
| `REFLECTION_URL`, `REFLECTION_MODEL`, `REFLECTION_KEY_FILE` | `http://127.0.0.1:8090/v1`, `qwen3-1.7b`, - | local SLM |
| `REFLECTION_TIMEOUT_MS`, `REFLECTION_THINKING`, `REFLECTION_MAX_TOKENS` | 20000, 0, 160 (768 with thinking) | time limit, thinking, token cap |
| `FLEET_LLM_URL`, `FLEET_LLM_MODEL`, `FLEET_LLM_KEY_FILE` | - | remote reflection (off by default) |
| `BRAIN_OBSERVER` | `vision` when `VISION_URL` is set, else `sim` | `vision` (`/board`, calibrated occupancy), `observe` (`/observe`, piece detector) or `sim` (simulated board; refused when `CHESS_REQUIRE_VISION=1`) |
| `VISION_URL` | - | vision service (`http://127.0.0.1:8081` on the NUC) |
| `CHESS_REQUIRE_VISION`, `CHESS_REQUIRE_CALIBRATION` | 1 on a real robot; 1 with `VISION_URL` or a real robot | safety gates |
| `CHESS_OBSERVE_POSE`, `CHESS_SETTLE_MS` | ready pose turned 90 deg about joint 1, 500 | where the arm waits during a look |
| `BRAIN_ROBOT_COLOR`, `BRAIN_MIN_CONFIDENCE`, `BRAIN_POLL_MS`, `BRAIN_LOG`, `BRAIN_COMMENTARY` | `b`, 0.6, 500, `logs/brain.jsonl` (NUC: `/var/lib/robot-twin/brain/brain.jsonl`), 0 | loop |

Vision side: `VISION_OBSERVE_MODEL` (YOLO `.pt`, `.onnx` or `*_openvino_model/`),
`VISION_OBSERVE_MIN_CONF` (0.25), `VISION_OBSERVE_EMPTY_CONF` (0.9),
`VISION_OBSERVE_ANCHOR` (0.5).

## Cost per move on CPU

**Measured** on spark1 (aarch64, Arm Cortex-X925 cores, 2026-11-09), not on the
NUC. searchless 9M, 5 test positions x 5 rounds, after the jit warm-up:

| Setup | p50 per move | max | Peak RSS | Start-up |
|---|---|---|---|---|
| 4 cores (`taskset -c 0-3`) | 345 ms | 570 ms | 1.2 GB | 15 s (7 compiled batch shapes) |
| 20 cores | 98 ms | 162 ms | 1.8 GB | 12 s |

The cost grows linearly with the number of legal moves (one row each): about
12 ms per move-row on 4 cores (16 rows: 193 ms, 64 rows: 776 ms). Without the warm-up the first position of each
batch size pays a 0.5-1 s compile.

**Estimated** (not measured; assumes a 4-core Intel Core i5/i7 NUC with
dual-channel DDR4; scale by your CPU):

| Part | Per move | Memory |
|---|---|---|
| Intuition searchless 9M | 0.3-0.8 s | about 1.2 GB |
| Intuition searchless 136M | 5-10 s (about 15x the compute of 9M) | about 2 GB |
| Intuition Maia via lc0 (6 blocks x 64 filters, `nodes 1`) | under 50 ms | 50-150 MB |
| Reflection Qwen3-1.7B Q4_K_M, thinking off (~450 prompt tokens, ~40 output tokens) | 5-10 s | about 1.6 GB (1.1 GB weights + KV cache for 4096 context) |
| Same, thinking budget 256 tokens | +10-17 s | same |
| Reflection Qwen3-4B Q4_K_M | 12-25 s (raise `REFLECTION_TIMEOUT_MS`) | about 3.2 GB |

The SLM estimate uses memory-bandwidth-bound generation (15-25 tokens/s for
1.1 GB of weights) and 60-150 tokens/s prompt processing on 4 cores.
`cache_prompt` reuses the fixed system prompt. Measure on the NUC with
`apps/intuition/intuition_server.py bench` and `llama-bench`, and replace these
numbers.

## Not done / limits

- Not run on the NUC, not run with a real camera or the real arm.
- llama.cpp + Qwen3 not run (1.1 GB download): the reflection is tested with a
  mocked HTTP server only. lc0 + Maia not run (no package; build from source):
  tested with a fake UCI process.
- YOLO training not run (needs ultralytics + torch on a GPU node); the dataset
  capture and auto-labelling are tested on tiny synthetic images.
- `LearnedPolicyModel` is a stub. SLM fine-tuning is not implemented.
- With the default `/board` camera check the robot sees colours only: a wrong
  piece TYPE on the right square is not detected (`BRAIN_OBSERVER=observe` with
  a trained detector sees types).
- `apps/vision/vision/pieces.py` (`/detect`) is unchanged; the brain uses the
  new `/observe`.

## NUC bring-up: the brain

The steps are in [`docs/NUC-BRINGUP.md`](NUC-BRINGUP.md): install and check
the brain in section 4.1 (`deploy/brain/install-brain.sh`,
`robot-intuition.service` on 127.0.0.1:8095, `robot-reflection.service` on
127.0.0.1:8090), the first brain move on the simulated board in section 7, the
calibration with the wizard in sections 10-11, and a game on the board in
section 12. Then:

- **Train the detector** once a few games are logged:
  `apps/vision/training/README.md`, and set `VISION_OBSERVE_MODEL` and
  `BRAIN_OBSERVER=observe` when it is better than the occupancy check.

What the operator provides: the camera fixed over the board, the four ArUco
markers, a few hundred labelled frames (the capture script makes them from
played positions), and a GPU node for the YOLO fine-tune. No chess engine is
needed.
