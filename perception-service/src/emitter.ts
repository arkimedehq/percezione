import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PerceptionEvent } from "./events.ts";

export class JsonlLog {
  readonly path: string;

  constructor(dir: string, file: string) {
    mkdirSync(dir, { recursive: true });
    this.path = resolve(dir, file);
  }

  append(obj: unknown): void {
    appendFileSync(this.path, JSON.stringify(obj) + "\n");
  }
}

/** Console, timeline, then the deliveries (src/outputs.ts, MQTT card, live clients) in `publish`. */
export function createEmitter(timeline: JsonlLog, publish?: (e: PerceptionEvent) => void) {
  return (e: PerceptionEvent): void => {
    const lat = e.latency_ms !== undefined ? ` (${(e.latency_ms / 1000).toFixed(1)} s)` : "";
    const react = e.reactions.length ? ` → ${e.reactions.map((r) => r.react + ("to" in r && r.to ? `:${r.to}` : "")).join(", ")}` : "";
    console.log(`[${e.ts}] ${e.type.toUpperCase()} ${e.text}${lat} [${e.importance}]${react}`);
    timeline.append(e);
    publish?.(e);
  };
}
