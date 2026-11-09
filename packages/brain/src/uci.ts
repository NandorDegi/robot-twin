/**
 * Minimal UCI subprocess driver. Used for lc0 (Maia weights) as a policy
 * network: `go nodes 1` evaluates the network once, without a search tree.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConst } from "node:fs";
import { delimiter, join } from "node:path";

export class EngineNotFoundError extends Error {
  constructor(binary: string, hint: string) {
    super(`UCI binary not found: ${binary}. ${hint}`);
    this.name = "EngineNotFoundError";
  }
}

/** Find an executable on PATH or in the extra directories. Returns null if absent. */
export function findExecutable(name: string, extraDirs: string[] = []): string | null {
  const isExec = (p: string) => {
    try {
      accessSync(p, fsConst.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (name.includes("/")) return isExec(name) ? name : null;
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs].filter(Boolean);
  for (const d of dirs) {
    const p = join(d, name);
    if (isExec(p)) return p;
  }
  return null;
}

export interface UciOptions {
  path: string;
  args?: string[];
  /** setoption name value pairs, sent after `uci`. */
  options?: Record<string, string | number | boolean>;
  initTimeoutMs?: number;
  /** Shown in the not-found error. */
  installHint?: string;
}

export class UciProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private lines: string[] = [];
  private waiters: { test: (l: string) => boolean; resolve: (l: string) => void; reject: (e: Error) => void }[] = [];
  private exitError: Error | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: UciOptions) {}

  private onLine(line: string): void {
    this.lines.push(line);
    for (const w of [...this.waiters]) {
      if (w.test(line)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  }

  send(cmd: string): void {
    if (!this.proc) throw new Error("UCI process not started");
    this.proc.stdin.write(cmd + "\n");
  }

  /** Wait for a line matching `test`. Lines before the call are not considered. */
  waitFor(test: (l: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.exitError) return reject(this.exitError);
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`UCI timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      const done = (l: string) => {
        clearTimeout(t);
        resolve(l);
      };
      this.waiters.push({
        test,
        resolve: done,
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  /** Lines received since the marker index; use with `mark()`. */
  mark(): number {
    return this.lines.length;
  }

  since(mark: number): string[] {
    return this.lines.slice(mark);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const resolved = findExecutable(this.opts.path);
    if (!resolved) throw new EngineNotFoundError(this.opts.path, this.opts.installHint ?? "");
    const proc = spawn(resolved, this.opts.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        this.onLine(line);
      }
    });
    proc.stderr.on("data", () => {});
    const failed = new Promise<never>((_, reject) => {
      proc.on("error", (err: NodeJS.ErrnoException) => {
        this.exitError =
          err.code === "ENOENT" ? new EngineNotFoundError(this.opts.path, this.opts.installHint ?? "") : err;
        reject(this.exitError);
      });
      proc.on("exit", (code) => {
        this.exitError = this.exitError ?? new Error(`UCI process exited (code ${code})`);
        for (const w of this.waiters.splice(0)) w.reject(this.exitError);
        reject(this.exitError);
      });
    });
    failed.catch(() => {});
    const timeout = this.opts.initTimeoutMs ?? 10000;
    const uciok = this.waitFor((l) => l === "uciok", timeout);
    this.send("uci");
    await Promise.race([uciok, failed]);
    for (const [k, v] of Object.entries(this.opts.options ?? {})) this.send(`setoption name ${k} value ${v}`);
    const ready = this.waitFor((l) => l === "readyok", timeout);
    this.send("isready");
    await Promise.race([ready, failed]);
  }

  /** Serialise commands: one search at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.send("quit");
    } catch {
      /* already gone */
    }
    const p = this.proc;
    this.proc = null;
    setTimeout(() => p.kill("SIGKILL"), 500).unref();
  }
}
