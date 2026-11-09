import type { ClientMessage, RecordedStep } from "@robot/protocol";
import { useTwin } from "./store";

/** Extra listeners for server messages (the Calibrate wizard). */
export const serverMessageListeners = new Set<(msg: any) => void>();

export interface TwinSocket {
  send(msg: ClientMessage): void;
  close(): void;
}

/**
 * Connect to the robot server over WebSocket. On server messages, update the
 * twin store (joint state, gripper, enable, robot info). Sends client commands
 * to move the arm.
 */
export function connect(
  url: string,
  onTargetResult?: (ok: boolean, error: number) => void,
): TwinSocket {
  let sock: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const open = () => {
    if (closed) return;
    sock = new WebSocket(url);
    sock.onopen = () => {
      retry = 0;
      useTwin.getState().setState({ connected: true });
    };
    sock.onclose = () => {
      useTwin.getState().setState({ connected: false });
      if (!closed) {
        // Reconnect with backoff so a server restart re-syncs the twin.
        setTimeout(open, Math.min(500 * 2 ** retry++, 5000));
      }
    };
    sock.onerror = () => {
      useTwin.getState().setState({ connected: false });
    };
    sock.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      applyServerMessage(msg, onTargetResult);
      for (const fn of serverMessageListeners) fn(msg);
    };
  };
  open();

  return {
    send(msg) {
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify(msg));
      }
    },
    close() {
      closed = true;
      sock?.close();
    },
  };
}

function applyServerMessage(msg: any, onTargetResult?: (ok: boolean, error: number) => void): void {
  const s = useTwin.getState();
  switch (msg.type) {
    case "state":
      s.setState({
        q: Array.isArray(msg.q) ? msg.q : s.q,
        gripperOpen: Boolean(msg.gripperOpen),
        enabled: Boolean(msg.enabled),
        mode: msg.mode ?? s.mode,
        everReal: s.everReal || (typeof msg.mode === "string" && (msg.mode.startsWith("real") || msg.mode.startsWith("fault"))),
      });
      break;
    case "robot":
      s.setState({ jointInfo: Array.isArray(msg.joints) ? msg.joints : s.jointInfo });
      break;
    case "target":
      if (onTargetResult && msg && typeof msg.success === "boolean") {
        onTargetResult(msg.success, Number(msg.error ?? 0));
      }
      break;
    case "recorded":
      s.setState({ lastRecorded: Array.isArray(msg.steps) ? (msg.steps as RecordedStep[]) : [] });
      break;
    case "chess":
      s.setState({
        fen: typeof msg.fen === "string" ? msg.fen : s.fen,
        turn: typeof msg.turn === "string" ? msg.turn : s.turn,
        lastSan: typeof msg.lastSan === "string" ? msg.lastSan : s.lastSan,
        check: Boolean(msg.check),
        opponentEnabled: Boolean(msg.opponentEnabled),
        elo: Number(msg.elo ?? s.elo),
        lastError: "",
      });
      break;
    case "loop":
      s.setState({
        loopStage: String(msg.stage ?? ""),
        loopMessage: String(msg.message ?? ""),
        loopMismatches: Array.isArray(msg.mismatches) ? msg.mismatches.map(String) : [],
        decider: String(msg.decider ?? ""),
      });
      break;
    case "error":
      s.setState({ lastError: String(msg.message ?? "error") });
      console.warn("[robot] server error:", msg.message);
      break;
  }
}
