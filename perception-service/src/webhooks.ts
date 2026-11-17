import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { PermanentError } from "./outbox.ts";
import { writePrivate } from "./secrets.ts";

/**
 * Signed webhooks (docs/outputs.md). Each webhook has its own secret, made here and shown once in the UI:
 * never in config.json or in the logs. A POST carries the v2 event and
 *   X-Percezione-Event: <event_id>
 *   X-Percezione-Timestamp: <unix seconds>
 *   X-Percezione-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the secret>
 * The receiver recomputes the HMAC and refuses old timestamps (replay).
 */
export class WebhookSecrets {
  private secrets: Record<string, string>;

  constructor(private readonly path: string) {
    this.secrets = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
  }

  /** The secret of a webhook, made the first time it is needed. */
  get(name: string): string {
    return this.secrets[name] ?? this.rotate(name);
  }

  has(name: string): boolean {
    return name in this.secrets;
  }

  /** A new secret; the old one stops working at once. */
  rotate(name: string): string {
    this.secrets[name] = "whsec_" + randomBytes(32).toString("hex");
    this.save();
    return this.secrets[name]!;
  }

  remove(name: string): void {
    if (!(name in this.secrets)) return;
    delete this.secrets[name];
    this.save();
  }

  private save(): void {
    writePrivate(this.path, JSON.stringify(this.secrets, null, 1) + "\n");
  }
}

export function sign(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** POSTs one payload; a 4xx other than 408/429 is permanent (the receiver will not take it on a retry). */
export async function postSigned(url: string, secret: string, id: string, payload: unknown, now = new Date()): Promise<void> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(now.getTime() / 1000);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Percezione",
      "X-Percezione-Event": id,
      "X-Percezione-Timestamp": String(ts),
      "X-Percezione-Signature": sign(secret, ts, body),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  await res.arrayBuffer().catch(() => undefined);
  if (res.ok) return;
  const msg = `HTTP ${res.status}`;
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new PermanentError(`${msg}: rejected`);
  throw new Error(msg);
}
