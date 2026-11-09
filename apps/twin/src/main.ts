import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DragControls } from "three/examples/jsm/controls/DragControls.js";
import { forwardKinematics, mat4TransformPoint } from "@robot/kinematics";
import { buildChain, defaultArmConfig } from "@robot/robot-config";
import { parseFen, spokenToSan } from "@robot/chess";
import { buildArm } from "./arm";
import { buildBoard } from "./chessboard";
import { useTwin } from "./store";
import { connect, type TwinSocket } from "./net";
import { LocalSim } from "./localsim";
import type { ClientMessage } from "@robot/protocol";

const chain = buildChain(defaultArmConfig());

// ---- three.js setup -------------------------------------------------------
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
// Photo skybox, chosen with ?env= (default: the night savanna). The fog color
// matches each photo's horizon so the outer grid fades into the picture.
const envName = new URLSearchParams(location.search).get("env") ?? "dikhololo_night";
const HORIZON_FOG: Record<string, number> = {
  dikhololo_night: 0x584b38,
  spruit_sunrise: 0xa69a76,
  kloofendal_48d_partly_cloudy_puresky: 0x959bac,
};
scene.fog = new THREE.Fog(HORIZON_FOG[envName] ?? HORIZON_FOG.dikhololo_night, 2400, 12000);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 100000);
// View from White's side so White's pieces sit at the bottom and the a-file is
// on the left (a1 = bottom-left), matching how the human player reads the board.
camera.position.set(370, 780, -1300);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(240, 240, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x33404f, 1.5));
const dir = new THREE.DirectionalLight(0xffffff, 1.3);
dir.position.set(1400, 2600, 1000);
dir.castShadow = true;
// The default shadow camera is ±5 units — nothing at mm scale would cast or
// receive. Cover the work area so the arm and board ground with real shadows.
dir.shadow.camera.left = -6000;
dir.shadow.camera.right = 6000;
dir.shadow.camera.top = 6000;
dir.shadow.camera.bottom = -6000;
dir.shadow.camera.far = 12000;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.bias = -0.0005;
scene.add(dir);

// ---- world: sky dome + fading field ----------------------------------------
// The dome is one back-side sphere with a two-stop vertical gradient (1 draw
// call). The fog color equals the horizon color, so the coarse outer grid
// fades into the dome instead of stopping at a visible seam.
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(9000, 32, 15),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      cTop: { value: new THREE.Color(0x0b0e14) },
      cHorizon: { value: new THREE.Color(0x2e7180) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 cTop;
      uniform vec3 cHorizon;
      void main() {
        float h = normalize(vDir).y;
        gl_FragColor = vec4(mix(cHorizon, cTop, smoothstep(-0.02, 0.55, h)), 1.0);
      }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

// The photo skybox: a 2k equirectangular JPEG (120-350 KB) drawn as the scene
// background — one texture sample per pixel, no geometry, no lighting. The
// gradient dome above is only the loading fallback and yields once it lands.
new THREE.TextureLoader().load(`/env/${envName}.jpg`, (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
  sky.visible = false;
});

const grid = new THREE.GridHelper(1200, 24, 0x2a3140, 0x1b2029);
grid.position.y = 0;
scene.add(grid);

// Coarse outer field; fog fades it into the horizon.
const field = new THREE.GridHelper(12000, 60, 0x394451, 0x272f39);
field.position.y = -1;
scene.add(field);

// ---- low-poly world: terrain ring, trees, clouds ----------------------------
// Terrain is one 96x96 mesh, flat inside r=1800 so the board and grid stay
// level; hills rise outside it. Trees are two InstancedMeshes (2 draw calls).
// Clouds share one icosahedron geometry and drift slowly in animate().
function vnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const h = (i: number, j: number) => {
    const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function terrainY(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const amp = THREE.MathUtils.smoothstep(r, 1800, 3600);
  const n =
    0.6 * vnoise(x * 0.00045, z * 0.00045) +
    0.3 * vnoise(x * 0.0011, z * 0.0011) +
    0.1 * vnoise(x * 0.0032, z * 0.0032);
  return -1 + amp * n * n * 1600;
}
{
  const geo = new THREE.PlaneGeometry(24000, 24000, 96, 96);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cLow = new THREE.Color(0x27301f), cHigh = new THREE.Color(0x4a4030);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, terrainY(x, z));
    const c = cLow.clone().lerp(cHigh, vnoise(x * 0.0016, z * 0.0016));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }),
  );
  terrain.receiveShadow = true;
  scene.add(terrain);
}
{
  const N = 60;
  const trunkGeo = new THREE.CylinderGeometry(30, 45, 180, 5);
  const crownGeo = new THREE.ConeGeometry(150, 460, 6);
  const trunks = new THREE.InstancedMesh(
    trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3826, flatShading: true, roughness: 1 }), N);
  const crowns = new THREE.InstancedMesh(
    crownGeo, new THREE.MeshStandardMaterial({ color: 0x2f4a2a, flatShading: true, roughness: 1 }), N);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.random() * 0.5;
    // Keep every tree inside the shadow camera (±6000) so each one gets a
    // contact shadow; beyond it, crowns read as floating at night.
    const r = 2600 + Math.random() * 3300;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = terrainY(x, z);
    const s = 0.7 + Math.random() * 0.9;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    sv.set(s, s, s);
    m.compose(pv.set(x, y + 90 * s, z), q, sv);
    trunks.setMatrixAt(i, m);
    m.compose(pv.set(x, y + (180 + 230) * s, z), q, sv);
    crowns.setMatrixAt(i, m);
  }
  trunks.castShadow = crowns.castShadow = true;
  scene.add(trunks, crowns);
}
const clouds = new THREE.Group();
{
  const puffGeo = new THREE.IcosahedronGeometry(320, 0);
  // Light material with a little self-glow, so clouds read as clouds at night
  // instead of grey stones.
  const puffMat = new THREE.MeshStandardMaterial({
    color: 0xd9dfe8,
    emissive: 0x3a4150,
    flatShading: true,
    roughness: 1,
  });
  for (let i = 0; i < 9; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + (i % 3);
    for (let j = 0; j < puffs; j++) {
      const puff = new THREE.Mesh(puffGeo, puffMat);
      puff.position.set((j - puffs / 2) * 400, Math.random() * 120, Math.random() * 160);
      puff.scale.y = 0.45;
      cloud.add(puff);
    }
    cloud.position.set(
      (Math.random() - 0.5) * 18000,
      3400 + Math.random() * 1200,
      (Math.random() - 0.5) * 18000,
    );
    clouds.add(cloud);
  }
  scene.add(clouds);
}

