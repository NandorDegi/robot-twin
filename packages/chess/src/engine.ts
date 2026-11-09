export type Color = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export interface Square {
  r: number; // 0..7, 0 = rank 8 (top of the board)
  c: number; // 0..7, 0 = file a (left)
}

export interface Piece {
  color: Color;
  type: PieceType;
}

export type Board = (Piece | null)[][];

export interface CastlingRights {
  wk: boolean;
  wq: boolean;
  bk: boolean;
  bq: boolean;
}

export interface Position {
  board: Board;
  turn: Color;
  castling: CastlingRights;
  epTarget: Square | null;
  halfmove: number;
  fullmove: number;
}

export interface Move {
  from: Square;
  to: Square;
  color: Color;
  piece: PieceType;
  promotion?: PieceType;
  flags: string[];
}

const FILES = "abcdefgh";
const BACK_RANK_W = 7; // rank 1 for white
const BACK_RANK_B = 0; // rank 8 for black

export function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

export function squareName(sq: Square): string {
  return `${FILES[sq.c]}${8 - sq.r}`;
}

export function parseSquare(name: string): Square {
  const c = FILES.indexOf(name[0]!);
  const r = 8 - Number(name[1]);
  if (c < 0 || c > 7 || r < 0 || r > 7) throw new Error(`bad square ${name}`);
  return { r, c };
}

export function cloneBoard(b: Board): Board {
  return b.map((row) => row.slice());
}

export function clonePosition(pos: Position): Position {
  return {
    board: cloneBoard(pos.board),
    turn: pos.turn,
    castling: { ...pos.castling },
    epTarget: pos.epTarget ? { ...pos.epTarget } : null,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
  };
}

const OPP: Record<Color, Color> = { w: "b", b: "w" };

export function pieceAt(b: Board, sq: Square): Piece | null {
  return b[sq.r]?.[sq.c] ?? null;
}

export function findKing(b: Board, color: Color): Square | null {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = b[r]![c];
      if (p && p.type === "k" && p.color === color) return { r, c };
    }
  }
  return null;
}

function pawnDir(color: Color): number {
  return color === "w" ? -1 : 1;
}

function pawnStartRank(color: Color): number {
  return color === "w" ? 6 : 1;
}

function pawnPromotionRank(color: Color): number {
  return color === "w" ? 0 : 7;
}

// --- attack detection --------------------------------------------------------

export function isSquareAttacked(b: Board, sq: Square, by: Color): boolean {
  const { r, c } = sq;
  // Pawn attacks.
  const pd = pawnDir(by) * -1; // a pawn of color `by` attacks diagonally forward
  for (const dc of [-1, 1]) {
    const nr = r + pd, nc = c + dc;
    if (inBounds(nr, nc)) {
      const p = b[nr]![nc];
      if (p && p.color === by && p.type === "p") return true;
    }
  }
  // Knight attacks.
  for (const [dr, dc] of KNIGHT_DELTAS) {
    const nr = r + dr, nc = c + dc;
    if (inBounds(nr, nc)) {
      const p = b[nr]![nc];
      if (p && p.color === by && p.type === "n") return true;
    }
  }
  // King attacks.
  for (const [dr, dc] of KING_DELTAS) {
    const nr = r + dr, nc = c + dc;
    if (inBounds(nr, nc)) {
      const p = b[nr]![nc];
      if (p && p.color === by && p.type === "k") return true;
    }
  }
  // Sliding pieces: rook/queen along orthogonals, bishop/queen diagonals.
  for (const [dr, dc, isDiag] of SLIDE_DELTAS) {
    for (let d = 1; ; d++) {
      const nr = r + dr * d, nc = c + dc * d;
      if (!inBounds(nr, nc)) break;
      const p = b[nr]![nc];
      if (p) {
        if (p.color === by) {
          if (isDiag && (p.type === "b" || p.type === "q")) return true;
          if (!isDiag && (p.type === "r" || p.type === "q")) return true;
        }
        break;
      }
    }
  }
  return false;
}

