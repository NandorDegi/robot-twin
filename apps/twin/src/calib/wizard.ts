/**
 * Calibrate: a guided wizard for the board perception (route #calibrate).
 *
 *  1 Camera       pick the camera and resolution, lock exposure / white balance / focus, live quality
 *  2 Board        detect markers or the grid (or click a1, h1, h8, a8), reprojection error, orientation
 *  3 Reference    average N frames of the empty board, per-square brightness, glare/shadow warnings
 *  4 Detection    start position, per-square result + confidence, auto-tune, sliders, move test
 *  5 Robot frame  touch-off above a1/h1/h8 (operator buttons only) or manual entry, residual, reach
 *  6 Save         versioned file, live reload, final check (32/32 + reachability), rollback
 *
 * Each step can be redone. Only step 5 (and the observe-pose button) moves the
 * arm, and only when the operator presses a button with the robot enabled.
 */
import { applyMove, inferMove, initialPosition, moveToSan, occupancyOf, type Occupancy, type Position } from "@robot/chess";
import { baseToTwin, setBoardPose, twinToBase, type Vec3 } from "@robot/chess";
import type { KinematicChain } from "@robot/kinematics";
import type { CalibClientMessage, ClientMessage, WireFit } from "@robot/protocol";
import { api, VISION } from "./api";
import { LocalDriver, ServerDriver, tcpOf, type RobotDriver } from "./robot";
import { CALIB_CSS } from "./style";
import { useTwin } from "../store";
import { serverMessageListeners } from "../net";
import type { LocalSim } from "../localsim";

type VState = Awaited<ReturnType<typeof api.state>>;
type Camera = Awaited<ReturnType<typeof api.camera>>;
type Metrics = Awaited<ReturnType<typeof api.metrics>>;
type RefStats = Awaited<ReturnType<typeof api.reference>>;
type Squares = Awaited<ReturnType<typeof api.squares>>;
type Versions = Awaited<ReturnType<typeof api.versions>>;

interface CalibStatusMsg {
  required: boolean;
  valid: boolean;
  reasons: string[];
  revision: number | null;
  file: string;
  boardPose: { origin: Vec3; rotationDeg: number; square: number } | null;
  validation: any;
}

export interface CalibrationMountOptions {
  chain: KinematicChain;
  localSim: LocalSim;
  send: (m: ClientMessage) => void;
}

const STEPS = ["Camera", "Board", "Reference", "Detection", "Robot frame", "Save"];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) (el as any)[k] = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null) el.append(c);
  return el;
}
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(d));
const fmtV = (v: Vec3 | undefined, d = 1) => (v ? v.map((x) => x.toFixed(d)).join(", ") : "–");

