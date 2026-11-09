import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import type { KinematicChain, JointState } from "@robot/kinematics";

export interface ArmView {
  root: THREE.Group;
  /** Apply joint angles (radians) to the arm. */
  setAngles(q: JointState): void;
  /** Set the gripper open/closed (0..1); travel is animated. */
  setGripper(t: number): void;
  /** Full gripper stroke duration in seconds (small = fast, large = slow). */
  setGripperSpeed(seconds: number): void;
  /** Load the official Panda meshes onto the link frames. Resolves true on success. */
  loadMeshes(): Promise<boolean>;
}

const JOINT_COLOR = 0x2f6fd6;
const LINK_COLOR = 0xbfc5cc;
const BASE_COLOR = 0x1d222b;
const FINGER_COLOR = 0x2a2e36;

/** Official Panda (FER) visual meshes, keyed by link index (0..7) and "hand". */
const MESH_FILES: Record<string, string> = {
  "0": "/meshes/fer/link0.dae",
  "1": "/meshes/fer/link1.dae",
  "2": "/meshes/fer/link2.dae",
  "3": "/meshes/fer/link3.dae",
  "4": "/meshes/fer/link4.dae",
  "5": "/meshes/fer/link5.dae",
  "6": "/meshes/fer/link6.dae",
  "7": "/meshes/fer/link7.dae",
  hand: "/meshes/fer/hand.dae",
};

/**
 * Builds the arm as a joint hierarchy so each link (and its official mesh)
 * sits in its own link frame and inherits the base orientation correctly.
 */
export function buildArm(chain: KinematicChain): ArmView {
  const root = new THREE.Group();
  const n = chain.joints.length;

  // Base frame (chain.base) — the root of the chain.
  const base = new THREE.Group();
  applyTransform(base, chain.base);
  root.add(base);

  // Static base plate + pedestal, drawn in the base's local (model, Z-up) frame.
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(100, 120, 14, 48),
    mkMat(BASE_COLOR, 0.9, 0.2),
  );
  plate.rotation.x = Math.PI / 2; // cylinder axis Y -> local Z (up in the model)
  plate.position.z = 7;
  base.add(plate);

  const firstJoint = chain.joints[0]!;
  const riserLen = matrixPosition(chain.joints[0]!.origin).length();
  if (riserLen > 1e-6) {
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(46, 58, riserLen, 32),
      mkMat(BASE_COLOR, 0.7, 0.35),
    );
    pedestal.rotation.x = Math.PI / 2;
    pedestal.position.z = riserLen / 2;
    base.add(pedestal);
  }

  // Joint chain: node i is the frame after joint i (link i+1 for 1-indexed).
  const nodes: THREE.Group[] = [];
  let parent: THREE.Object3D = base;
  for (let i = 0; i < n; i++) {
    const node = new THREE.Group();
    applyOrigin(node, chain.joints[i]!.origin);
    parent.add(node);
    nodes.push(node);
    parent = node;
  }

  // Tool / hand node (after the last joint + tool offset).
  const tool = new THREE.Group();
  applyOrigin(tool, chain.tool);
  parent.add(tool);

  // Procedural fallback links (hidden once the real meshes load).
  const fallback: THREE.Object3D[] = [];
  for (let i = 0; i < n; i++) {
    const host = i === 0 ? base : nodes[i - 1]!;
    const next = i + 1 < n ? matrixPosition(chain.joints[i + 1]!.origin) : matrixPosition(chain.tool);
    if (next.length() > 1e-6) {
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(38, 38, 1, 18),
        mkMat(LINK_COLOR, 0.45, 0.35),
      );
      const start = new THREE.Vector3(0, 0, 0);
      guestPlace(seg, start, next.clone());
      host.add(seg);
      fallback.push(seg);
    }
  }
  const gripper = buildGripper();
  tool.add(gripper.group);
  fallback.push(gripper.group);

  // Where each official mesh attaches: link0 -> base, link i+1 -> node i, hand -> tool.
  function meshHost(key: string): THREE.Object3D {
    if (key === "hand") return tool;
    const k = Number(key);
    return k === 0 ? base : nodes[k - 1]!;
  }

  let lastQ: JointState = chain.joints.map(() => 0);

  const view: ArmView = {
    root,
    setAngles(q) {
      lastQ = q.slice();
      for (let i = 0; i < n; i++) {
        const node = nodes[i]!;
        const joint = chain.joints[i]!;
        const originQ = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().fromArray(Array.from(joint.origin) as number[]),
        );
        const axisQ = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(joint.axis[0], joint.axis[1], joint.axis[2]),
          q[i] ?? 0,
        );
        node.quaternion.copy(originQ).multiply(axisQ);
      }
    },
    setGripper(t) {
      gripper.setOpen(t);
    },
    setGripperSpeed(seconds) {
      gripper.setSpeed(seconds);
    },
    async loadMeshes() {
      try {
        const loader = new ColladaLoader();
        for (const [key, url] of Object.entries(MESH_FILES)) {
          if (key === "hand") continue; // use the animated procedural gripper instead
          const col = await new Promise<THREE.Object3D>((resolve, reject) => {
            loader.load(url, (c) => resolve(c.scene), undefined, reject);
          });
          // The loader rotates Z_UP assets to Y-up (scene.rotation.x = -90deg),
          // but our link frames are Z-up (URDF). So wrap in a holder that:
          //   * rotates +90deg about X  -> back to the Z-up link frame
          //   * scales metres -> mm
          const holder = new THREE.Group();
          holder.rotation.x = Math.PI / 2;
          holder.scale.setScalar(1000);
          holder.add(col);
          meshHost(key).add(holder);
        }
        // Hide the simplified fallback links (the real meshes replace them),
        // but keep the animated gripper visible.
        for (const o of fallback) if (o !== gripper.group) o.visible = false;
        view.setAngles(lastQ);
        return true;
      } catch (err) {
        console.warn("[twin] official Panda meshes not loaded, using procedural model:", err);
        return false;
      }
    },
  };

  view.setAngles(lastQ);
  return view;
}

