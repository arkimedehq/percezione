import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Frigate (0.18.0 to 0.18.2 at least) loads its face landmark model once, when it starts. On a new installation the
 * face models are still downloading then, and until Frigate restarts every face its cameras see is dropped without a
 * word: no name, no attempt in the Face Library (frigate/data_processing/common/face/model.py, classify:
 * `if not self.landmark_detector: return None`). Photos added by hand take another path and do work, which hides it.
 * So once the models are all there, a Frigate that started before them is restarted, once.
 */
export const LANDMARKS = "landmarkdet.yaml";
/** The embedding model of the large size; the small one (FaceNet) comes with Frigate. */
export const LARGE_MODEL = "arcface.onnx";
/** A file written less than this long ago may still be downloading. */
export const SETTLE_MS = 60_000;

/** When the face models were complete, in ms; null while one is missing or still being written. */
export function modelsReadyAt(dir: string, large: boolean, now = Date.now()): number | null {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  if (!files.includes(LANDMARKS) || (large && !files.includes(LARGE_MODEL))) return null;
  const last = Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs));
  return now - last < SETTLE_MS ? null : last;
}

export type FaceModelsState = "off" | "waiting" | "restarted" | "ok";

export interface FaceModelsDeps {
  /** Frigate's config folder as Percezione sees it (frigate/config): the models are in model_cache/facedet */
  configDir: string;
  frigateUrl: string;
  log: (message: string) => void;
  now?: () => number;
}

export class FaceModels {
  private timer?: NodeJS.Timeout;
  constructor(private readonly d: FaceModelsDeps) {}

  /** One look: "ok" and "off" end the watch; "waiting" and "restarted" look again later. */
  async check(): Promise<FaceModelsState> {
    const now = this.d.now?.() ?? Date.now();
    const get = async <T>(path: string) => {
      const res = await fetch(`${this.d.frigateUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Frigate ${path} ${res.status}`);
      return (await res.json()) as T;
    };
    const cfg = await get<{ face_recognition?: { enabled?: boolean; model_size?: string } }>("/api/config");
    if (!cfg.face_recognition?.enabled) return "off";
    const ready = modelsReadyAt(join(this.d.configDir, "model_cache", "facedet"), cfg.face_recognition.model_size !== "small", now);
    if (ready === null) return "waiting";
    const stats = await get<{ service: { uptime: number } }>("/api/stats");
    if (now - stats.service.uptime * 1000 > ready) return "ok";
    const res = await fetch(`${this.d.frigateUrl}/api/restart`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Frigate restart ${res.status}`);
    this.d.log("Frigate: the face models arrived after it started; restarted so that it recognizes faces");
    return "restarted";
  }

  /** Looks every `everyMs` until Frigate has started with the models (or has face recognition off). */
  start(everyMs = 30_000): void {
    const tick = async () => {
      let state: FaceModelsState = "waiting";
      try {
        state = await this.check();
      } catch {
        // Frigate down or restarting: look again
      }
      if (state === "ok" || state === "off") return;
      this.timer = setTimeout(tick, everyMs);
      this.timer.unref?.();
    };
    void tick();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