export function mountCalibration(opts: CalibrationMountOptions): void {
  const style = document.createElement("style");
  style.textContent = CALIB_CSS;
  document.head.append(style);

  // ---- state ----------------------------------------------------------------
  const S = {
    open: false,
    step: 1,
    vs: null as VState | null,
    cam: null as Camera | null,
    metrics: null as Metrics | null,
    ref: null as RefStats | null,
    squares: null as Squares | null,
    tune: null as any,
    versions: null as Versions | null,
    clickMode: false,
    clicks: [] as [number, number][],
    pickA1: false,
    status: null as CalibStatusMsg | null,
    msg: "",
    msgKind: "",
    busy: false,
    liveDetect: true,
    test: { pos: initialPosition() as Position, moves: [] as string[], last: "" },
    allowReal: false,
    hover: 20,
    jogStep: 5,
    useFittedSquare: false,
    lastFit: null as WireFit | null,
    validation: null as any,
  };

  const server = new ServerDriver((m) => opts.send(m as ClientMessage));
  const local = new LocalDriver(opts.chain, opts.localSim, () => refreshSide());
  const driver = (): RobotDriver => (useTwin.getState().connected ? server : local);

  serverMessageListeners.add((msg) => {
    if (server.onMessage(msg)) refreshSide();
    else if (msg?.type === "calibStatus") {
      S.status = msg as CalibStatusMsg;
      // The twin uses the saved board pose too (targets, the local sim driver).
      if (S.status.boardPose) {
        try {
          setBoardPose(S.status.boardPose);
        } catch {
          /* invalid pose: keep the current one */
        }
      }
      gateBanner();
      refreshSide();
    } else if (msg?.type === "error" && typeof msg.message === "string" && msg.message.startsWith("calibration:") && S.open) {
      say(msg.message, "bad");
    }
  });

  // ---- shell ------------------------------------------------------------------
  const stepsEl = h("div", { class: "steps" });
  const closeBtn = h("button", { id: "calibClose", onclick: () => setOpen(false) }, "Close");
  const img = h("img", { alt: "camera" });
  const canvas = h("canvas");
  const camBox = h("div", { class: "cam", style: "aspect-ratio: 16 / 9" }, img, canvas);
  const topImg = h("img", { alt: "top-down" });
  const topBox = h("div", { class: "topdown" }, topImg, h("div", { class: "hint", id: "calibTopHint" }, "Top-down view with the current draft: a8 is top-left, a1 bottom-left."));
  const view = h("div", { class: "view" }, camBox, topBox);
  const side = h("div", { class: "side", id: "calibSide" });
  const panel = h(
    "div",
    { id: "calibPanel" },
    h("header", {}, h("h1", {}, "Calibrate"), stepsEl, closeBtn),
    h("div", { class: "body" }, view, side),
  );
  document.getElementById("app")!.append(panel);

  // Button in the main panel + the loop-gate banner in the chess section.
  const openBtn = h("button", { id: "btnCalibrate", class: "primary", onclick: () => setOpen(true), title: "Board perception calibration wizard" }, "Calibrate");
  document.getElementById("status")?.after(h("div", { class: "buttons" }, openBtn));
  const gate = h("div", { id: "calibGate" });
  document.getElementById("chessStatus")?.after(gate);
  function gateBanner(): void {
    const st = S.status;
    if (!st) return;
    if (st.required && !st.valid) {
      gate.className = "blocked";
      gate.textContent = `Chess loop blocked: no valid calibration (${st.reasons.join("; ")}). Open Calibrate.`;
    } else if (st.valid) {
      gate.className = "ok";
      gate.textContent = `Calibration r${st.revision} valid.`;
    } else {
      gate.className = "";
    }
  }

  function setOpen(v: boolean): void {
    S.open = v;
    panel.classList.toggle("open", v);
    const feed = document.getElementById("feed");
    if (feed) feed.style.display = v ? "none" : "";
    if (v) {
      img.src = `${VISION}/stream`;
      if (location.hash !== "#calibrate") history.replaceState(null, "", "#calibrate");
      void poll();
      go(S.step);
    } else {
      img.src = "";
      if (location.hash === "#calibrate") history.replaceState(null, "", location.pathname + location.search);
    }
  }
  window.addEventListener("hashchange", () => setOpen(location.hash === "#calibrate"));

  function stepDone(i: number): boolean {
    const d = S.vs?.draft;
    switch (i) {
      case 1:
        return Boolean(S.cam);
      case 2:
        return Boolean(d?.confirmed);
      case 3:
        return Boolean(d?.has_reference);
      case 4:
        return Boolean(S.tune && S.tune.correct === 64) || Boolean(S.squares && score(S.squares.squares).correct === 64);
      case 5:
        return Boolean(driver().state().fit);
      case 6:
        return Boolean(S.status?.valid);
    }
    return false;
  }

  function renderSteps(): void {
    stepsEl.innerHTML = "";
    STEPS.forEach((name, i) => {
      const n = i + 1;
      stepsEl.append(h("button", { id: `calibStep${n}`, class: `${n === S.step ? "active" : ""} ${stepDone(n) ? "done" : ""}`, onclick: () => go(n) }, `${n} ${name}`));
    });
  }

  function say(m: string, kind = ""): void {
    S.msg = m;
    S.msgKind = kind;
    const el = document.getElementById("calibMsg");
    if (el) {
      el.textContent = m;
      el.className = `msg ${kind}`;
    }
  }

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    if (S.busy) return;
    S.busy = true;
    say(`${label}...`);
    try {
      await fn();
      if (S.msg === `${label}...`) say(`${label}: done`, "good");
    } catch (err) {
      say(`${label}: ${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      S.busy = false;
      await poll();
      refreshSide();
    }
  }

  // ---- polling ---------------------------------------------------------------
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  async function poll(): Promise<void> {
    if (pollTimer) clearTimeout(pollTimer);
    if (!S.open) return;
    try {
      S.vs = await api.state();
      const ar = S.vs.frame.width / S.vs.frame.height;
      camBox.style.aspectRatio = `${S.vs.frame.width} / ${S.vs.frame.height}`;
      if (!Number.isFinite(ar)) camBox.style.aspectRatio = "16 / 9";
      if (S.step === 1) S.metrics = await api.metrics();
      if (S.step === 4 && S.liveDetect && S.vs.draft.has_reference && S.vs.draft.overlay && !S.busy) S.squares = await api.squares();
    } catch (err) {
      if (S.step !== 5) say(`vision: ${err instanceof Error ? err.message : String(err)}`, "bad");
    }
    refreshSide();
    pollTimer = setTimeout(() => void poll(), S.step === 4 ? 1500 : 1000);
  }

  // ---- overlay ---------------------------------------------------------------------
  function frameSize() {
    return S.vs?.frame ?? { width: 1280, height: 720 };
  }
  function draw(): void {
    requestAnimationFrame(draw);
    if (!S.open) return;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
    }
    const g = canvas.getContext("2d")!;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const fs = frameSize();
    const k = canvas.width / fs.width;
    const P = (p: number[]) => [p[0]! * k, p[1]! * k] as const;
    const d = S.vs?.draft;
    if (d?.overlay && !S.clickMode) {
      g.strokeStyle = "rgba(0,200,255,0.8)";
      g.lineWidth = 1;
      for (const [a, b] of d.overlay.lines) {
        g.beginPath();
        g.moveTo(...P(a));
        g.lineTo(...P(b));
        g.stroke();
      }
      // White side: the a1-h1 edge, thick.
      const c = d.overlay.corners;
      if (c.a1 && c.h1) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(...P(c.a1));
        g.lineTo(...P(c.h1));
        g.stroke();
      }
      g.font = "bold 14px system-ui";
      for (const [name, p] of Object.entries(c)) {
        const [x, y] = P(p);
        g.fillStyle = name === "a1" ? "#39c66b" : "#f2b84b";
        g.beginPath();
        g.arc(x, y, 6, 0, Math.PI * 2);
        g.fill();
        g.fillText(name, x + 8, y - 8);
      }
      if (S.step === 2 || S.step === 3) {
        g.font = "11px system-ui";
        g.fillStyle = "rgba(255,200,80,0.9)";
        for (const [name, p] of Object.entries(d.overlay.centres)) {
          const [x, y] = P(p);
          const flag = S.step === 3 && S.ref?.squares[name]?.flags.length;
          if (S.step === 2 || flag) {
            g.fillStyle = flag ? "#ff6b6b" : "rgba(255,200,80,0.9)";
            g.fillText(name, x - 7, y + 4);
          }
        }
      }
      if (S.step === 4 && S.squares) {
        const exp = expectedNow();
        for (const [name, p] of Object.entries(d.overlay.centres)) {
          const st = S.squares.squares[name];
          const det = S.squares.details[name];
          const [x, y] = P(p);
          const wrong = exp && exp[name] !== st;
          if (st) {
            g.fillStyle = st === "w" ? "rgba(255,255,255,0.85)" : "rgba(20,20,20,0.85)";
            g.beginPath();
            g.arc(x, y, 9, 0, Math.PI * 2);
            g.fill();
          }
          g.strokeStyle = wrong ? "#ff3b3b" : det && det.confidence < 0.3 ? "#f2b84b" : "rgba(57,198,107,0.9)";
          g.lineWidth = wrong ? 3 : 2;
          g.beginPath();
          g.arc(x, y, 11, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }
    if (S.pickA1 && d?.raw_corners) {
      for (const p of d.raw_corners) {
        const [x, y] = P(p);
        g.strokeStyle = "#39c66b";
        g.lineWidth = 3;
        g.beginPath();
        g.arc(x, y, 16, 0, Math.PI * 2);
        g.stroke();
      }
    }
    if (S.clickMode) {
      const names = ["a1", "h1", "h8", "a8"];
      g.font = "bold 14px system-ui";
      S.clicks.forEach((p, i) => {
        const [x, y] = P(p);
        g.fillStyle = "#39c66b";
        g.beginPath();
        g.arc(x, y, 6, 0, Math.PI * 2);
        g.fill();
        g.fillText(names[i]!, x + 8, y - 8);
        if (i > 0) {
          const [px, py] = P(S.clicks[i - 1]!);
          g.strokeStyle = "#39c66b";
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(x, y);
          g.stroke();
        }
      });
      g.fillStyle = "rgba(0,0,0,0.6)";
      g.fillRect(8, 8, 330, 26);
      g.fillStyle = "#fff";
      g.fillText(`Click the outer corner of ${names[S.clicks.length] ?? "-"} (${S.clicks.length + 1}/4)`, 16, 26);
    }
  }
  requestAnimationFrame(draw);

  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const fs = frameSize();
    const x = ((ev.clientX - rect.left) / rect.width) * fs.width;
    const y = ((ev.clientY - rect.top) / rect.height) * fs.height;
    if (S.clickMode) {
      S.clicks.push([x, y]);
      if (S.clicks.length === 4) {
        S.clickMode = false;
        const pts = S.clicks.slice();
        S.clicks = [];
        const mirrored = (document.getElementById("calibMirrored") as HTMLInputElement | null)?.checked ?? false;
        void run("Fit from the 4 clicked corners", async () => {
          await api.corners(pts, mirrored);
        });
      }
      return;
    }
    if (S.pickA1 && S.vs?.draft.raw_corners) {
      const raw = S.vs.draft.raw_corners;
      let best = 0;
      raw.forEach((p, i) => {
        if (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(raw[best]![0] - x, raw[best]![1] - y)) best = i;
      });
      S.pickA1 = false;
      void run("Set the a1 corner", () => api.orientation({ a1_index: best }));
    }
  });

  // ---- step pages ----------------------------------------------------------------
  let page: { update: () => void } = { update: () => {} };

  function go(n: number): void {
    S.step = n;
    S.clickMode = false;
    S.pickA1 = false;
    side.innerHTML = "";
    const builders = [stepCamera, stepBoard, stepReference, stepDetection, stepRobot, stepSave];
    page = builders[n - 1]!();
    side.append(h("div", { id: "calibMsg", class: `msg ${S.msgKind}` }, S.msg));
    topBox.style.display = n >= 2 && n <= 4 ? "" : "none";
    refreshTop();
    renderSteps();
    page.update();
    void poll();
  }

  function refreshSide(): void {
    if (!S.open) return;
    renderSteps();
    page.update();
  }

  function refreshTop(): void {
    if (!S.vs?.draft.overlay) {
      topImg.removeAttribute("src");
      return;
    }
    topImg.src = `${VISION}/calib/topdown.jpg?src=${S.step === 3 && S.vs.draft.has_reference ? "reference" : "frame"}&t=${Date.now()}`;
  }

  const btn = (id: string, label: string, onclick: () => void, cls = "") => h("button", { id, class: cls, onclick }, label);

  // 1 -------------------------------------------------------------------------
  function stepCamera() {
    const camSel = h("select", { id: "calibCamSel" });
    const resSel = h("select", { id: "calibResSel" });
    const locks = h("div");
    const meters = h("div", { class: "kv" });
    const warns = h("div", { class: "warn" });
    const sim = h("div");
    side.append(
      h("h2", {}, "1. Camera"),
      h("div", { class: "guide" }, "Choose the overhead camera and its resolution. Lock exposure, white balance and focus when the image looks right, so the light does not drift between the reference and a game."),
      h("div", { class: "row" }, h("label", {}, "Camera"), camSel),
      h("div", { class: "row" }, h("label", {}, "Resolution"), resSel, btn("calibCamApply", "Apply", () => void run("Apply camera", applyCam))),
      h("h3", {}, "Locks (UVC, if the camera supports them)"),
      locks,
      h("h3", {}, "Live image quality"),
      meters,
      warns,
      sim,
    );
    async function applyCam() {
      const [w, hh] = resSel.value.split("x").map(Number);
      const index = camSel.value === "synthetic" ? "synthetic" : Number(camSel.value);
      S.cam = await api.setCamera({ index, width: w, height: hh });
    }
    void api.camera().then((c) => {
      S.cam = c;
      camSel.innerHTML = "";
      const cams = c.cameras.length ? c.cameras : [{ index: c.source, device: "", name: "current" }];
      for (const x of cams) camSel.append(h("option", { value: String(x.index), selected: String(x.index) === String(c.source) }, typeof x.index === "number" ? `${x.index}: ${x.name || x.device}` : x.name));
      resSel.innerHTML = "";
      for (const [w, hh] of c.resolutions) resSel.append(h("option", { value: `${w}x${hh}`, selected: w === c.width && hh === c.height }, `${w} x ${hh}`));
      locks.innerHTML = "";
      const lockRow = (what: "exposure" | "white_balance" | "focus", auto: string, val: string, label: string) => {
        const supported = c.controls[auto] !== null && c.controls[auto] !== undefined;
        const locked = what === "exposure" ? c.controls[auto] === 1 : c.controls[auto] === 0;
        const chk = h("input", { type: "checkbox", id: `calibLock_${what}`, checked: locked, disabled: !supported });
        chk.onchange = () => void run(`${chk.checked ? "Lock" : "Unlock"} ${label}`, async () => {
          S.cam = await api.setCamera({ lock: { [what]: chk.checked } });
        });
        const num = h("input", { type: "number", value: c.controls[val] ?? "", disabled: c.controls[val] === null || c.controls[val] === undefined, step: "1" });
        num.onchange = () => void run(`Set ${val}`, async () => {
          S.cam = await api.setCamera({ controls: { [val]: Number(num.value) } });
        });
        locks.append(h("div", { class: "row" }, h("label", {}, label), chk, h("span", { class: "hint" }, supported ? "lock" : "not supported"), num));
      };
      lockRow("exposure", "auto_exposure", "exposure", "Exposure");
      lockRow("white_balance", "auto_wb", "wb_temperature", "White balance");
      lockRow("focus", "autofocus", "focus", "Focus");
      sim.innerHTML = "";
      if (c.synthetic) sim.append(simScene());
    }).catch((e) => say(`camera: ${String(e.message ?? e)}`, "bad"));
    return {
      update() {
        const m = S.metrics;
        meters.innerHTML = "";
        if (!m) return;
        const bar = (v: number, max: number, ok: boolean) => h("div", { class: "bar" }, h("div", { style: `width:${Math.min(100, (v / max) * 100)}%;background:${ok ? "#3a6bcf" : "#b3503a"}` }));
        meters.append(
          h("span", {}, "Brightness"), h("div", { class: "row", style: "margin:0" }, bar(m.brightness, 255, m.brightness >= 60 && m.brightness <= 200), h("span", { id: "calibBright" }, fmt(m.brightness, 0))),
          h("span", {}, "Focus (sharpness)"), h("div", { class: "row", style: "margin:0" }, bar(Math.min(m.focus, 600), 600, m.focus >= 60), h("span", { id: "calibFocus" }, `${fmt(m.focus, 0)} ${m.focus >= 60 ? "sharp" : "blurred"}`)),
          h("span", {}, "Clipped (glare)"), h("span", {}, `${fmt(m.clipped * 100, 2)} %`),
          h("span", {}, "Frame"), h("span", {}, `${m.width} x ${m.height}${m.board_roi ? " (measured on the board)" : ""}`),
        );
        warns.textContent = m.warnings.join(" · ");
      },
    };
  }

  function simScene(): HTMLElement {
    const s = (label: string, body: unknown, id: string) => btn(id, label, () => void run(`Synthetic scene: ${label}`, () => api.scene(body)));
    return h(
      "div",
      { class: "guide", style: "border-left-color:#8a6d3b" },
      h("b", {}, "Synthetic camera (dev only): "),
      h("div", { class: "buttons" },
        s("Empty board", { preset: "empty" }, "simEmpty"),
        s("Start position", { preset: "start" }, "simStart"),
        s("Markers on", { markers: true }, "simMarkersOn"),
        s("Markers off", { markers: false }, "simMarkersOff"),
        s("Glare on", { glare: true }, "simGlareOn"),
        s("Glare off", { glare: false, shadow: false }, "simGlareOff"),
        s("Play e2-e4", { moves: [["e2", "e4"]] }, "simE4"),
        s("Play e7-e5", { moves: [["e7", "e5"]] }, "simE5"),
      ),
    );
  }

  // 2 -------------------------------------------------------------------------
  function stepBoard() {
    const info = h("div", { class: "kv" });
    const notes = h("div", { class: "warn" });
    const mirrored = h("input", { type: "checkbox", id: "calibMirrored" });
    mirrored.onchange = () => void run("Camera mirroring", () => api.orientation({ mirrored_camera: mirrored.checked }));
    side.append(
      h("h2", {}, "2. Board geometry"),
      h("div", { class: "guide" }, "Show the board with the 4 ArUco markers (DICT_4X4_50, ids 0-3, centre on the outer corners: 0 = a8, 1 = h8, 2 = a1, 3 = h1) or an empty board. Press Detect. If that fails, click the 4 outer corners yourself."),
      h("div", { class: "buttons" },
        btn("calibDetect", "Detect automatically", () => void run("Detect the board", () => api.detect("auto")), "primary"),
        btn("calibDetectAruco", "ArUco only", () => void run("Detect ArUco markers", () => api.detect("aruco"))),
        btn("calibDetectGrid", "Grid only", () => void run("Detect the grid", () => api.detect("chessboard"))),
        btn("calibClick", "Click 4 corners", () => {
          S.clickMode = true;
          S.clicks = [];
          say("Click a1, then h1, h8, a8 (the outer corners, counterclockwise on the screen).");
        }),
      ),
      h("label", { class: "row", style: "cursor:pointer" }, mirrored, h("span", {}, "The camera image is mirrored (only for a mirror setting of the camera)")),
      h("h3", {}, "Result"),
      info,
      notes,
      S.vs?.synthetic ? simScene() : "",
      h("h3", {}, "Orientation (fixes the rank/file mapping)"),
      h("div", { class: "guide" }, "Check the overlay: the green dot must be a1 and the thick white edge must be rank 1 (the White side). a1 is a dark square. If not, pick the a1 corner on the image."),
      h("div", { class: "buttons" },
        btn("calibPickA1", "Pick the a1 corner on the image", () => {
          S.pickA1 = true;
          say("Click the corner that is a1.");
        }),
        btn("calibRotate", "Next corner as a1", () => void run("Rotate", () => api.orientation({ a1_index: ((S.vs?.draft.a1_index ?? 0) + 1) % 4 }))),
        btn("calibConfirm", "Confirm orientation", () => void run("Confirm the orientation", () => api.orientation({ confirm: true })), "primary"),
      ),
    );
    return {
      update() {
        const d = S.vs?.draft;
        mirrored.checked = Boolean(d?.mirrored_camera);
        info.innerHTML = "";
        if (!d) return;
        const ge = d.grid_error;
        info.append(
          h("span", {}, "Method"), h("span", { id: "calibMethod" }, d.method ?? "– (not detected yet)"),
          h("span", {}, "Markers seen"), h("span", {}, d.markers.map((m) => m.id).join(", ") || "–"),
          h("span", {}, "Reprojection error"), h("span", { id: "calibReproj", class: ge && ge.mean_px !== null && ge.mean_px < 1.5 ? "good" : "warn" },
            ge ? `${fmt(ge.mean_px, 2)} px mean, ${fmt(ge.max_px, 2)} px max (${ge.points}/49 grid corners, ${fmt(ge.mean_mm ?? null, 2)} mm)` : "–"),
          h("span", {}, "a1 is dark"), h("span", { id: "calibA1Dark", class: d.a1_dark === false ? "bad" : d.a1_dark ? "good" : "" }, d.a1_dark === null ? "–" : d.a1_dark ? "yes" : "NO: choose another a1 corner"),
          h("span", {}, "Orientation"), h("span", { id: "calibConfirmed", class: d.confirmed ? "good" : "warn" }, d.confirmed ? "confirmed" : "not confirmed"),
        );
        notes.textContent = d.notes.join(" · ");
        refreshTopThrottled();
      },
    };
  }
  let lastTop = 0;
  function refreshTopThrottled(): void {
    if (Date.now() - lastTop > 2500) {
      lastTop = Date.now();
      refreshTop();
    }
  }

  // 3 -------------------------------------------------------------------------
  function stepReference() {
    const frames = h("input", { type: "number", id: "calibFrames", value: "10", min: "1", max: "60" });
    const stats = h("div");
    side.append(
      h("h2", {}, "3. Empty-board reference"),
      h("div", { class: "guide" }, "Remove all pieces and the markers. Put the arm in the observe pose (out of the camera view). Keep the light as it will be during a game. Then capture."),
      h("div", { class: "buttons" }, btn("calibObserve", "Move arm to observe pose", () => robotCmd({ type: "calibObservePose" }))),
      h("div", { class: "row" }, h("label", {}, "Frames to average"), frames, btn("calibCapture", "Capture reference", () => void run("Capture the reference", async () => {
        S.ref = await api.captureReference(Number(frames.value) || 10);
        lastTop = 0;
      }), "primary")),
      S.vs?.synthetic ? simScene() : "",
      stats,
    );
    if (S.vs?.draft.has_reference && !S.ref) void api.reference().then((r) => { S.ref = r; refreshSide(); }).catch(() => {});
    return {
      update() {
        stats.innerHTML = "";
        const r = S.ref;
        if (!r) return;
        stats.append(
          h("div", { class: "kv" },
            h("span", {}, "Frames"), h("span", {}, String(r.frames)),
            h("span", {}, "Light / dark squares"), h("span", {}, `${fmt(r.light_median, 0)} / ${fmt(r.dark_median, 0)} grey`),
            h("span", {}, "Contrast"), h("span", { class: r.contrast >= 30 ? "good" : "bad" }, fmt(r.contrast, 0)),
          ),
          h("div", { id: "calibRefWarn", class: r.warnings.length ? "warn" : "good" }, r.warnings.length ? r.warnings.join(" · ") : "No glare, shadow or noise found."),
          h("h3", {}, "Per square: mean brightness / variation (std)"),
          miniBoard((sq) => {
            const e = r.squares[sq]!;
            const v = Math.round(e.mean);
            return { html: `<span style="font-size:9px;color:${v > 128 ? "#000" : "#fff"}">${v}<br>${fmt(e.std, 0)}</span>`, style: `background:rgb(${v},${v},${v})`, cls: e.flags.length ? "flag" : "", title: `${sq}: mean ${e.mean}, std ${e.std}, temporal ${e.temporal_std ?? "-"}${e.flags.length ? ", " + e.flags.join(", ") : ""}` };
          }),
        );
        refreshTopThrottled();
      },
    };
  }

  // 4 -------------------------------------------------------------------------
  function expectedNow(): Occupancy | null {
    return occupancyOf(S.test.pos);
  }
  function score(obs: Record<string, string | null>) {
    const exp = expectedNow()!;
    const errs = Object.keys(exp).filter((k) => exp[k] !== (obs[k] ?? null));
    const pieces = Object.keys(exp).filter((k) => exp[k]);
    return { correct: 64 - errs.length, errs, pieces: pieces.filter((k) => exp[k] === obs[k]).length, piecesTotal: pieces.length };
  }

  function stepDetection() {
    const summary = h("div");
    const board = h("div");
    const sliders = h("div");
    const live = h("input", { type: "checkbox", checked: S.liveDetect, id: "calibLive" });
    live.onchange = () => (S.liveDetect = live.checked);
    const testOut = h("div", { id: "calibTestOut" });
    const mkSlider = (key: "diff" | "occupied_fraction" | "white", label: string, min: number, max: number, step: number) => {
      const r = h("input", { type: "range", min, max, step, id: `calibTh_${key}` });
      const v = h("span", { class: "val" });
      r.oninput = () => (v.textContent = r.value);
      r.onchange = () => void run(`Set ${label}`, async () => {
        await api.thresholds({ [key]: Number(r.value) });
        S.tune = null;
      });
      sliders.append(h("div", { class: "row" }, h("label", {}, label), r, v));
      return { r, v };
    };
    side.append(
      h("h2", {}, "4. Occupancy and colour"),
      h("div", { class: "guide" }, "Set up the start position (White on ranks 1-2). The mini board shows what the camera reads; red = differs from the expected position, orange = low confidence. Press Auto-tune, then adjust by hand if needed."),
      h("div", { class: "buttons" },
        btn("calibAutotune", "Auto-tune for the start position", () => void run("Auto-tune", async () => {
          S.test.pos = initialPosition();
          S.test.moves = [];
          S.tune = await api.autotune();
          S.squares = await api.squares();
        }), "primary"),
        h("label", { style: "display:flex;gap:4px;align-items:center" }, live, "live"),
      ),
      S.vs?.synthetic ? simScene() : "",
      summary,
      board,
      h("h3", {}, "Thresholds"),
      sliders,
      h("h3", {}, "Test: move a few pieces"),
      h("div", { class: "guide" }, "Start from the start position. Make one legal move on the board, press Detect move; repeat."),
      h("div", { class: "buttons" },
        btn("calibTestReset", "Start test (start position)", () => {
          S.test = { pos: initialPosition(), moves: [], last: "" };
          refreshSide();
        }),
        btn("calibTestDetect", "Detect move", () => void run("Detect the move", async () => {
          const sq = await api.squares();
          S.squares = sq;
          const r = inferMove(S.test.pos, sq.squares as Occupancy);
          if (r.kind === "move") {
            const san = moveToSan(S.test.pos, r.move);
            S.test.pos = applyMove(S.test.pos, r.move);
            S.test.moves.push(san);
            S.test.last = `detected ${san}`;
            say(`Detected move: ${san}`, "good");
          } else if (r.kind === "none") {
            S.test.last = "no change";
            say("No change seen on the board.", "warn");
          } else if (r.kind === "ambiguous") {
            S.test.last = `ambiguous: ${r.moves.length} moves fit`;
            say(S.test.last, "warn");
          } else {
            S.test.last = `not a legal move; squares ${r.squares.join(", ")}`;
            say(`Mismatch: ${r.squares.join(", ")}`, "bad");
          }
        })),
      ),
      testOut,
    );
    const sd = mkSlider("diff", "Diff (grey)", 1, 150, 1);
    const so = mkSlider("occupied_fraction", "Occupied frac.", 0.01, 0.95, 0.01);
    const sw = mkSlider("white", "White level", 1, 254, 1);
    return {
      update() {
        const th = S.vs?.draft.thresholds;
        if (th) {
          for (const [s, val] of [[sd, th.diff], [so, th.occupied_fraction], [sw, th.white]] as const) {
            if (document.activeElement !== s.r) {
              s.r.value = String(val);
              s.v.textContent = String(val);
            }
          }
        }
        summary.innerHTML = "";
        const t = S.tune;
        if (t) {
          summary.append(h("p", { id: "calibTuneResult", class: t.correct === 64 ? "good" : "bad" }, `Auto-tune: ${t.correct}/64 squares, ${t.pieces_correct}/${t.pieces_total} pieces; margins: occupancy ${fmt(t.occupancy_margin, 2)}, colour ${fmt(t.colour_margin, 0)} grey`));
        }
        board.innerHTML = "";
        const sq = S.squares;
        if (!S.vs?.draft.has_reference) {
          board.append(h("p", { class: "warn" }, "No reference yet: do step 3 first."));
          return;
        }
        if (sq) {
          const sc = score(sq.squares);
          summary.append(h("p", { id: "calibDetectScore", class: sc.correct === 64 ? "good" : "warn" }, `Camera vs expected: ${sc.correct}/64 squares, ${sc.pieces}/${sc.piecesTotal} pieces${sc.errs.length ? ` · wrong: ${sc.errs.join(", ")}` : ""}${sq.low_confidence.length ? ` · low confidence: ${sq.low_confidence.join(", ")}` : ""}`));
          const exp = expectedNow()!;
          board.append(miniBoard((s) => {
            const st = sq.squares[s] ?? null;
            const det = sq.details[s]!;
            const dark = ("abcdefgh".indexOf(s[0]!) + Number(s[1])) % 2 === 1;
            const piece = st ? `<span class="pc" style="background:${st === "w" ? "#f2f2f2;color:#000" : "#111;color:#fff"}">${Math.round(det.confidence * 100)}</span>` : `<span style="font-size:9px;color:#8fa0b6">${Math.round(det.confidence * 100)}</span>`;
            return { html: piece, style: `background:${dark ? "#6b5640" : "#c9b48f"}`, cls: exp[s] !== st ? "err" : det.confidence < 0.3 ? "flag" : "", title: `${s}: ${st ?? "empty"}, frac ${det.frac}, grey ${det.grey ?? "-"}, confidence ${det.confidence}` };
          }));
        }
        refreshTopThrottled();
        testOut.innerHTML = "";
        testOut.append(h("p", {}, `Test moves: ${S.test.moves.join(" ") || "–"}${S.test.last ? ` · last: ${S.test.last}` : ""}`));
      },
    };
  }

  function miniBoard(cell: (sq: string) => { html: string; style: string; cls: string; title: string }): HTMLElement {
    const t = h("table", { class: "mini" });
    for (let r = 7; r >= 0; r--) {
      const tr = h("tr", {}, h("td", { class: "lab" }, String(r + 1)));
      for (let f = 0; f < 8; f++) {
        const sq = `${"abcdefgh"[f]}${r + 1}`;
        const c = cell(sq);
        const td = h("td", { style: c.style, class: c.cls, title: c.title, "data-sq": sq });
        td.innerHTML = c.html;
        tr.append(td);
      }
      t.append(tr);
    }
    t.append(h("tr", {}, h("td", { class: "lab" }), ..."abcdefgh".split("").map((f) => h("td", { class: "lab", style: "height:14px" }, f))));
    return t;
  }

  // 5 -------------------------------------------------------------------------
  function robotCmd(m: CalibClientMessage): void {
    const d = driver();
    const s = useTwin.getState();
    const real = d.kind === "server" && (d.state().real || s.everReal);
    if (!s.connected && s.everReal) {
      say("The server is disconnected: no robot motion.", "bad");
      return;
    }
    const moves = m.type === "calibGoto" || m.type === "calibNudge" || m.type === "calibObservePose";
    if (moves && real) {
      if (!S.allowReal) {
        say("Real robot: tick 'I hold the user stop' first.", "bad");
        return;
      }
      (m as { confirmReal?: boolean }).confirmReal = true;
    }
    if (moves && d.kind === "server" && !s.enabled) {
      say("The robot is disabled: press Enable (main panel) when it is safe.", "bad");
      return;
    }
    void d.send(m).then(() => refreshSide());
  }

  function stepRobot() {
    const mode = h("div", { id: "calibRobotMode" });
    const hover = h("input", { type: "number", id: "calibHover", value: String(S.hover), min: "5", max: "100" });
    hover.onchange = () => (S.hover = Number(hover.value) || 20);
    const allow = h("input", { type: "checkbox", id: "calibAllowReal", checked: S.allowReal });
    allow.onchange = () => (S.allowReal = allow.checked);
    const step = h("select", { id: "calibJogStep" }, ...[1, 2, 5, 10].map((v) => h("option", { value: String(v), selected: v === S.jogStep }, `${v} mm`)));
    step.onchange = () => (S.jogStep = Number(step.value));
    const pts = h("div", { class: "kv" });
    const tcp = h("div", { id: "calibTcp", class: "hint" });
    const fitOut = h("div", { id: "calibFitOut" });
    const fitted = h("input", { type: "checkbox", id: "calibUseFitted", checked: S.useFittedSquare });
    fitted.onchange = () => (S.useFittedSquare = fitted.checked);
    const jog = (axis: number, sign: number, label: string) =>
      btn(`calibJog${label.replace(/[+-]/, (c) => (c === "+" ? "P" : "M"))}`, label, () => {
        const d: [number, number, number] = [0, 0, 0];
        d[axis] = sign * S.jogStep;
        robotCmd({ type: "calibNudge", deltaBaseMm: d });
      });
    const man = { x: h("input", { type: "number", id: "calibManX", step: "0.5" }), y: h("input", { type: "number", id: "calibManY", step: "0.5" }), z: h("input", { type: "number", id: "calibManZ", step: "0.5" }), yaw: h("input", { type: "number", id: "calibManYaw", step: "0.1", value: "0" }), sq: h("input", { type: "number", id: "calibManSq", step: "0.1", value: "40" }) };
    const cfg = driver().state().configured;
    const a1b = twinToBase(cfg.origin);
    man.x.value = String(a1b[0]);
    man.y.value = String(a1b[1]);
    man.z.value = String(a1b[2]);
    man.yaw.value = String(cfg.rotationDeg);
    man.sq.value = String(cfg.square);
    side.append(
      h("h2", {}, "5. Board pose in the robot frame"),
      mode,
      h("div", { class: "guide" }, "Touch-off: press Go above a1, lower with -Z until the TCP (centre between the fingertips) is at the hover height over the centre of a1, centre it with X/Y, press Record. Repeat for h1 and h8, then Fit. The arm moves only when you press a button. Start in simulation or dry-run; real robot at low speed with the user stop in your hand."),
      h("label", { class: "row", style: "cursor:pointer" }, allow, h("span", { class: "warn" }, "I hold the user stop; the wizard may move the REAL arm when I press a button")),
      h("div", { class: "row" }, h("label", {}, "Hover height"), hover, h("span", { class: "hint" }, "mm above the board surface at Record (use a gauge)")),
      h("div", { class: "buttons" },
        ...(["a1", "h1", "h8"] as const).flatMap((p) => [
          btn(`calibGo_${p}`, `Go above ${p}`, () => robotCmd({ type: "calibGoto", square: p, heightMm: S.hover + 30 })),
          btn(`calibRec_${p}`, `Record ${p}`, () => robotCmd({ type: "calibRecord", point: p }), "primary"),
        ]),
      ),
      h("div", { class: "row" }, h("label", {}, "Jog (base frame)"), step),
      h("div", { class: "row" },
        h("div", { class: "jog" }, h("span"), jog(0, 1, "+X"), h("span"), jog(1, 1, "+Y"), h("span"), jog(1, -1, "-Y"), h("span"), jog(0, -1, "-X"), h("span")),
        h("div", { class: "jog", style: "grid-template-columns:54px" }, jog(2, 1, "+Z"), jog(2, -1, "-Z")),
        h("div", { class: "hint" }, "X forward from the base, Y to the robot's left, Z up. At most 10 mm per press."),
      ),
      tcp,
      h("h3", {}, "Recorded points (base frame, mm)"),
      pts,
      h("div", { class: "row" },
        btn("calibFit", "Fit board pose", () => robotCmd({ type: "calibFit", hoverMm: S.hover, useFittedSquare: S.useFittedSquare }), "primary"),
        fitted, h("span", {}, "use the fitted square size"),
        btn("calibRobotReset", "Clear points", () => robotCmd({ type: "calibReset" })),
      ),
      fitOut,
      h("h3", {}, "Manual entry (a1 CORNER in the robot base frame)"),
      h("div", { class: "row" }, h("label", {}, "X Y Z (mm)"), man.x, man.y, man.z),
      h("div", { class: "row" }, h("label", {}, "Yaw / square"), man.yaw, man.sq, btn("calibManual", "Use manual pose", () => {
        const b: Vec3 = [Number(man.x.value), Number(man.y.value), Number(man.z.value)];
        robotCmd({ type: "calibManualPose", origin: baseToTwin(b), rotationDeg: Number(man.yaw.value), square: Number(man.sq.value) });
      })),
    );
    return {
      update() {
        const d = driver();
        const st = d.state();
        const s = useTwin.getState();
        mode.innerHTML = "";
        mode.append(h("p", { class: d.kind === "local" ? "warn" : st.real ? "bad" : "good" },
          d.kind === "local" ? "Mode: twin-only simulation (no robot server). Nothing real moves." : `Mode: server · ${s.mode}${s.enabled ? " · enabled" : " · DISABLED (press Enable in the main panel)"}${st.real ? " · REAL ROBOT (dry-run or real: see the bridge)" : ""}`));
        const q = d.kind === "local" ? opts.localSim.q : s.q;
        const t = tcpOf(opts.chain, q);
        tcp.textContent = `TCP now (base frame): ${fmtV(twinToBase(t))} mm`;
        pts.innerHTML = "";
        for (const p of ["a1", "h1", "h8"] as const) {
          const v = st.points[p];
          pts.append(h("span", {}, p), h("span", { id: `calibPt_${p}` }, v ? fmtV(twinToBase(v)) : "not recorded"));
        }
        fitOut.innerHTML = "";
        const f = st.fit;
        if (f) {
          S.lastFit = f;
          const a1c = twinToBase(f.pose.origin);
          fitOut.append(
            h("div", { class: "kv", id: "calibFitKv" },
              h("span", {}, "Method"), h("span", {}, f.method),
              h("span", {}, "a1 corner (base)"), h("span", {}, `${fmtV(a1c)} mm`),
              h("span", {}, "Origin (twin)"), h("span", {}, `${fmtV(f.pose.origin)} mm`),
              h("span", {}, "Yaw"), h("span", {}, `${fmt(f.pose.rotationDeg, 2)} deg`),
              h("span", {}, "Square"), h("span", {}, `${fmt(f.pose.square, 2)} mm (fitted ${fmt(f.fittedSquare, 2)})`),
              h("span", {}, "Residual"), h("span", { id: "calibResidual", class: f.residualRms < 2 ? "good" : "bad" }, `${fmt(f.residualRms, 2)} mm rms, ${fmt(f.residualMax, 2)} mm max`),
              h("span", {}, "vs configured"), h("span", {}, `${fmt(f.delta.originMm, 1)} mm, ${fmt(f.delta.rotationDeg, 2)} deg, ${fmt(f.delta.squareMm, 2)} mm square`),
              h("span", {}, "Reachable"), h("span", { id: "calibReach", class: f.reachability.reachable === f.reachability.total ? "good" : "bad" }, `${f.reachability.reachable}/${f.reachability.total}${f.reachability.unreachable.length ? ` · not: ${f.reachability.unreachable.slice(0, 8).join(", ")}` : ""}`),
            ),
            h("div", { class: "warn" }, f.warnings.join(" · ")),
          );
        }
        if (st.message) say(st.message, /refus|fail|not |disabled|error|confirm/i.test(st.message) ? "warn" : "");
      },
    };
  }

  // 6 -------------------------------------------------------------------------
  function stepSave() {
    const checklist = h("div", { class: "kv" });
    const note = h("textarea", { id: "calibNote", placeholder: "Operator note (who, light, camera position, anything unusual)" });
    const result = h("div", { id: "calibValidation" });
    const versions = h("div", { class: "versions" });
    const loadVersions = () => api.versions().then((v) => { S.versions = v; refreshSide(); }).catch(() => {});
    void loadVersions();
    side.append(
      h("h2", {}, "6. Save and validate"),
      checklist,
      note,
      h("div", { class: "buttons" }, btn("calibSave", "Save calibration", () => void run("Save", async () => {
        const f = S.lastFit ?? driver().state().fit;
        if (!f) throw new Error("no board pose: finish step 5 (touch-off or manual entry)");
        const r = await api.save({
          note: note.value,
          robot: {
            origin_twin_mm: f.pose.origin,
            rotation_deg: f.pose.rotationDeg,
            square_mm: f.pose.square,
            method: f.method,
            residual_mm: f.residualRms,
            hover_mm: f.hoverMm,
            points_twin_mm: f.points,
          },
        });
        say(`Saved r${r.saved.revision}; the vision service uses it now.`, "good");
        S.validation = null;
        if (driver().kind === "server") opts.send({ type: "calibReload" });
        await loadVersions();
      }), "primary")),
      h("div", { class: "guide" }, "Final check: set up the START POSITION, put the arm in the observe pose, then run the check. It needs 32/32 pieces, 64/64 squares and every square reachable."),
      h("div", { class: "buttons" },
        btn("calibObserve6", "Move arm to observe pose", () => robotCmd({ type: "calibObservePose" })),
        btn("calibValidate", "Run final check", () => void run("Final check", async () => {
          if (driver().kind === "server") {
            opts.send({ type: "calibValidate" });
            say("Final check running on the server (about 10 s)...");
          } else {
            const vs = await api.versions();
            const rev = vs.active.revision;
            const c = (vs.active as any).robot;
            if (!rev || !c) throw new Error("save first");
            const reach = await (local as LocalDriver).reachability({ origin: c.origin_twin_mm, rotationDeg: c.rotation_deg, square: c.square_mm });
            const r = await api.validate({ revision: rev, reachability: reach });
            S.validation = r.validation;
            say(`Final check (local reachability): ${r.validation.passed ? "PASSED" : "FAILED"}`, r.validation.passed ? "good" : "bad");
          }
          await loadVersions();
        }), "primary"),
      ),
      S.vs?.synthetic ? simScene() : "",
      result,
      h("h3", {}, "Versions (rollback makes an old revision active again)"),
      versions,
    );
    return {
      update() {
        const d = S.vs?.draft;
        const f = S.lastFit ?? driver().state().fit;
        checklist.innerHTML = "";
        const item = (label: string, ok: boolean, detail: string) => checklist.append(h("span", {}, label), h("span", { class: ok ? "good" : "bad" }, `${ok ? "OK" : "missing"} ${detail}`));
        item("Board geometry", Boolean(d?.overlay), d?.method ?? "");
        item("Orientation", Boolean(d?.confirmed), d?.confirmed ? "confirmed" : "");
        item("Reference", Boolean(d?.has_reference), d?.has_reference ? `${d.reference_frames} frames` : "");
        item("Thresholds", Boolean(d), d ? `diff ${d.thresholds.diff}, occ ${d.thresholds.occupied_fraction}, white ${d.thresholds.white}` : "");
        item("Robot frame", Boolean(f), f ? `${f.method}, residual ${fmt(f.residualRms, 2)} mm, reach ${f.reachability.reachable}/${f.reachability.total}` : "");
        result.innerHTML = "";
        const st = S.status;
        const v = (st?.validation as any) ?? S.validation ?? (S.versions?.active as any)?.validation;
        if (v && v.start_position) {
          const sp = v.start_position;
          const rc = v.reachability ?? {};
          result.append(h("p", { class: v.passed ? "good" : "bad", id: "calibCheck" },
            `Final check r${v.revision}: ${v.passed ? "PASSED" : "FAILED"} · pieces ${sp.pieces_correct}/${sp.pieces_total} · squares ${sp.correct}/64${sp.errors?.length ? ` (wrong: ${sp.errors.join(", ")})` : ""} · reachable ${rc.reachable ?? "?"}/${rc.total ?? "?"}`));
        }
        if (st) {
          result.append(h("p", { id: "calibLoopGate", class: st.valid ? "good" : st.required ? "bad" : "warn" },
            st.valid ? `Chess loop: allowed (calibration r${st.revision}).` : `Chess loop: ${st.required ? "BLOCKED" : "not gated"} · ${st.reasons.join("; ")}`));
        } else if (driver().kind === "local") {
          const a = S.versions?.active;
          if (a) result.append(h("p", { class: a.complete ? "good" : "warn" }, a.complete ? `Calibration r${a.revision} complete.` : `Calibration: ${a.reasons.join("; ")}`));
        }
        versions.innerHTML = "";
        for (const ver of [...(S.versions?.versions ?? [])].reverse()) {
          const active = ver.revision === S.versions?.active.revision;
          versions.append(h("div", {},
            h("b", {}, `r${ver.revision}`), h("span", {}, `${ver.created ?? ""} ${ver.passed ? "· checked" : ""} ${ver.rolled_back_from ? `· from r${ver.rolled_back_from}` : ""}`),
            h("span", { class: "hint" }, ver.note ?? ""),
            active ? h("span", { class: "good" }, "active") : btn(`calibRollback_${ver.revision}`, "Roll back", () => void run(`Roll back to r${ver.revision}`, async () => {
              await api.rollback(ver.revision);
              if (driver().kind === "server") opts.send({ type: "calibReload" });
              await loadVersions();
            })),
          ));
        }
      },
    };
  }

  if (location.hash === "#calibrate") setOpen(true);
}