// ---- arm + target ---------------------------------------------------------
const arm = buildArm(chain);
scene.add(arm.root);
// Load the official Panda meshes (falls back to the procedural model if absent).
void arm.loadMeshes();

// 3D chessboard + pieces (start state until the server syncs).
const board = buildBoard();
scene.add(board.group);
board.setFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");

// Target draggable gizmo.
const targetMesh = new THREE.Mesh(
  new THREE.SphereGeometry(16, 28, 28),
  new THREE.MeshStandardMaterial({ color: 0x39c66b, emissive: 0x0e3a1c }),
);
scene.add(targetMesh);

// a small vertical axis line from the target.
const targetAxis = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 130, 0)]),
  new THREE.LineBasicMaterial({ color: 0x39c66b }),
);
targetMesh.add(targetAxis);

// ---- local sim fallback ---------------------------------------------------
const localSim = new LocalSim(chain);

// ---- network base URLs -----------------------------------------------------
// Everything goes through the SAME origin as the twin page. When the twin is
// served over HTTPS (e.g. https://robot:5909), the browser would block plain
// HTTP/WS sub-requests (mixed content). So the WS and vision are reached on the
// page's own origin via /robot-ws and /vision, which a reverse proxy (or Vite's
// dev proxy forward) routes to the backends. This works over both http and https.
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/robot-ws`;
const VIS_BASE = `${location.origin}/vision`;

// ---- socket ---------------------------------------------------------------
let socket: TwinSocket | null = null;
try {
  socket = connect(WS_URL);
} catch {
  socket = null;
}

// Live camera feed from the vision service (MJPEG).
const feedImg = document.getElementById("feedImg") as HTMLImageElement;
const feedEmpty = document.getElementById("feedEmpty")!;
feedImg.onload = () => {
  feedImg.style.display = "block";
  feedEmpty.style.display = "none";
};
feedImg.onerror = () => {
  feedImg.style.display = "none";
  feedEmpty.style.display = "flex";
};
feedImg.src = `${VIS_BASE}/stream`;

// Live piece overlay: poll /detect and draw clickable marks on the feed.
const feedEl = document.getElementById("feed")!;
const frameDims = { w: 1280, h: 720 };
function renderPieces(pieces: any[]): void {
  let layer = document.getElementById("piecesLayer") as HTMLElement | null;
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "piecesLayer";
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    feedEl.appendChild(layer);
  }
  layer.innerHTML = "";
  for (const p of pieces) {
    if (!p.x || !p.y) continue;
    const dot = document.createElement("div");
    const color = p.color === "white" ? "#fff" : "#111";
    dot.style.cssText = `position:absolute;left:${((p.x / frameDims.w) * 100).toFixed(2)}%;top:${((p.y / frameDims.h) * 100).toFixed(2)}%;transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #39c66b;pointer-events:auto;cursor:pointer;`;
    dot.title = `${p.color} ${p.type} ${p.square ? p.square.join("") : "?"}`;
    dot.onclick = () => {
      if (Array.isArray(p.target)) {
        const t = p.target as [number, number, number];
        useTwin.getState().setState({ target: t });
        if (useTwin.getState().connected) sendTarget(t);
      }
    };
    layer.appendChild(dot);
  }
}
async function pollVision(): Promise<void> {
  try {
    const res = await fetch(`${VIS_BASE}/detect`);
    const data = await res.json();
    if (data.frame) {
      frameDims.w = data.frame.width || frameDims.w;
      frameDims.h = data.frame.height || frameDims.h;
    }
    renderPieces(data.pieces || []);
  } catch {
    // vision service not reachable; ignore
  }
  setTimeout(pollVision, 1000);
}
void pollVision();

