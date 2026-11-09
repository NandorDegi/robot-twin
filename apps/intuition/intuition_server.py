"""Intuition sidecar: a searchless move-policy network over HTTP.

Model: DeepMind "searchless_chess" action-value transformer (Ruoss et al.,
NeurIPS 2024; code Apache-2.0, weights CC-BY-4.0). For each legal move the
network predicts the win probability of (position, move) in one batched
forward pass. There is no search tree. We turn the win probabilities into a
move distribution with a softmax at temperature T.

    POST /policy  {"fen": "...", "history": ["e2e4", ...], "startFen": "..."}
      -> {"model": "searchless-9M", "moves": [{"uci", "prob", "winProb"}], "elapsedMs"}
    GET  /health  -> {"status": "ok", "model": ...}

The TS side (@robot/brain HttpPolicyModel) filters the moves through its own
legal-move generator again; this service is never trusted on legality.

Usage:
    python intuition_server.py serve --root /opt/searchless --model 9M
    python intuition_server.py bench --root /opt/searchless --model 9M
`--root` is the directory that CONTAINS the cloned `searchless_chess` repo;
checkpoints are read from <root>/searchless_chess/checkpoints/<model>/.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# name -> (num_layers, embedding_dim, num_heads); from searchless_chess/src/engines/constants.py
MODELS = {
    "9M": (8, 256, 8),
    "136M": (8, 1024, 8),
    "270M": (16, 1024, 8),
}
CHECKPOINT_STEP = 6_400_000
NUM_RETURN_BUCKETS = 128
# Pad each batch (one row per legal move) to a fixed size, so jit compiles a
# small set of shapes once. Cost is linear in the batch, so keep the steps small.
_BATCH_BUCKETS = (16, 32, 48, 64, 96, 128, 224)


def _stub_training_only_imports() -> None:
    """searchless_chess/src/constants.py imports apache_beam and grain for its
    data pipeline. Inference does not use them, so stub them instead of
    installing Apache Beam on the NUC."""
    if "apache_beam" not in sys.modules:
        try:
            import apache_beam  # noqa: F401
        except ImportError:
            class _Coder:
                def __init__(self, *a, **k):
                    pass

            beam = types.ModuleType("apache_beam")
            coders = types.ModuleType("apache_beam.coders")
            for n in ("StrUtf8Coder", "BigIntegerCoder", "FloatCoder", "TupleCoder", "BytesCoder"):
                setattr(coders, n, _Coder)
            beam.coders = coders
            sys.modules["apache_beam"] = beam
            sys.modules["apache_beam.coders"] = coders
    if "grain" not in sys.modules:
        try:
            import grain.python  # noqa: F401
        except ImportError:
            grain = types.ModuleType("grain")
            gpy = types.ModuleType("grain.python")
            gpy.DataLoader = object
            grain.python = gpy
            sys.modules["grain"] = grain
            sys.modules["grain.python"] = gpy


class SearchlessPolicy:
    def __init__(self, root: str, model: str = "9M", temperature: float = 0.05, checkpoint_dir: str | None = None):
        if model not in MODELS:
            raise ValueError(f"unknown model {model}; choose one of {sorted(MODELS)}")
        if not os.path.isdir(os.path.join(root, "searchless_chess")):
            raise FileNotFoundError(f"{root}/searchless_chess not found: clone google-deepmind/searchless_chess there")
        sys.path.insert(0, root)
        _stub_training_only_imports()
        import jax
        import numpy as np
        import orbax.checkpoint as ocp
        from jax import random as jrandom
        from searchless_chess.src import tokenizer, transformer, utils

        self.np, self.tokenizer, self.utils = np, tokenizer, utils
        self.name = f"searchless-{model}"
        self.temperature = temperature
        layers, dim, heads = MODELS[model]
        cfg = transformer.TransformerConfig(
            vocab_size=utils.NUM_ACTIONS,
            output_size=NUM_RETURN_BUCKETS,
            pos_encodings=transformer.PositionalEncodings.LEARNED,
            max_sequence_length=tokenizer.SEQUENCE_LENGTH + 2,
            num_heads=heads,
            num_layers=layers,
            embedding_dim=dim,
            apply_post_ln=True,
            apply_qk_layernorm=False,
            use_causal_mask=False,
        )
        predictor = transformer.build_transformer_predictor(config=cfg)
        init = predictor.initial_params(rng=jrandom.PRNGKey(1), targets=np.ones((1, 1), dtype=np.uint32))
        ckpt = checkpoint_dir or os.path.join(root, "searchless_chess", "checkpoints", model)
        path = os.path.join(os.path.abspath(ckpt), str(CHECKPOINT_STEP), "params")
        if not os.path.isdir(path):
            raise FileNotFoundError(f"checkpoint not found: {path} (run checkpoints/download.sh or see docs/BRAIN.md)")
        checkpointer = ocp.Checkpointer(ocp.PyTreeCheckpointHandler())
        self.params = checkpointer.restore(path, restore_args=ocp.checkpoint_utils.construct_restore_args(init))
        self._predict = jax.jit(predictor.predict)
        _, self.bucket_values = utils.get_uniform_buckets_edges_values(NUM_RETURN_BUCKETS)

    def warmup(self) -> None:
        """Compile every batch shape now, so no move pays the jit compile (0.5-1 s each)."""
        np = self.np
        for size in _BATCH_BUCKETS:
            out = self._predict(params=self.params, targets=np.zeros((size, self.tokenizer.SEQUENCE_LENGTH + 2), np.int32), rng=None)
            np.asarray(out)  # JAX dispatch is asynchronous: wait for the compile + run

    def board(self, fen: str, history: list[str] | None = None, start_fen: str | None = None):
        """Rebuild the board with python-chess. Prefer start + history (correct
        clocks and repetition); fall back to the FEN if they disagree."""
        import chess

        if history:
            try:
                b = chess.Board(start_fen) if start_fen else chess.Board()
                for u in history:
                    b.push_uci(u)
                if b.board_fen() == fen.split(" ")[0]:
                    return b
            except ValueError:
                pass
        return chess.Board(fen)

    def policy(self, fen: str, history: list[str] | None = None, start_fen: str | None = None) -> list[dict]:
        np = self.np
        b = self.board(fen, history, start_fen)
        moves = sorted(b.legal_moves, key=lambda m: self.utils.MOVE_TO_ACTION[m.uci()])
        if not moves:
            return []
        actions = np.array([[self.utils.MOVE_TO_ACTION[m.uci()]] for m in moves], dtype=np.int32)
        tokens = self.tokenizer.tokenize(b.fen()).astype(np.int32)
        seqs = np.concatenate([np.stack([tokens] * len(moves)), actions, np.zeros((len(moves), 1), np.int32)], axis=1)
        n = len(moves)
        size = next((s for s in _BATCH_BUCKETS if s >= n), n)
        if size > n:
            seqs = np.concatenate([seqs, np.repeat(seqs[:1], size - n, axis=0)], axis=0)
        log_probs = np.asarray(self._predict(params=self.params, targets=seqs, rng=None))[:n, -1]
        win = np.exp(log_probs) @ self.bucket_values
        for i, m in enumerate(moves):  # a move into a repetition is a draw (as in the original engine)
            b.push(m)
            if b.is_fivefold_repetition() or b.can_claim_threefold_repetition():
                win[i] = 0.5
            b.pop()
        z = (win - win.max()) / max(self.temperature, 1e-6)
        p = np.exp(z) / np.exp(z).sum()
        out = [{"uci": m.uci(), "prob": float(p[i]), "winProb": float(win[i])} for i, m in enumerate(moves)]
        return sorted(out, key=lambda x: -x["prob"])


def make_handler(model: SearchlessPolicy):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code: int, obj) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"status": "ok", "model": model.name})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/policy":
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(min(n, 1 << 20)) or b"{}")
                fen = str(req["fen"])
                t0 = time.perf_counter()
                moves = model.policy(fen, [str(x) for x in req.get("history") or []], req.get("startFen"))
                self._send(200, {"model": model.name, "moves": moves, "elapsedMs": round((time.perf_counter() - t0) * 1000, 1)})
            except (KeyError, ValueError, TypeError) as exc:
                self._send(400, {"error": f"bad request: {exc}"})

    return Handler


BENCH_FENS = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7",
    "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 4 9",
    "8/5pk1/6p1/8/3R4/6P1/5PK1/1r6 b - - 0 40",
]


def bench(model: SearchlessPolicy, rounds: int) -> dict:
    import resource

    model.warmup()
    times = []
    for _ in range(rounds):
        for fen in BENCH_FENS:
            t0 = time.perf_counter()
            model.policy(fen)
            times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    return {
        "model": model.name,
        "positions": len(times),
        "p50_ms": round(times[len(times) // 2], 1),
        "max_ms": round(times[-1], 1),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 0),
        "top_move_start": model.policy(BENCH_FENS[0])[0],
    }


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=["serve", "bench"])
    ap.add_argument("--root", default=os.environ.get("SEARCHLESS_ROOT", "/opt/searchless"))
    ap.add_argument("--model", default=os.environ.get("SEARCHLESS_MODEL", "9M"), choices=sorted(MODELS))
    ap.add_argument("--checkpoint-dir", default=os.environ.get("SEARCHLESS_CHECKPOINT_DIR"))
    ap.add_argument("--temperature", type=float, default=float(os.environ.get("SEARCHLESS_TEMPERATURE", "0.05")))
    ap.add_argument("--host", default=os.environ.get("INTUITION_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("INTUITION_PORT", "8095")))
    ap.add_argument("--rounds", type=int, default=3)
    a = ap.parse_args(argv)
    t0 = time.perf_counter()
    model = SearchlessPolicy(a.root, a.model, a.temperature, a.checkpoint_dir)
    model.warmup()
    load_s = time.perf_counter() - t0
    if a.cmd == "bench":
        r = bench(model, a.rounds)
        r["load_s"] = round(load_s, 1)
        print(json.dumps(r, indent=2))
        return
    print(f"[intuition] {model.name} loaded in {load_s:.1f}s; listening on http://{a.host}:{a.port}", flush=True)
    ThreadingHTTPServer((a.host, a.port), make_handler(model)).serve_forever()


if __name__ == "__main__":
    main()
