import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Snapshot } from "./state.js";

/** Persists the hub state as JSON, debouncing writes and replacing the file atomically. */
export class JsonStore {
  private timer: NodeJS.Timeout | undefined;
  private pending: (() => Snapshot) | undefined;

  constructor(
    private readonly file: string,
    private readonly delayMs = 500,
  ) {}

  load(): Snapshot | undefined {
    if (!existsSync(this.file)) return undefined;
    const data = JSON.parse(readFileSync(this.file, "utf8")) as Snapshot;
    if (data.version !== 1) throw new Error(`Unsupported state file version in ${this.file}`);
    return data;
  }

  schedule(getSnapshot: () => Snapshot): void {
    this.pending = getSnapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const get = this.pending;
    this.pending = undefined;
    if (!get) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(get()));
    renameSync(tmp, this.file);
  }
}
