import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Which camera each Frigate track was on, for a few days. Frigate drops the events of cameras without snapshots, and
 * an unrecognized person makes no event of ours: without this, a face to name would not say where it was seen.
 * One JSONL line per new track; older lines are dropped when the service starts.
 */
export class TrackLog {
  private cameras = new Map<string, string>();

  constructor(
    private readonly path: string,
    keepMs = 7 * 86_400_000,
    now = Date.now(),
  ) {
    if (!existsSync(path)) return;
    const kept: string[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const t = JSON.parse(line) as { id: string; camera: string; ts: number };
        if (now - t.ts * 1000 > keepMs) continue;
        this.cameras.set(t.id, t.camera);
        kept.push(line);
      } catch {
        // an empty or cut line
      }
    }
    writeFileSync(path, kept.map((l) => l + "\n").join(""));
  }

  /** A track seen on MQTT; written only the first time. */
  saw(id: string, camera: string, startTime: number): void {
    if (this.cameras.has(id)) return;
    this.cameras.set(id, camera);
    appendFileSync(this.path, JSON.stringify({ id, camera, ts: startTime }) + "\n");
  }

  camera(id: string): string | undefined {
    return this.cameras.get(id);
  }
}
