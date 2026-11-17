import type { ConfigStore } from "./settings.ts";

/**
 * Analyzer registry (docs/analyzers.md): the internal VLM (Ollama) and the external ones with the v1 contract
 * (`analyzers.endpoints` in data/config.json). Polls health and capabilities on every round and on every config
 * change; the frontend shows their status and takes the model catalog from here.
 */

export interface ModelInfo {
  name: string;
  task: string;
  family?: string;
  outputs: string[];
  avg_ms?: number | null;
  calls?: number;
  errors?: number;
}

export interface AnalyzerStatus {
  name: string;
  kind: "vlm" | "endpoint";
  url: string;
  ok: boolean;
  error?: string;
  version?: string;
  providers?: string[];
  tasks: string[];
  models: ModelInfo[];
  /** models the runner could not load, with the reason */
  broken?: Record<string, string>;
  /** the VLM: the configured model being downloaded into Ollama (percent null until the size is known) */
  download?: { model: string; percent: number | null };
  checked_at: string;
}

/** A download of the configured model into Ollama, which starts with none. */
interface Pull {
  model: string;
  /** bytes per layer, as Ollama reports them */
  layers: Map<string, { total: number; completed: number }>;
  error?: string;
  failedAt?: number;
}

/** After a failed download (no internet, a wrong name), the next try waits this long. */
const PULL_RETRY_MS = 10 * 60_000;

export interface InferResponse {
  status: "ok" | "error";
  model_name: string;
  inference_ms?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export class Analyzers {
  private status = new Map<string, AnalyzerStatus>();
  private timer?: ReturnType<typeof setInterval>;
  private pull?: Pull;

  constructor(
    private readonly store: ConfigStore,
    private readonly ollamaUrl: string,
  ) {}

  start(everyMs: number): Promise<void> {
    this.timer = setInterval(() => void this.refresh(), everyMs);
    return this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  list(): AnalyzerStatus[] {
    return [...this.status.values()];
  }

  async refresh(): Promise<void> {
    const cfg = this.store.current.analyzers;
    const checks: Promise<AnalyzerStatus>[] = [this.checkVlm(cfg.vlm.model)];
    for (const [name, e] of Object.entries(cfg.endpoints)) checks.push(this.checkEndpoint(name, e.url));
    const next = new Map<string, AnalyzerStatus>();
    for (const s of await Promise.all(checks)) next.set(s.name, s);
    this.status = next;
  }

  /** One call to an endpoint's `POST /infer`: JPEG frame and params. */
  async infer(endpoint: string, model: string, frame: Buffer, params: Record<string, unknown> = {}): Promise<InferResponse> {
    const e = this.store.current.analyzers.endpoints[endpoint];
    if (!e) throw new Error(`analyzer "${endpoint}" not defined`);
    const form = new FormData();
    form.set("frame", new Blob([new Uint8Array(frame)], { type: "image/jpeg" }), "frame.jpg");
    form.set("params", JSON.stringify({ ...params, model }));
    const res = await fetch(`${e.url}/infer`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as InferResponse & { detail?: string };
    if (!res.ok) throw new Error(`${endpoint}/${model}: ${body.detail ?? `HTTP ${res.status}`}`);
    if (body.status !== "ok") throw new Error(`${endpoint}/${model}: ${body.error ?? "error"}`);
    return body;
  }

  private async checkEndpoint(name: string, url: string): Promise<AnalyzerStatus> {
    const base = { name, kind: "endpoint" as const, url, tasks: [], models: [], checked_at: new Date().toISOString() };
    try {
      const get = async (path: string) => {
        const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return res.json() as Promise<Record<string, unknown>>;
      };
      const [health, caps] = await Promise.all([get("/health"), get("/capabilities")]);
      return {
        ...base,
        ok: health.status === "ok",
        version: caps.version as string | undefined,
        providers: health.providers as string[] | undefined,
        tasks: (caps.tasks_advertised as string[]) ?? [],
        models: (caps.models as ModelInfo[]) ?? [],
        broken: health.broken as Record<string, string> | undefined,
      };
    } catch (err) {
      return { ...base, ok: false, error: (err as Error).message };
    }
  }

  /**
   * The configured model, downloaded into Ollama in the background (`POST /api/pull`, streamed): one at a time, the
   * progress in the VLM's status. A failure is shown and retried after PULL_RETRY_MS.
   */
  private startPull(model: string): void {
    const p = this.pull;
    if (p && p.model === model && (!p.error || Date.now() - (p.failedAt ?? 0) < PULL_RETRY_MS)) return;
    if (p && p.model !== model && !p.error) return;
    const pull: Pull = { model, layers: new Map() };
    this.pull = pull;
    console.log(`VLM: downloading ${model} into Ollama`);
    void (async () => {
      try {
        const res = await fetch(`${this.ollamaUrl}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }) });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        let rest = "";
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          const lines = (rest + Buffer.from(chunk).toString("utf8")).split("\n");
          rest = lines.pop() ?? "";
          for (const line of lines.filter(Boolean)) {
            const m = JSON.parse(line) as { error?: string; digest?: string; total?: number; completed?: number };
            if (m.error) throw new Error(m.error);
            if (m.digest && m.total) pull.layers.set(m.digest, { total: m.total, completed: m.completed ?? 0 });
          }
        }
        console.log(`VLM: ${model} downloaded`);
        if (this.pull === pull) this.pull = undefined;
      } catch (err) {
        pull.error = (err as Error).message;
        pull.failedAt = Date.now();
        console.error(`VLM: download of ${model} failed: ${pull.error}`);
      }
      await this.refresh();
    })();
  }

  private pullPercent(p: Pull): number | null {
    let total = 0;
    let done = 0;
    for (const l of p.layers.values()) {
      total += l.total;
      done += l.completed;
    }
    return total ? Math.floor((done / total) * 100) : null;
  }

  /** The VLM is "healthy" when Ollama answers and has the configured model; a missing model is downloaded. */
  private async checkVlm(model: string): Promise<AnalyzerStatus> {
    const base = {
      name: "vlm",
      kind: "vlm" as const,
      url: this.ollamaUrl,
      tasks: ["vqa_yes_no"],
      models: [{ name: model, task: "vqa_yes_no", outputs: [] }],
      checked_at: new Date().toISOString(),
    };
    try {
      const res = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      const tags = (await res.json()) as { models?: { name: string }[] };
      const has = tags.models?.some((m) => m.name === model || m.name === `${model}:latest`);
      if (has) return { ...base, ok: true };
      this.startPull(model);
      const p = this.pull;
      if (p?.model === model && p.error) return { ...base, ok: false, error: `model ${model} could not be downloaded into Ollama: ${p.error}` };
      return { ...base, ok: false, ...(p?.model === model ? { download: { model, percent: this.pullPercent(p) } } : { error: `model ${model} not available in Ollama` }) };
    } catch (err) {
      return { ...base, ok: false, error: `Ollama unreachable: ${(err as Error).message}` };
    }
  }
}
