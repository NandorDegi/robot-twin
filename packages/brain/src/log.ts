/** Append-only JSONL log of every cycle. One JSON object per line. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CycleLog, CycleRecord } from "./loop";

export class JsonlFileLog implements CycleLog {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  write(record: CycleRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }
}

export class MemoryLog implements CycleLog {
  readonly records: CycleRecord[] = [];
  write(record: CycleRecord): void {
    this.records.push(record);
  }
}
