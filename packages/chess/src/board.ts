/**
 * Chessboard placement in the robot frame (Y-up, millimetres) and the mapping
 * from a board square to a robot target. The board lies on the ground in front
 * of the arm; square 40 mm. These values should match the vision service's
 * board geometry (apps/vision/vision/config.py).
 */
export const BOARD = {
  /** Robot-frame position of the a1 square corner (in front of the arm base). */
  origin: [530, 0, -160] as [number, number, number],
  /** Side length of one square (mm). */
  square: 40,
  /** Height (mm) at which the gripper grabs / places a piece. */
  grabHeight: 45,
  /**
   * Optional yaw (degrees) of the board about its vertical (Y) axis in the twin
   * frame. 0 means the board is exactly axis-aligned: the a-h files run along
   * -X (a-file at the high-X corner, so a1 is on the player's left) and the
   * ranks along +Z. Set this when the physical board is rotated on the table;
   * the value must match `apps/vision/vision/config.py`
   * VISION_BOARD_ROTATION_DEG so the twin and vision agree.
   */
  rotationDeg: 0,
};

/** Board-plane (col, row) from a coordinate like "e4". */
export function boardCoords(square: string): { col: number; row: number } {
  const col = "abcdefgh".indexOf(square[0]);
  if (col < 0) throw new Error(`bad square ${square}`);
  const row = Number(square[1]) - 1;
  return { col, row };
}

/**
 * Rotate a board-plane local offset (along files, along ranks) by the board's
 * yaw about the vertical (Y) axis, then add it to BOARD.origin.
 *
 * The a-file is at the high-X corner (BOARD.origin) and files run toward -X,
 * so a file index maps to a negative X offset; ranks run toward +Z. This makes
 * the board read correctly from White's side (a1 at bottom-left).
 */
function boardOffset(
  fileIdx: number,
  rankIdx: number,
  origin: [number, number, number] = BOARD.origin,
  rotationDeg = BOARD.rotationDeg,
): [number, number, number] {
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const lx = -(fileIdx + 0.5) * BOARD.square;
  const lz = (rankIdx + 0.5) * BOARD.square;
  const x = lx * c + lz * s;
  const z = -lx * s + lz * c;
  return [origin[0] + x, origin[1], origin[2] + z];
}

/** Robot-frame target (mm) for the centre of a board square. */
export function squareToTarget(square: string): [number, number, number] {
  const { col, row } = boardCoords(square);
  const [x, , z] = boardOffset(col, row);
  return [x, BOARD.grabHeight, z];
}

/** Robot-frame target (mm) for the off-board capture tray. */
export function trayTarget(): [number, number, number] {
  const [x, , z] = boardOffset(9, 4);
  return [x, BOARD.grabHeight, z];
}
