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
export interface WebsocketOptions {
  /** Bind address. Default 127.0.0.1: Caddy is the only way in from the LAN. */
  host?: string;
  chess?: ChessSession;
}

export function startWebsocket(controller: RobotController, port: number, opts: WebsocketOptions = {}): WebSocketServer {
  const host = opts.host ?? "127.0.0.1";
  const wss = new WebSocketServer({ port, host, maxPayload: 256 * 1024 });
  const recorder = new TrajectoryRecorder();
  const chess = opts.chess ?? new ChessSession(controller);

  wss.on("connection", (ws: WebSocket) => {
    send(ws, robotInfo(controller));
    send(ws, stateMessage(controller));
    send(ws, chessMessage(chess));
    send(ws, loopMessage(chess));

    // Deadman: when the last twin disconnects, nobody watches the arm. Stop
    // and disable it; a person must enable it again after reconnecting.
    ws.on("close", () => {
      const open = [...wss.clients].filter((c) => c !== ws && c.readyState === 1).length;
      if (open === 0 && (controller.isEnabled || controller.isMoving)) {
        console.warn("[ws] last client disconnected: stopping and disabling the robot");
        controller.emergencyStop();
      }
    });

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
  chess.subscribe(() => {
    broadcast(chessMessage(chess));
    broadcast(loopMessage(chess));
  });

  wss.on("error", (err) => {
    console.error("[ws] error:", err);
  });

  console.log(`[ws] listening on ws://${host}:${port}`);
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
      if (!ok && controller.isEnabled) send(ws, { type: "error", message: "target not reachable (not executed)" });
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
    case "gripper": {
      if (recorder.isRecording) recorder.gripper(msg.open);
      const r = await controller.setGripper(msg.open);
      if (!r.ok) send(ws, { type: "error", message: `gripper: ${r.error ?? "failed"}` });
      break;
    }
    case "setEnabled":
      controller.setEnabled(msg.enabled);
      break;
    case "estop":
      controller.emergencyStop();
      break;
    case "home": {
      const r = await controller.home();
      if (!r.ok) send(ws, { type: "error", message: `home: ${r.error ?? "failed"}` });
      break;
    }
    case "recordStart":
      recorder.start();
      break;
    case "recordStop":
      send(ws, { type: "recorded", steps: recorder.stop() });
      break;
    case "replay": {
      const r = await replay(controller, msg.steps);
      if (!r.ok) send(ws, { type: "error", message: r.error ?? "replay failed" });
      break;
    }
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
    case "syncBoard": {
      const res = await chess.syncBoard();
      if (!res.ok) send(ws, { type: "error", message: res.error ?? "sync failed" });
      break;
    }
    case "robotMove": {
      const res = await chess.robotTurn();
      if (!res.ok) send(ws, { type: "error", message: res.error ?? "robot move failed" });
      break;
    }
    case "clearFault":
      chess.clearFault();
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

function loopMessage(chess: ChessSession): ServerMessage {
  const st = chess.loopStatus;
  return { type: "loop", ...st, decider: chess.deciderName };
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