const setEnabled = (v: boolean) =>
  socket?.send({ type: "setEnabled", enabled: v } satisfies ClientMessage);
const sendGripper = (open: boolean) =>
  socket?.send({ type: "gripper", open } satisfies ClientMessage);
const sendEStop = () => socket?.send({ type: "estop" } satisfies ClientMessage);
const sendHome = () => socket?.send({ type: "home" } satisfies ClientMessage);
const sendTarget = (pos: [number, number, number]) =>
  socket?.send({ type: "setTarget", target: { position: pos } } satisfies ClientMessage);

function requestMove(): void {
  const t = useTwin.getState().target;
  useTwin.getState().setState({ target: t });
  if (useTwin.getState().connected) {
    sendTarget(t);
  } else {
    const ok = localSim.setTarget(t);
    showHud(ok ? "target reached (offline)" : "target unreachable (offline)");
  }
}

// ---- UI -------------------------------------------------------------------
function ui() {
  const badge = document.getElementById("statusDot")!;
  const statusText = document.getElementById("statusText")!;
  const hud = document.getElementById("hud")!;
  const sliders = document.getElementById("jointSliders")!;
  const targetEl = document.getElementById("targetControls")!;

  useTwin.subscribe((s) => {
    badge.classList.toggle("on", s.connected);
    statusText.textContent = s.connected
      ? `connected · ${s.mode}${s.enabled ? "" : " · disabled"}`
      : "offline (local sim)";
  });

  // Joint sliders.
  const inputs: HTMLInputElement[] = [];
  const vals: HTMLSpanElement[] = [];
  sliders.innerHTML = "";
  chain.joints.forEach((j, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = j.name;
    const range = document.createElement("input");
    range.type = "range";
    range.min = String((Math.min(j.min, j.max) * 180) / Math.PI);
    range.max = String((Math.max(j.min, j.max) * 180) / Math.PI);
    range.step = "0.5";
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = "0°";
    range.oninput = () => {
      val.textContent = `${Number(range.value).toFixed(1)}°`;
      const q = chain.joints.map((j2, k2) => {
        const input = inputs[k2];
        return input ? (Number(input.value) * Math.PI) / 180 : 0;
      });
      // Preview locally, and send if connected.
      if (useTwin.getState().connected) {
        socket?.send({ type: "setJointState", q } satisfies ClientMessage);
      } else {
        localSim.setJoint(q);
      }
    };
    row.append(label, range, val);
    sliders.append(row);
    inputs.push(range);
    vals.push(val);
  });

  const isDegAndRanges = chain.joints.map((j) => [
    (Math.min(j.min, j.max) * 180) / Math.PI,
    (Math.max(j.min, j.max) * 180) / Math.PI,
  ]);

  // Target x / y / z inputs.
  const axes = ["x", "y", "z"];
  const targetInputs: HTMLInputElement[] = [];
  targetEl.innerHTML = "";
  axes.forEach((axis, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = axis.toUpperCase();
    const input = document.createElement("input");
    input.type = "number";
    input.step = "5";
    input.value = String(useTwin.getState().target[i]);
    input.oninput = () => {
      const t = useTwin.getState().target.slice() as [number, number, number];
      t[i] = Number(input.value) || 0;
      useTwin.getState().setState({ target: t });
    };
    row.append(label, input);
    targetEl.append(row);
    targetInputs.push(input);
  });

  document.getElementById("btnGo")!.onclick = requestMove;
  document.getElementById("btnHome")!.onclick = () => {
    if (useTwin.getState().connected) sendHome();
    else localSim.home();
  };
  document.getElementById("btnEnable")!.onclick = () => {
    const next = !useTwin.getState().enabled;
    useTwin.getState().setState({ enabled: next });
    setEnabled(next);
  };
  document.getElementById("btnGripper")!.onclick = () => {
    const next = !useTwin.getState().gripperOpen;
    useTwin.getState().setState({ gripperOpen: next });
    sendGripper(next);
  };
  // Slow gripper travel is a local presentation choice; the open/close command
  // to the server stays the same.
  const chkSlow = document.getElementById("chkGripperSlow") as HTMLInputElement;
  chkSlow.checked = useTwin.getState().gripperSlow;
  chkSlow.onchange = () => useTwin.getState().setState({ gripperSlow: chkSlow.checked });
  document.getElementById("btnEStop")!.onclick = () => {
    useTwin.getState().setState({ enabled: false });
    sendEStop();
  };
  document.getElementById("btnRecord")!.onclick = () => {
    const rec = !useTwin.getState().recording;
    useTwin.getState().setState({ recording: rec });
    socket?.send({ type: rec ? "recordStart" : "recordStop" } satisfies ClientMessage);
  };
  document.getElementById("btnReplay")!.onclick = () => {
    const steps = useTwin.getState().lastRecorded;
    if (steps.length) {
      socket?.send({ type: "replay", steps } satisfies ClientMessage);
    }
  };

  // Subscribe to joint-state changes and reflect into sliders (value + label).
  let lastSliderKey = "";
  useTwin.subscribe((s) => {
    // Skip DOM writes when the joint vector hasn't changed.
    const key = s.q.map((v) => Math.round(v * 1000)).join(",");
    if (key === lastSliderKey) return;
    lastSliderKey = key;
    inputs.forEach((inp, i) => {
      const v = (s.q[i] ?? 0) * (180 / Math.PI);
      inp.value = String(Number(v.toFixed(1)));
      if (vals[i]) vals[i]!.textContent = `${Number(v.toFixed(1))}°`;
    });
    // Keep sliders within range.
    inputs.forEach((inp, i) => {
      const [lo, hi] = isDegAndRanges[i]!;
      inp.min = String(lo);
      inp.max = String(hi);
    });
  });

  // Reflect current target into inputs.
  useTwin.subscribe((s) => {
    targetInputs.forEach((inp, i) => {
      inp.value = String(Number(s.target[i]!.toFixed(3)));
    });
  });

  return { setHud: (m: string) => { hud.textContent = m; } };
}