export function isInCheck(pos: Position, color: Color): boolean {
  const king = findKing(pos.board, color);
  // In applyMove we detect check; guard a missing king as not in check.
  if (!king) return false;
  const attacker: Color = OPP[color];
  return isSquareAttacked(pos.board, king, attacker);
}

// --- move generation ----------------------------------------------------------

const KNIGHT_DELTAS = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
] as const;
const KING_DELTAS = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
] as const;
const SLIDE_DELTAS: [number, number, boolean][] = [
  [-1, 0, false], [1, 0, false], [0, -1, false], [0, 1, false],
  [-1, -1, true], [-1, 1, true], [1, -1, true], [1, 1, true],
];

export function pseudoLegalMoves(pos: Position, color: Color): Move[] {
  const moves: Move[] = [];
  const b = pos.board;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = b[r]![c];
      if (!p || p.color !== color) continue;
      const from = { r, c };
      switch (p.type) {
        case "p":
          addPawnMoves(pos, from, p, moves);
          break;
        case "n":
          addStepMoves(pos, from, p, KNIGHT_DELTAS, moves);
          break;
        case "k":
          addStepMoves(pos, from, p, KING_DELTAS, moves);
          addCastling(pos, color, from, moves);
          break;
        case "b":
          addSlideMoves(pos, from, p, [true], moves);
          break;
        case "r":
          addSlideMoves(pos, from, p, [false], moves);
          break;
        case "q":
          addSlideMoves(pos, from, p, [true, false], moves);
          break;
      }
    }
  }
  return moves;
}

function addStepMoves(
  pos: Position,
  from: Square,
  piece: Piece,
  deltas: readonly (readonly [number, number])[],
  out: Move[],
): void {
  const b = pos.board;
  for (const [dr, dc] of deltas) {
    const nr = from.r + dr, nc = from.c + dc;
    if (!inBounds(nr, nc)) continue;
    const target = b[nr]![nc];
    if (target && target.color === piece.color) continue;
    out.push({ from, to: { r: nr, c: nc }, color: piece.color, piece: piece.type, flags: [] });
  }
}

function addSlideMoves(
  pos: Position,
  from: Square,
  piece: Piece,
  diag: boolean[],
  out: Move[],
): void {
  const b = pos.board;
  for (const [dr, dc, isDiag] of SLIDE_DELTAS) {
    if (!diag.includes(isDiag)) continue;
    for (let d = 1; ; d++) {
      const nr = from.r + dr * d, nc = from.c + dc * d;
      if (!inBounds(nr, nc)) break;
      const target = b[nr]![nc];
      if (!target) {
        out.push({ from, to: { r: nr, c: nc }, color: piece.color, piece: piece.type, flags: [] });
      } else {
        if (target.color !== piece.color) {
          out.push({ from, to: { r: nr, c: nc }, color: piece.color, piece: piece.type, flags: [] });
        }
        break;
      }
    }
  }
}

function addPawnMoves(pos: Position, from: Square, piece: Piece, out: Move[]): void {
  const b = pos.board;
  const dir = pawnDir(piece.color);
  const promRank = pawnPromotionRank(piece.color);
  const one = from.r + dir;
  // Single push.
  if (inBounds(one, from.c) && !b[one]![from.c]) {
    pushPawnMove(out, piece, from, { r: one, c: from.c }, promRank);
    // Double push.
    if (from.r === pawnStartRank(piece.color)) {
      const two = from.r + 2 * dir;
      if (!b[two]![from.c]) {
        out.push({ from, to: { r: two, c: from.c }, color: piece.color, piece: piece.type, flags: ["double"] });
      }
    }
  }
  // Captures.
  for (const dc of [-1, 1]) {
    const nc = from.c + dc;
    if (!inBounds(one, nc)) continue;
    const target = b[one]![nc];
    if (target && target.color !== piece.color) {
      pushPawnMove(out, piece, from, { r: one, c: nc }, promRank);
    } else if (!target && pos.epTarget && pos.epTarget.r === one && pos.epTarget.c === nc) {
      out.push({ from, to: { r: one, c: nc }, color: piece.color, piece: piece.type, flags: ["ep"] });
    }
  }
}

