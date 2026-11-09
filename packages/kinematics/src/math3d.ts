/**
 * Minimal column-major 4x4 matrix library, no external dependencies.
 *
 * A Mat4 is a Float64Array of length 16 in column-major order, matching
 * the convention used by gl-matrix and three.js. Element (row r, column c)
 * lives at index c * 4 + r.
 */

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export function mat4Identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** result = a * b */
export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    r[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    r[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    r[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    r[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return r;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
  const m = mat4Identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function mat4RotX(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  const m = mat4Identity();
  // column-major: col1 = [0, c, s, 0], col2 = [0, -s, c, 0]
  m[5] = c; m[6] = s;
  m[9] = -s; m[10] = c;
  return m;
}

export function mat4RotY(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  const m = mat4Identity();
  m[0] = c; m[2] = -s;
  m[8] = s; m[10] = c;
  return m;
}

export function mat4RotZ(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  const m = mat4Identity();
  m[0] = c; m[1] = s;
  m[4] = -s; m[5] = c;
  return m;
}

/** Rotation about an arbitrary (unit or non-unit) axis. Rodrigues formula. */
export function mat4RotAxis(axis: Vec3, theta: number): Mat4 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len < 1e-12) return mat4Identity();
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const c = Math.cos(theta), s = Math.sin(theta), t = 1 - c;
  const m = new Float64Array(16);
  m[0] = t * x * x + c;
  m[1] = t * x * y + s * z;
  m[2] = t * x * z - s * y;
  m[3] = 0;
  m[4] = t * x * y - s * z;
  m[5] = t * y * y + c;
  m[6] = t * y * z + s * x;
  m[7] = 0;
  m[8] = t * x * z + s * y;
  m[9] = t * y * z - s * x;
  m[10] = t * z * z + c;
  m[11] = 0;
  m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
  return m;
}

/** Multiply position vector by affine transform (ignore homogeneous divide). */
export function mat4TransformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Multiply direction vector by the rotation part of the transform. */
export function mat4TransformDir(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}

/** Extract the translation of a transform. */
export function mat4TranslationOf(m: Mat4): Vec3 {
  return [m[12], m[13], m[14]];
}

/** Add 3x3 rotation matrices: (a + b). Returns column-major 3x3 length 9. */
export function mat3Add3(a: Float64Array, b: Float64Array): Float64Array {
  const r = new Float64Array(9);
  for (let i = 0; i < 9; i++) r[i] = a[i] + b[i];
  return r;
}

/** Convert a 3x3 column-major (length 9) back into a 4x4 homogeneous matrix. */
export function mat4FromMat3(m3: Float64Array): Mat4 {
  const m = mat4Identity();
  for (let c = 0; c < 3; c++) {
    m[c * 4] = m3[c * 3];
    m[c * 4 + 1] = m3[c * 3 + 1];
    m[c * 4 + 2] = m3[c * 3 + 2];
  }
  return m;
}

export function vec3Subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l < 1e-12) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function vec3Length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * Rotation matrix (3x3, column-major length 9) from a 4x4 transform.
 */
export function mat4ToMat3(m: Mat4): Float64Array {
  return new Float64Array([
    m[0], m[1], m[2],
    m[4], m[5], m[6],
    m[8], m[9], m[10],
  ]);
}

/**
 * Rotation vector (axis * angle), in the WORLD frame, that takes `from` to
 * `to`: exp([w]x) * from = to, i.e. the log map of R_err = to * from^T.
 * Both inputs are 3x3 rotation matrices in column-major order (length 9).
 * The IK uses it as the orientation error, and its Jacobian rows are world
 * axes, so the error must be in the world frame too.
 */
export function rotationVector(from: Float64Array, to: Float64Array): Vec3 {
  // Column-major: element (row, col) is at col * 3 + row.
  const at = (m: Float64Array, row: number, col: number) => m[col * 3 + row]!;
  // R = to * from^T  ->  R(i,j) = sum_k to(i,k) * from(j,k)
  const R = (i: number, j: number) =>
    at(to, i, 0) * at(from, j, 0) + at(to, i, 1) * at(from, j, 1) + at(to, i, 2) * at(from, j, 2);
  const r00 = R(0, 0), r11 = R(1, 1), r22 = R(2, 2);
  const sx = R(2, 1) - R(1, 2);
  const sy = R(0, 2) - R(2, 0);
  const sz = R(1, 0) - R(0, 1);
  const sinTimes2 = Math.hypot(sx, sy, sz);
  const cos = Math.min(1, Math.max(-1, (r00 + r11 + r22 - 1) / 2));
  const angle = Math.atan2(sinTimes2 / 2, cos);
  if (angle < 1e-9) return [0, 0, 0];
  if (Math.PI - angle > 1e-4) {
    const k = angle / sinTimes2;
    return [sx * k, sy * k, sz * k];
  }
  // Near 180 deg the skew part vanishes: take the axis from the diagonal.
  const xx = Math.sqrt(Math.max(0, (r00 + 1) / 2));
  const yy = Math.sqrt(Math.max(0, (r11 + 1) / 2));
  const zz = Math.sqrt(Math.max(0, (r22 + 1) / 2));
  let axis: Vec3;
  if (xx >= yy && xx >= zz) axis = [xx, (R(0, 1) + R(1, 0)) / (4 * xx), (R(0, 2) + R(2, 0)) / (4 * xx)];
  else if (yy >= zz) axis = [(R(0, 1) + R(1, 0)) / (4 * yy), yy, (R(1, 2) + R(2, 1)) / (4 * yy)];
  else axis = [(R(0, 2) + R(2, 0)) / (4 * zz), (R(1, 2) + R(2, 1)) / (4 * zz), zz];
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / n) * angle, (axis[1] / n) * angle, (axis[2] / n) * angle];
}
