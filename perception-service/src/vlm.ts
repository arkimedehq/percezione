import type { Attributes } from "./config.ts";

export interface VlmResult {
  attributes: Attributes;
  ms: number;
  raw: string;
}

/**
 * Yes/no questions instead of a closed-list choice: with the list, small models almost always answer
 * "at the PC" as soon as they see a desk and ignore the phone in hand.
 */
export function buildPrompt(attributes: Record<string, string>): string {
  const list = Object.entries(attributes)
    .map(([name, question]) => `- ${name}: ${question}`)
    .join("\n");
  return [
    `Look at the person in the center of the image and answer true or false to each item:`,
    list,
    `Answer in JSON only.`,
  ].join("\n");
}

/** Validates the answer: invalid JSON or a missing / non-boolean attribute → null (sample discarded). */
export function parseResponse(raw: string, names: string[]): Attributes | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const out: Attributes = {};
  for (const name of names) {
    const v = (obj as Record<string, unknown>)[name];
    if (typeof v !== "boolean") return null;
    out[name] = v;
  }
  return out;
}

export class VlmClient {
  // Ollama handles one request at a time efficiently: we serialize the calls
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly url: string) {}

  /** `model` on every call: it changes live from the configuration. */
  classify(model: string, image: Buffer, attributes: Record<string, string>): Promise<VlmResult | null> {
    const run = () => this.call(model, image, attributes);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async call(model: string, image: Buffer, attributes: Record<string, string>): Promise<VlmResult | null> {
    const names = Object.keys(attributes);
    const t0 = performance.now();
    const res = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        keep_alive: "30m",
        // the answer is ~10 tokens per attribute: the cap avoids minutes of output if the model starts "reasoning"
        options: { temperature: 0, num_predict: 32 + 12 * names.length },
        format: {
          type: "object",
          properties: Object.fromEntries(names.map((n) => [n, { type: "boolean" }])),
          required: names,
        },
        messages: [{ role: "user", content: buildPrompt(attributes), images: [image.toString("base64")] }],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message?: { content?: string } };
    const raw = body.message?.content ?? "";
    const ms = Math.round(performance.now() - t0);
    const parsed = parseResponse(raw, names);
    return parsed ? { attributes: parsed, ms, raw } : null;
  }
}
