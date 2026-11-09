#!/usr/bin/env node
// A fake lc0 for tests: speaks enough UCI and prints VerboseMoveStats lines.
// The policy includes one illegal move (e2e5) to prove the filter works.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const out = (s) => process.stdout.write(s + "\n");
rl.on("line", (line) => {
  const l = line.trim();
  if (l === "uci") { out("id name FakeLc0"); out("uciok"); }
  else if (l === "isready") out("readyok");
  else if (l.startsWith("go")) {
    out("info string e2e4  (322 ) N:       0 (+ 0) (P: 40.00%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q: -0.04212) (U: 0.43059) (S:  0.39) (V:  -.----)");
    out("info string d2d4  (293 ) N:       0 (+ 0) (P: 30.00%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q: -0.04212) (U: 0.43059) (S:  0.39) (V:  -.----)");
    out("info string e2e5  (300 ) N:       0 (+ 0) (P: 20.00%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q: -0.04212) (U: 0.43059) (S:  0.39) (V:  -.----)");
    out("info string g1f3  (159 ) N:       0 (+ 0) (P: 10.00%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q: -0.04212) (U: 0.43059) (S:  0.39) (V:  -.----)");
    out("info string node  ( 20 ) N:       1 (+ 0) (P: 100.00%) (WL:  0.04)");
    out("bestmove e2e4");
  } else if (l === "quit") process.exit(0);
});
