import {
  legalMoves,
  parseSquare,
  pieceAt,
  squareName,
  type Move,
  type PieceType,
  type Position,
} from "./engine";
import { moveToSan } from "./san";

const FILES = "abcdefgh";
const RANK_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};
const PIECE_WORDS: Record<string, PieceType> = {
  knight: "n", night: "n", bishop: "b", rook: "r", queen: "q", king: "k",
};

/**
 * Map a spoken chess phrase to Standard Algebraic Notation, resolved against
 * the position BEFORE the move. The resolved SAN matches a legal move, so
 * captures, castling, checks and disambiguation are correct.
 *
 * Returns null when the phrase does not describe exactly one legal move.
 */
export function spokenToSan(pos: Position, text: string): string | null {
  const t = normalize(text);
  if (!t) return null;

  // ---- castling ---------------------------------------------------------
  if (/\b(castle|castles|castling|o-o|o-o-o)\b/.test(t)) {
    const long = /\b(long|queenside|queen side|o-o-o)\b/.test(t);
    const short = /\b(short|kingside|king side|o-o)\b/.test(t);
    const castleMoves = legalMoves(pos, pos.turn).filter((m) =>
      m.flags.includes("castle-k") || m.flags.includes("castle-q"),
    );
    const pick = castleMoves.find((m) =>
      long ? m.flags.includes("castle-q") : m.flags.includes("castle-k"),
    );
    if (pick) return moveToSan(pos, pick);
    if (castleMoves.length === 1) return moveToSan(pos, castleMoves[0]);
    if (castleMoves.length === 2) {
      // "castle" alone is ambiguous, but prefer king-side (the common case).
      const k = castleMoves.find((m) => m.flags.includes("castle-k"));
      if (k && !long) return moveToSan(pos, k);
    }
    return null;
  }

  // ---- fields -----------------------------------------------------------
  const dest = findSquare(t);
  const pieceWord = pieceOf(t);
  const capture = /\b(take|takes|took|capture|captures|en passant|x)\b/.test(t);
  const src = /\b([a-h])\s*(?:takes|captures|en passant|x)\b/.exec(t);
  const srcFile = src ? src[1] : undefined;
  const promoRank = pos.turn === "w" ? 8 : 1;

  let movingPiece: PieceType | undefined = pieceWord?.p;
  let promo: PieceType | undefined;
  if (pieceWord && dest && pieceWord.index > dest.index && dest.rank === promoRank) {
    // "e8 queen" / "e8 promotes to queen": piece word after dest on the
    // promotion rank is the promoted piece, not the moving piece.
    promo = pieceWord.p;
    movingPiece = undefined;
  } else if (/\b(promote|promotion|promotes|equals?)\b/.test(t)) {
    promo = pieceWord?.p;
    movingPiece = undefined;
  }

  let cand = legalMoves(pos, pos.turn);
  if (movingPiece) cand = cand.filter((m) => m.piece === movingPiece);
  else if (!capture && !srcFile) cand = cand.filter((m) => m.piece === "p");
  if (dest) {
    const toName = `${dest.file}${dest.rank}`;
    cand = cand.filter((m) => squareName(m.to) === toName);
  }
  if (capture) cand = cand.filter((m) => isCapture(pos, m));
  if (srcFile && !movingPiece) {
    cand = cand.filter((m) => m.piece === "p" && FILES[m.from.c] === srcFile);
  }
  if (promo) cand = cand.filter((m) => m.promotion === promo);

  // ---- select the move ---------------------------------------------------
  if (cand.length === 1) return moveToSan(pos, cand[0]);

  // No piece word, no capture: "e4" style. A pawn move is the natural read.
  if (cand.length > 1 && !movingPiece && !capture && !srcFile) {
    const pawns = cand.filter((m) => m.piece === "p");
    if (pawns.length === 1) return moveToSan(pos, pawns[0]);
  }
  // "takes c6" with a single capturing piece: use it.
  if (cand.length > 1 && !movingPiece && capture && !srcFile) {
    if (new Set(cand.map((m) => m.piece)).size === 1) {
      return moveToSan(pos, cand[0]);
    }
    return null;
  }
  if (cand.length === 0 && !movingPiece && !capture && !srcFile) {
    // Pawn default found nothing; the user may have omitted the piece.
    const any = legalMoves(pos, pos.turn).filter(
      (m) => dest && squareName(m.to) === `${dest.file}${dest.rank}`,
    );
    if (any.length === 1) return moveToSan(pos, any[0]);
  }
  return null;
}

function isCapture(pos: Position, m: Move): boolean {
  if (m.flags.includes("ep")) return true;
  const target = pieceAt(pos.board, m.to);
  return target !== null && target.color !== m.color;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?]/g, " ")
    .replace(
      /\b(to|the|on|at|into|onto|please|move|moves|now|my|ok|okay|um|uh|like|and|then|with|an)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function pieceOf(text: string): { p: PieceType; index: number } | null {
  let best: { p: PieceType; index: number } | null = null;
  for (const [word, p] of Object.entries(PIECE_WORDS)) {
    const m = new RegExp(`\\b${word}\\b`).exec(text);
    if (m && (!best || m.index < best.index)) best = { p, index: m.index };
  }
  return best;
}

function findSquare(text: string): { file: string; rank: number; index: number } | null {
  const re = /([a-h])\s*(?:([1-8])|(one|two|three|four|five|six|seven|eight))\b/g;
  let best: { file: string; rank: number; index: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rank = m[2] ? Number(m[2]) : RANK_WORDS[m[3]!]!;
    if (rank >= 1 && rank <= 8) best = { file: m[1]!, rank, index: m.index };
  }
  return best;
}
