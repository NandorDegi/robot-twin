import * as THREE from "three";
import { BOARD } from "@robot/chess";

export interface ChessBoardView {
  group: THREE.Group;
  setFen(fen: string): void;
}

const SQUARE_LIGHT = 0xd9c9a3;
const SQUARE_DARK = 0x6b5136;
const WHITE = 0xece7dd;
const BLACK = 0x23272e;

function squareCenter(col: number, row: number): [number, number] {
  // a-file at the high-X corner (BOARD.origin); files run toward -X, ranks toward +Z.
  return [
    BOARD.origin[0] - (col + 0.5) * BOARD.square,
    BOARD.origin[2] + (row + 0.5) * BOARD.square,
  ];
}

type Pt = [number, number];

// Staunton-style bodies, as a lathe profile: [radius, height].
const P_PAWN: Pt[] = [
  [0, 0], [8.5, 0], [9.5, 1.5], [8.5, 3], [6, 4.5], [5, 6], [4.3, 10], [3.8, 13],
  [4.3, 14.5], [5.5, 15.5], [6.5, 18], [6, 21], [5, 24], [2.8, 25.6], [0, 26],
];
const P_ROOK: Pt[] = [
  [0, 0], [9.5, 0], [10.5, 1.8], [9.5, 3.6], [9, 6], [8.8, 24], [11, 26], [11.5, 28], [0, 28],
];
const P_KNIGHT: Pt[] = [
  [0, 0], [9, 0], [10, 1.8], [9, 3.6], [7.5, 5], [6, 8], [5.5, 14], [6, 20], [6.5, 22], [4, 23], [0, 23],
];
const P_BISHOP: Pt[] = [
  [0, 0], [9, 0], [10, 1.8], [9, 3.6], [6.5, 5], [5, 7], [4.5, 12], [4, 20], [5.5, 22],
  [7, 25], [6.8, 28], [4, 30.5], [0, 31],
];
const P_QUEEN: Pt[] = [
  [0, 0], [9.5, 0], [10.5, 1.8], [9.5, 3.6], [7.5, 6], [6, 10], [5.5, 18], [5.5, 26],
  [6.5, 30], [8, 32], [0, 32],
];
const P_KING: Pt[] = [
  [0, 0], [9.5, 0], [10.5, 1.8], [9.5, 3.6], [7.5, 6], [6, 10], [5.5, 20], [5.5, 32],
  [6.5, 36], [8, 38], [0, 38],
];

function latheMesh(pts: Pt[], mat: THREE.Material): THREE.Mesh {
  const v = pts.map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.Mesh(new THREE.LatheGeometry(v, 48), mat);
}

function addSphere(g: THREE.Group, mat: THREE.Material, r: number, y: number, x = 0, z = 0): void {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat);
  m.position.set(x, y, z);
  g.add(m);
}

function addBox(g: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): void {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  g.add(m);
}

// Horse-head silhouette (forward = +X), extruded along Z so its flat side
// faces the camera.
function knightHead(mat: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  s.moveTo(-8, 0);
  s.lineTo(-11, 6);
  s.lineTo(-10, 14);
  s.lineTo(-8, 21);
  s.lineTo(-6, 26);
  s.lineTo(-3, 30);
  s.lineTo(-2, 26);
  s.lineTo(1, 27);
  s.lineTo(1, 23);
  s.lineTo(6, 18);
  s.lineTo(11, 14);
  s.lineTo(13, 11);
  s.lineTo(11, 8);
  s.lineTo(6, 9);
  s.lineTo(2, 9);
  s.lineTo(-1, 5);
  s.lineTo(-1, 0);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 9,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 1.2,
    bevelThickness: 1.2,
  });
  return new THREE.Mesh(geo, mat);
}

function pieceMesh(type: string, color: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.12 });

  if (type === "p") {
    g.add(latheMesh(P_PAWN, mat));
  } else if (type === "r") {
    g.add(latheMesh(P_ROOK, mat));
    // Crenellations around the top rim.
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      addBox(g, mat, 3, 4.5, 3, Math.cos(a) * 9.2, 30.2, Math.sin(a) * 9.2);
    }
  } else if (type === "n") {
    g.add(latheMesh(P_KNIGHT, mat));
    const head = knightHead(mat);
    head.scale.setScalar(0.55);
    head.position.set(0.5, 21, -2.5);
    g.add(head);
  } else if (type === "b") {
    g.add(latheMesh(P_BISHOP, mat));
    addSphere(g, mat, 2.4, 32.4);
  } else if (type === "q") {
    g.add(latheMesh(P_QUEEN, mat));
    addSphere(g, mat, 3, 34);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      addSphere(g, mat, 1.5, 32.6, Math.cos(a) * 7.4, Math.sin(a) * 7.4);
    }
  } else if (type === "k") {
    g.add(latheMesh(P_KING, mat));
    addBox(g, mat, 2.6, 11, 2.6, 0, 43.5, 0);
    addBox(g, mat, 8.5, 2.6, 2.6, 0, 45.5, 0);
  }
  return g;
}

export function buildBoard(): ChessBoardView {
  const group = new THREE.Group();
  const surfaces = new THREE.Group();
  group.add(surfaces);

  // Board squares (X-Z plane, Y-up).
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const [x, z] = squareCenter(col, row);
      const light = (row + col) % 2 === 1;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(BOARD.square, 6, BOARD.square),
        new THREE.MeshStandardMaterial({ color: light ? SQUARE_LIGHT : SQUARE_DARK, roughness: 0.7 }),
      );
      box.position.set(x, BOARD.origin[1] + 3, z);
      surfaces.add(box);
    }
  }

  // Frame (board base), centred on the 8x8 grid. Files run toward -X from the
  // a-file corner, so the grid centre is origin_x - 4*square.
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(8 * BOARD.square + 10, 8, 8 * BOARD.square + 10),
    new THREE.MeshStandardMaterial({ color: 0x3a2b1c, roughness: 0.8 }),
  );
  frame.position.set(BOARD.origin[0] - 4 * BOARD.square, BOARD.origin[1] - 2, BOARD.origin[2] + 4 * BOARD.square);
  surfaces.add(frame);

  const piecesGroup = new THREE.Group();
  group.add(piecesGroup);

  // Rebuilding 32 pieces with fresh geometry/material is expensive and leaks if
  // the old resources are not disposed. Cache the last FEN so a rebuild happens
  // only when the position actually changes, and dispose resources on rebuild.
  let lastFen = "";
  function disposeObject(o: THREE.Object3D): void {
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else if (mat) {
        mat.dispose();
      }
    });
  }

  function setFen(fen: string): void {
    if (fen === lastFen) return;
    lastFen = fen;
    for (const child of piecesGroup.children) disposeObject(child);
    piecesGroup.clear();
    const placement = fen.split(" ")[0]!;
    const rows = placement.split("/");
    for (let r = 0; r < 8; r++) {
      let col = 0;
      for (const ch of rows[r]!) {
        if (/[1-8]/.test(ch)) {
          col += Number(ch);
        } else {
          const whiteP = ch === ch.toUpperCase();
          const type = ch.toLowerCase();
          const [x, z] = squareCenter(col, 7 - r);
          const mesh = pieceMesh(type, whiteP ? WHITE : BLACK);
          // The piece mesh origin is at its base; sit it on the board surface.
          mesh.position.set(x, BOARD.origin[1] + 6, z);
          piecesGroup.add(mesh);
          col++;
        }
      }
    }
  }

  return { group, setFen };
}
