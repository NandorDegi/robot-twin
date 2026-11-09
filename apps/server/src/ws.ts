import { WebSocketServer, type WebSocket } from "ws";
import { clientMessageSchema } from "@robot/protocol";
import type { ClientMessage, ServerMessage } from "@robot/protocol";
import type { RobotController } from "./controller";
import { TrajectoryRecorder, replay } from "./record";
import { ChessSession } from "./chess";

/**
 * WebSocket bridge between the browser twin and the RobotController.
 * Client messages are validated with zod; the server pushes state updates.
 */
export function startWebsocket(controller: RobotController, port: number): WebSocketServer {
  const wss = new WebSocketServer({ port, host: "0.0.0.0" });
  const recorder = new TrajectoryRecorder();
  const chess = new ChessSession(controller);

  wss.on("connection", (ws: WebSocket) => {
    send(ws, robotInfo(controller));
    send(ws, stateMessage(controller));
    send(ws, chessMessage(chess));

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send(ws, { type: "error", message: "invalid JSON" });
        return;
      }
      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) {
        send(ws, { type: "error", message: result.error.message });
        return;
      }
      void handle(controller, ws, result.data, recorder, chess);
    });
  });

  // Broadcast state changes and chess state to all connected clients.
  const broadcast = (msg: ServerMessage) => {
    for (const client of wss.clients) {
      if (client.readyState === 1) send(client, msg);
    }
  };
  controller.subscribe(() => broadcast(stateMessage(controller)));
  chess.subscribe(() => broadcast(chessMessage(chess)));

  wss.on("error", (err) => {
    console.error("[ws] error:", err);
  });

  console.log(`[ws] listening on ws://0.0.0.0:${port}`);
  return wss;
}

async function handle(
  controller: RobotController,
  ws: WebSocket,
  msg: ClientMessage,
  recorder: TrajectoryRecorder,
  chess: ChessSession,
): Promise<void> {
  switch (msg.type) {
    case "setTarget": {
      const ok = await controller.setTarget(msg.target.position, msg.target.orientation);
      if (recorder.isRecording) recorder.target(msg.target.position);
      send(ws, {
        type: "target",
        position: msg.target.position,
        reached: ok,
        error: ok ? 0 : controller.targetError,
        success: ok,
      });
      break;
    }
    case "setJointState": {
      const rejected = await controller.setJointState(msg.q);
      if (rejected) send(ws, { type: "error", message: `joint state rejected: ${rejected}` });
      break;
    }
    case "gripper":
      if (recorder.isRecording) recorder.gripper(msg.open);
      await controller.setGripper(msg.open);
      break;
    case "setEnabled":
      controller.setEnabled(msg.enabled);
      break;
    case "estop":
      controller.emergencyStop();
      break;
    case "home":
      await controller.home();
      break;
    case "recordStart":
      recorder.start();
      break;
    case "recordStop":
      send(ws, { type: "recorded", steps: recorder.stop() });
      break;
    case "replay":
      await replay(controller, msg.steps);
      break;
    case "playSan": {
      const res = await chess.playSan(msg.san);
      if (!res.ok) send(ws, { type: "error", message: res.error ?? "invalid move" });
      break;
    }
    case "setOpponent":
      chess.setOpponent(msg.enabled, msg.elo);
      break;
    case "resetGame":
      chess.reset();
      break;
  }
}

function stateMessage(controller: RobotController): ServerMessage {
  return {
    type: "state",
    q: controller.state,
    gripperOpen: controller.gripOpen,
    enabled: controller.isEnabled,
    mode: controller.mode_,
  };
}

function chessMessage(chess: ChessSession): ServerMessage {
  return {
    type: "chess",
    fen: chess.fen,
    turn: chess.turn,
    lastSan: chess.moveHistoryLast,
    check: chess.inCheck,
    opponentEnabled: chess.opponentEnabled,
    elo: chess.eloLevel,
  };
}

function robotInfo(controller: RobotController): ServerMessage {
  return {
    type: "robot",
    name: controller.chain.name,
    joints: controller.chain.joints.map((j) => ({
      name: j.name,
      minDeg: (Math.min(j.min, j.max) * 180) / Math.PI,
      maxDeg: (Math.max(j.min, j.max) * 180) / Math.PI,
    })),
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(msg));
}