let hudWrite = (_m: string) => {};
function showHud(m: string): void {
  hudWrite(m);
}

// ---- drag controls --------------------------------------------------------
const drag = new DragControls([targetMesh], camera, renderer.domElement);
drag.addEventListener("dragstart", () => (controls.enabled = false));
drag.addEventListener("dragend", () => {
  controls.enabled = true;
  const t = [targetMesh.position.x, targetMesh.position.y, targetMesh.position.z] as [
    number,
    number,
    number,
  ];
  useTwin.getState().setState({ target: t });
  if (useTwin.getState().connected) sendTarget(t);
});
drag.addEventListener("drag", () => {
  const t = [targetMesh.position.x, targetMesh.position.y, targetMesh.position.z] as [
    number,
    number,
    number,
  ];
  useTwin.getState().setState({ target: t });
});

// ---- animation loop -------------------------------------------------------
let smoothedQ = chain.joints.map((j) => (j.min + j.max) / 2);
let last = performance.now();
let frames = 0;
let hudTime = 0;
let pubFrame = 0;
let eePos = new THREE.Vector3();

function chessUi(): void {
  const statusEl = document.getElementById("chessStatus")!;
  const sanInput = document.getElementById("sanInput") as HTMLInputElement;
  const eloRange = document.getElementById("eloRange") as HTMLInputElement;
  const eloVal = document.getElementById("eloVal")!;

  // Reflect server chess state onto the board and the HUD.
  let lastStatus = "";
  useTwin.subscribe((s) => {
    if (s.fen) board.setFen(s.fen);
    // Only touch the status text when the game state actually changed (don't
    // rewrite DOM on every 30 Hz state broadcast).
    const status =
      (s.lastError ? `⚠ ${s.lastError} · reset with "New game"` : null) ??
      `${s.turn === "w" ? "Your turn (White)" : "Twin is thinking (Black)"}${s.check ? " · check" : ""} · last: ${s.lastSan || "—"} · Twin Elo ${s.elo}`;
    if (status !== lastStatus) {
      lastStatus = status;
      statusEl.textContent = status;
    }
  });

  const play = () => {
    const san = sanInput.value.trim();
    if (san) socket?.send({ type: "playSan", san } satisfies ClientMessage);
  };
  document.getElementById("btnPlay")!.onclick = play;
  sanInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") play();
  });

  // Voice control (Web Speech API).
  document.getElementById("btnSpeak")!.onclick = () => {
    const SR =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Speech recognition is not supported in this browser (use Chrome/Edge).");
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const transcript = String(e.results[0][0].transcript);
      const fen = useTwin.getState().fen;
      const pos = fen ? parseFen(fen) : null;
      if (!pos) {
        statusEl.textContent = "⚠ No game yet — start a New game first.";
        return;
      }
      if (pos.turn !== "w") {
        statusEl.textContent = "⚠ Not your turn — wait for the twin to move.";
        return;
      }
      const san = spokenToSan(pos, transcript);
      if (san) {
        sanInput.value = san;
        socket?.send({ type: "playSan", san } satisfies ClientMessage);
      } else {
        statusEl.textContent = `⚠ Didn't catch "${transcript.trim()}" — say a move like "knight f3", "e takes d5", or "long castle".`;
      }
    };
    rec.onerror = (e: any) => console.warn("[stt]", e.error ?? e);
    rec.onend = () => {};
    rec.start();
  };

  // New game + elo (the twin is always the opponent).
  document.getElementById("btnReset")!.onclick = () => {
    socket?.send({ type: "resetGame" } satisfies ClientMessage);
  };
  eloRange.oninput = () => {
    eloVal.textContent = eloRange.value;
    socket?.send({ type: "setOpponent", enabled: true, elo: Number(eloRange.value) } satisfies ClientMessage);
  };
}