function guestPlace(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  const len = a.distanceTo(b);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mesh.position.copy(mid);
  mesh.scale.set(1, Math.max(len, 1e-3), 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
}

function buildGripper(): {
  group: THREE.Group;
  setOpen(t: number): void;
  setSpeed(seconds: number): void;
} {
  const group = new THREE.Group();
  // Official Franka Hand proportions (mm): ~100 wide housing, two 20x30
  // prongs with rounded tips, 40 mm stroke per finger, 80 mm max opening.
  const housing = mkMat(0xd8dbe0, 0.55, 0.15); // Panda white
  const silver = mkMat(0xb9bfc7, 0.4, 0.6);
  const dark = mkMat(0x26292f, 0.7, 0.1);
  const pad = mkMat(0x15171b, 0.95, 0);

  // Flange coupling.
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(30, 32, 30, 24), silver);
  wrist.rotation.x = Math.PI / 2;
  group.add(wrist);

  // Housing + nose, with the dark dovetail slot between the finger rails.
  const body = new THREE.Mesh(new THREE.BoxGeometry(98, 84, 62), housing);
  body.position.z = 22;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(86, 72, 26), housing);
  nose.position.z = 63;
  const slot = new THREE.Mesh(new THREE.BoxGeometry(10, 74, 26), dark);
  slot.position.z = 63;
  group.add(body, nose, slot);

  // One prong: body + rounded tip + rubber pad on the inner face.
  function prong(padOnLeft: boolean): THREE.Group {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(20, 30, 92), silver);
    shell.position.z = 96;
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 22, 12), silver);
    tip.rotation.x = Math.PI / 2; // cylinder axis Y -> Z
    tip.scale.x = 20 / 30; // match the 20 mm prong width
    tip.position.z = 142;
    const rubber = new THREE.Mesh(new THREE.BoxGeometry(6, 26, 44), pad);
    rubber.position.set(padOnLeft ? 7 : -7, 0, 118);
    g.add(shell, tip, rubber);
    return g;
  }
  const left = prong(true);
  const right = prong(false);
  group.add(left, right);

  // Time-based travel: 0 = closed (prongs touch), 1 = fully open (80 mm).
  let openCur = 0, openTarget = 0, lastT = 0;
  let stroke = 0.7; // seconds for the full stroke; 'slow' mode raises this

  return {
    group,
    setOpen(t: number) {
      openTarget = THREE.MathUtils.clamp(t, 0, 1);
      const now = performance.now() / 1000;
      const dt = lastT ? Math.min(now - lastT, 0.1) : 0;
      lastT = now;
      const step = stroke > 0 ? dt / stroke : 1;
      if (openCur < openTarget) openCur = Math.min(openCur + step, openTarget);
      else if (openCur > openTarget) openCur = Math.max(openCur - step, openTarget);
      const half = 11 + openCur * 40; // prong centre: closed ±11, open ±51
      left.position.x = -half;
      right.position.x = half;
    },
    setSpeed(seconds: number) {
      stroke = Math.max(0.05, seconds);
    },
  };
}

function applyTransform(obj: THREE.Object3D, m: Float64Array): void {
  const mat = new THREE.Matrix4().fromArray(Array.from(m) as number[]);
  mat.decompose(obj.position, obj.quaternion, obj.scale);
}

function applyOrigin(node: THREE.Group, origin: Float64Array): void {
  const mat = new THREE.Matrix4().fromArray(Array.from(origin) as number[]);
  mat.decompose(node.position, node.quaternion, node.scale);
}

function matrixPosition(m: Float64Array): THREE.Vector3 {
  return new THREE.Vector3(m[12], m[13], m[14]);
}

function mkMat(color: number, roughness = 0.6, metalness = 0.2): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