function pushPawnMove(out: Move[], piece: Piece, from: Square, to: Square, promRank: number): void {
  if (to.r === promRank) {
    for (const pr of ["q", "r", "b", "n"] as PieceType[]) {
      out.push({ from, to, color: piece.color, piece: piece.type, promotion: pr, flags: [] });
    }
  } else {
    out.push({ from, to, color: piece.color, piece: piece.type, flags: [] });
  }
}

function addCastling(pos: Position, color: Color, from: Square, out: Move[]): void {
  if (from.r !== (color === "w" ? BACK_RANK_W : BACK_RANK_B) || from.c !== 4) return;
  const b = pos.board;
  const kingSide = color === "w" ? pos.castling.wk : pos.castling.bk;
  const queenSide = color === "w" ? pos.castling.wq : pos.castling.bq;
  const opponent = OPP[color];
  if (kingSide && isEmpty(b, from.r, 5) && isEmpty(b, from.r, 6) && pieceAt(b, { r: from.r, c: 7 })?.type === "r") {
    if (!isSquareAttacked(b, from, opponent) && !isSquareAttacked(b, { r: from.r, c: 5 }, opponent) && !isSquareAttacked(b, { r: from.r, c: 6 }, opponent)) {
      out.push({ from, to: { r: from.r, c: 6 }, color, piece: "k", flags: ["castle-k"] });
    }
  }
  if (queenSide && isEmpty(b, from.r, 3) && isEmpty(b, from.r, 2) && isEmpty(b, from.r, 1) && pieceAt(b, { r: from.r, c: 0 })?.type === "r") {
    if (!isSquareAttacked(b, from, opponent) && !isSquareAttacked(b, { r: from.r, c: 3 }, opponent) && !isSquareAttacked(b, { r: from.r, c: 2 }, opponent)) {
      out.push({ from, to: { r: from.r, c: 2 }, color, piece: "k", flags: ["castle-q"] });
    }
  }
}

function isEmpty(b: Board, r: number, c: number): boolean {
  return inBounds(r, c) && !b[r]![c];
}

// --- applying moves -----------------------------------------------------------

export function applyMove(pos: Position, move: Move): Position {
  const next = clonePosition(pos);
  const b = next.board;
  const moving = b[move.from.r]![move.from.c]!;
  // Read the capture BEFORE the piece moves (the destination is overwritten below).
  const captures = b[move.to.r]![move.to.c]?.color === OPP[moving.color] || move.flags.includes("ep");
  b[move.to.r]![move.to.c] = move.promotion ? { color: moving.color, type: move.promotion } : moving;
  b[move.from.r]![move.from.c] = null;

  // En passant: remove the captured pawn behind the destination.
  if (move.flags.includes("ep")) {
    const capRow = move.from.r; // captured pawn is on the same row as the mover
    b[capRow]![move.to.c] = null;
  }

  // Castling: move the rook.
  if (move.flags.includes("castle-k")) {
    b[move.from.r]![5] = b[move.from.r]![7];
    b[move.from.r]![7] = null;
  } else if (move.flags.includes("castle-q")) {
    b[move.from.r]![3] = b[move.from.r]![0];
    b[move.from.r]![0] = null;
  }

  // Update castling rights.
  updateCastling(next, move.from, move.to);

  // Update en-passant target when a pawn makes a double push.
  next.epTarget = null;
  if (moving.type === "p" && Math.abs(move.to.r - move.from.r) === 2) {
    next.epTarget = { r: (move.from.r + move.to.r) / 2, c: move.from.c };
  }

  // Halfmove clock.
  if (moving.type === "p" || captures) {
    next.halfmove = 0;
  } else {
    next.halfmove += 1;
  }

  next.turn = OPP[next.turn];
  if (next.turn === "w") next.fullmove += 1;
  return next;
}