function animate(): void {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const s = useTwin.getState();

  // Determine the goal joint state: server-provided when connected, else local.
  const goal = s.connected ? s.q : localSim.tick(dt, 12);
  if (s.connected) localSim.tick(dt, 12); // keep local sim warm

  // Offline: publish the local sim state so the sliders track the arm.
  if (!s.connected) {
    const frame = Math.floor(now / 33);
    if (frame !== pubFrame) {
      pubFrame = frame;
      useTwin.getState().setState({ q: localSim.q });
    }
  }

  // Smooth toward the goal to avoid 30 Hz stepping.
  const alpha = 1 - Math.exp(-dt * 14);
  for (let i = 0; i < smoothedQ.length; i++) {
    smoothedQ[i] += (goal[i]! - smoothedQ[i]!) * alpha;
  }

  arm.setAngles(smoothedQ);
  arm.setGripper(s.gripperOpen ? 1 : 0);
  arm.setGripperSpeed(s.gripperSlow ? 2.5 : 0.7);

  // End-effector world position (from FK of smoothed pose).
  const fkPos = eePosFromChain(smoothedQ);
  eePos = new THREE.Vector3(fkPos[0], fkPos[1], fkPos[2]);

  // Target gizmo follows the stored target.
  targetMesh.position.set(s.target[0], s.target[1], s.target[2]);

  controls.update();
  // Slow cloud drift; the group wraps so the sky never empties.
  clouds.position.x = ((now * 0.008) % 20000) - 10000;
  renderer.render(scene, camera);

  // HUD.
  frames++;
  hudTime += dt;
  if (hudTime > 0.5) {
    const fps = Math.round(frames / hudTime);
    frames = 0;
    hudTime = 0;
    const hud = document.getElementById("hud")!;
    hud.textContent = `${fps} fps · ee (${eePos.x.toFixed(0)}, ${eePos.y.toFixed(0)}, ${eePos.z.toFixed(0)}) mm · target (${s.target[0].toFixed(0)}, ${s.target[1].toFixed(0)}, ${s.target[2].toFixed(0)}) mm`;
  }
}

function eePosFromChain(q: number[]): [number, number, number] {
  const fk = forwardKinematics(chain, q);
  // End-effector reference is the gripper tip, not the tool-frame origin.
  return mat4TransformPoint(fk.pose, [0, 0, 130]);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

hudWrite = ui().setHud;
chessUi();
animate();
