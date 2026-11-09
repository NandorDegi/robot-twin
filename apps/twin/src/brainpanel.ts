/**
 * Brain panel: shows the robot's loop (state, decision, rationale, self-check)
 * and lets the human answer when the robot stops and asks. Uses its own
 * WebSocket to the server so it stays independent of the main twin code.
 */

interface Ask {
  reason: string;
  message: string;
  hints: string[];
  options: string[];
  candidates?: { uci: string; san: string }[];
}

const OPTION_LABEL: Record<string, string> = {
  retry: "I fixed the board, look again",
  "accept-prediction": "The board is right, continue",
  "set-fen": "Set the true position (FEN)",
  "choose-move": "This is my move",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

export function mountBrainPanel(wsUrl: string): void {
  const box = el("div", {
    id: "brainPanel",
    style:
      "position:absolute;top:12px;right:12px;width:340px;max-height:calc(100vh - 280px);overflow-y:auto;" +
      "background:rgba(15,20,30,.88);border:1px solid #2a3140;border-radius:10px;padding:12px;font-size:12px;z-index:5",
  });
  box.append(el("h2", { style: "font-size:13px;margin:0 0 6px" }, "Robot brain"));
  const status = el("div", { style: "color:#9fb0c7;margin-bottom:6px" }, "not connected");
  const decision = el("div", { style: "margin:6px 0;white-space:pre-wrap" });
  const ask = el("div", { style: "display:none;border:1px solid #b3503a;border-radius:6px;padding:8px;margin:6px 0;background:#2a1612" });
  const logEl = el("div", { style: "color:#6f7d91;max-height:120px;overflow-y:auto;white-space:pre-wrap" });
  const controls = el("div", { class: "buttons" });
  const sim = el("div", { class: "buttons" });
  box.append(status, controls, decision, ask, sim, logEl);
  document.getElementById("app")?.append(box);

  let sock: WebSocket | null = null;
  const send = (msg: Record<string, unknown>) => sock?.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: "brain", ...msg }));
  const log = (line: string) => {
    logEl.textContent = `${line}\n${logEl.textContent ?? ""}`.slice(0, 4000);
  };
  const button = (parent: HTMLElement, label: string, fn: () => void, cls = "") => {
    const b = el("button", cls ? { class: cls } : {}, label);
    b.onclick = fn;
    parent.append(b);
    return b;
  };

  button(controls, "Start (robot = Black)", () => send({ cmd: "start", robotColor: "b" }), "primary");
  button(controls, "Start (robot = White)", () => send({ cmd: "start", robotColor: "w" }));
  button(controls, "Stop", () => send({ cmd: "stop" }), "warn");

  // Simulator helpers (BRAIN_OBSERVER=sim only): play the human's move, inject faults.
  const mv = el("input", { placeholder: "your move (e2e4)", size: "10" }) as HTMLInputElement;
  sim.append(mv);
  button(sim, "Play (sim)", () => send({ cmd: "simHuman", uci: mv.value.trim() }));
  button(sim, "Fault: miss grasp", () => send({ cmd: "simFault", fault: { kind: "miss-grasp" } }));
  button(sim, "Fault: drop", () => send({ cmd: "simFault", fault: { kind: "drop" } }));

  const showAsk = (a: Ask | null) => {
    ask.replaceChildren();
    if (!a) {
      ask.style.display = "none";
      return;
    }
    ask.style.display = "block";
    ask.append(el("div", { style: "font-weight:600;margin-bottom:4px" }, a.message));
    for (const h of a.hints) ask.append(el("div", { style: "color:#e0b0a0" }, `- ${h}`));
    const opts = el("div", { class: "buttons" });
    ask.append(opts);
    for (const o of a.options) {
      if (o === "set-fen") {
        const fen = el("input", { placeholder: "FEN", size: "28" }) as HTMLInputElement;
        opts.append(fen);
        button(opts, OPTION_LABEL[o]!, () => send({ cmd: "resolve", action: o, fen: fen.value.trim() }));
      } else if (o === "choose-move") {
        for (const c of a.candidates ?? []) button(opts, `${OPTION_LABEL[o]}: ${c.san}`, () => send({ cmd: "resolve", action: o, uci: c.uci }));
      } else {
        button(opts, OPTION_LABEL[o] ?? o, () => send({ cmd: "resolve", action: o }));
      }
    }
  };

  const onMessage = (msg: any) => {
    if (msg.type === "brainStatus") {
      const s = msg.status ?? {};
      status.textContent = `${s.running ? s.state : "stopped"} | brain ${s.brain || "-"} | eyes ${s.observer} | ${s.moves?.length ?? 0} moves`;
      showAsk(s.state === "halted" ? (s.question as Ask) : null);
      return;
    }
    if (msg.type !== "brain") return;
    const e = msg.event ?? {};
    switch (e.type) {
      case "state":
        status.textContent = `${e.state} | ${e.turn === "w" ? "White" : "Black"} to move`;
        if (e.state !== "halted") showAsk(null);
        break;
      case "decision": {
        const d = e.decision;
        const cands = (d.candidates ?? []).map((c: any) => `${c.san} ${(c.prob * 100).toFixed(0)}%`).join(", ");
        decision.textContent = `I play ${d.san} (${d.brain}, ${d.elapsedMs} ms)\n${d.rationale}${cands ? `\nintuition: ${cands}` : ""}`;
        break;
      }
      case "verified":
        log(`verified ${e.san}${e.uncertain?.length ? ` (unsure: ${e.uncertain.join(" ")})` : ""}`);
        break;
      case "human-move":
        log(`you played ${e.san}`);
        break;
      case "ask-human":
        showAsk(e.ask as Ask);
        log(`STOPPED: ${e.ask.reason}`);
        break;
      case "commentary":
        log(`comment: ${e.text}`);
        break;
      case "game-over":
        log(`game over ${e.result}`);
        break;
      case "error":
        log(`error: ${e.message}`);
        break;
    }
  };

  let retry = 0;
  const open = () => {
    sock = new WebSocket(wsUrl);
    sock.onopen = () => {
      retry = 0;
      send({ cmd: "status" });
    };
    sock.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    sock.onclose = () => setTimeout(open, Math.min(500 * 2 ** retry++, 5000));
  };
  open();
}