function updateCastling(pos: Position, from: Square, to: Square): void {
  // King moved.
  if (pos.board[to.r]![to.c]?.type === "k") {
    if (from.c === 4 && from.r === BACK_RANK_W) { pos.castling.wk = false; pos.castling.wq = false; }
    if (from.c === 4 && from.r === BACK_RANK_B) { pos.castling.bk = false; pos.castling.bq = false; }
  }
  // Rook moved or captured on a rook starting square.
  const clear = (r: number, c: number) => {
    if (from.r === r && from.c === c) clearCorner(r === BACK_RANK_W, c);
    if (to.r === r && to.c === c) clearCorner(r === BACK_RANK_W, c);
  };
  const clearCorner = (whiteSide: boolean, c: number) => {
    if (c === 0) { if (whiteSide) pos.castling.wq = false; else pos.castling.bq = false; }
    if (c === 7) { if (whiteSide) pos.castling.wk = false; else pos.castling.bk = false; }
  };
  clear(BACK_RANK_W, 0);
  clear(BACK_RANK_W, 7);
  clear(BACK_RANK_B, 0);
  clear(BACK_RANK_B, 7);
}

// --- legal moves --------------------------------------------------------------

export function legalMoves(pos: Position, color: Color): Move[] {
  return pseudoLegalMoves(pos, color).filter((m) => {
    const next = applyMove(pos, m);
    return !isInCheck(next, color);
  });
}

export function isCheckmate(pos: Position): boolean {
  return isInCheck(pos, pos.turn) && legalMoves(pos, pos.turn).length === 0;
}

export function isStalemate(pos: Position): boolean {
  return !isInCheck(pos, pos.turn) && legalMoves(pos, pos.turn).length === 0;
}

// --- FEN -----------------------------------------------------------------------

export function initialPosition(): Position {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  return parseFen(fen);
}

export function parseFen(fen: string): Position {
  const [placement, turn = "w", castlingStr = "-", epStr = "-", half = "0", full = "1"] =
    fen.trim().split(/\s+/);
  const rows = placement.split("/");
  if (rows.length !== 8) throw new Error(`bad FEN placement: ${placement}`);
  const board: Board = [];
  for (let r = 0; r < 8; r++) {
    const row: (Piece | null)[] = [];
    for (const ch of rows[r]!) {
      if (/[1-8]/.test(ch)) {
        for (let k = 0; k < Number(ch); k++) row.push(null);
      } else {
        const color: Color = ch === ch.toUpperCase() ? "w" : "b";
        row.push({ color, type: ch.toLowerCase() as PieceType });
      }
    }
    board.push(row);
  }
  const castling: CastlingRights = {
    wk: castlingStr.includes("K"),
    wq: castlingStr.includes("Q"),
    bk: castlingStr.includes("k"),
    bq: castlingStr.includes("q"),
  };
  const epTarget = epStr === "-" ? null : parseSquare(epStr);
  return {
    board,
    turn: turn as Color,
    castling,
    epTarget,
    halfmove: Number(half),
    fullmove: Number(full),
  };
}

export function toFen(pos: Position): string {
  const rows = pos.board.map((row) => {
    let s = "";
    let empty = 0;
    for (const p of row) {
      if (!p) {
        empty++;
      } else {
        if (empty) { s += empty; empty = 0; }
        const ch = p.type;
        s += p.color === "w" ? ch.toUpperCase() : ch;
      }
    }
    if (empty) s += empty;
    return s;
  });
  const castling =
    (pos.castling.wk ? "K" : "") + (pos.castling.wq ? "Q" : "") +
    (pos.castling.bk ? "k" : "") + (pos.castling.bq ? "q" : "") || "-";
  const ep = pos.epTarget ? squareName(pos.epTarget) : "-";
  return `${rows.join("/")} ${pos.turn} ${castling} ${ep} ${pos.halfmove} ${pos.fullmove}`;
}
