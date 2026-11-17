import { resolve } from "node:path";
import type { PerceptionEvent } from "./events.ts";
import { HA_TOPIC } from "./ha.ts";
import { Outbox, type OutboxOptions, type OutboxStatus } from "./outbox.ts";
import type { Config } from "./settings.ts";
import { postSigned, type WebhookSecrets } from "./webhooks.ts";

/**
 * The deliveries of the perception-service (docs/outputs.md), each through its own outbox:
 * - `mqtt`: every event on `perception/events` (any platform) and, for the rules with the `ha` reaction, an HA event
 *   on `perception/rule` (src/ha.ts);
 * - `webhook_<name>`: the events of the rules with a `webhook` reaction to that name, signed (src/webhooks.ts).
 * Memory, voice and notifications are not here: they belong to Arkimede's plugin (integrations/arkimede).
 */
export const EVENTS_TOPIC = "perception/events";

export interface MqttMessage {
  topic: string;
  payload: string;
}

export interface OutputsDeps {
  dir: string;
  config(): Config;
  /** publishes with QoS 1 and resolves on the broker's ack; rejects at once when not connected */
  mqtt(m: MqttMessage): Promise<void>;
  secrets: WebhookSecrets;
  now?: () => Date;
  outbox?: OutboxOptions;
}

export interface OutputStatus extends OutboxStatus {
  kind: "mqtt" | "webhook";
  enabled: boolean;
  url?: string;
  has_secret?: boolean;
}

const WEBHOOK_PREFIX = "webhook_";

/** What an HA automation gets with the rule's event: enough to write a notification. */
export function haRuleEvent(ruleId: string, e: PerceptionEvent) {
  return {
    event_type: ruleId,
    event_id: e.event_id,
    type: e.type,
    camera: e.camera,
    place: e.place,
    person: e.person?.name ?? null,
    text: e.text,
    importance: e.importance,
    ts: e.ts,
  };
}

export class Outputs {
  readonly mqtt: Outbox<MqttMessage>;
  private webhooks = new Map<string, Outbox<PerceptionEvent>>();

  constructor(private readonly d: OutputsDeps) {
    this.mqtt = new Outbox(d.dir, "mqtt", (m) => d.mqtt(m), d.outbox);
    this.reconcile();
  }

  /** One event to every destination that wants it. */
  route(e: PerceptionEvent): void {
    const cfg = this.d.config();
    this.mqtt.push({ topic: EVENTS_TOPIC, payload: JSON.stringify(e) });
    for (const r of e.reactions) {
      if (r.react === "ha" && cfg.outputs.homeassistant.enabled) {
        for (const id of r.rules) this.mqtt.push({ topic: HA_TOPIC.rule, payload: JSON.stringify(haRuleEvent(id, e)) });
      } else if (r.react === "webhook") {
        const w = cfg.outputs.webhooks[r.to];
        if (w?.enabled) this.webhook(r.to).push(e);
      }
    }
  }

  /** Webhook queues follow the configuration: a removed webhook loses its queue and its secret. */
  reconcile(): void {
    const names = Object.keys(this.d.config().outputs.webhooks);
    for (const n of names) this.webhook(n);
    for (const [n, box] of this.webhooks) {
      if (names.includes(n)) continue;
      box.destroy();
      this.webhooks.delete(n);
      this.d.secrets.remove(n);
    }
  }

  status(): OutputStatus[] {
    const cfg = this.d.config();
    return [
      { kind: "mqtt", enabled: true, ...this.mqtt.status() },
      ...[...this.webhooks].map(([n, box]) => ({
        kind: "webhook" as const,
        enabled: cfg.outputs.webhooks[n]?.enabled ?? false,
        url: cfg.outputs.webhooks[n]?.url,
        has_secret: this.d.secrets.has(n),
        ...box.status(),
        name: n,
      })),
    ];
  }

  /** "Send a test": a signed test POST now, outside the queue. */
  async testWebhook(name: string): Promise<{ ok: boolean; error?: string }> {
    const w = this.d.config().outputs.webhooks[name];
    if (!w) return { ok: false, error: `webhook "${name}" not defined` };
    const now = this.d.now?.() ?? new Date();
    const id = `test-${now.getTime()}`;
    try {
      await postSigned(w.url, this.d.secrets.get(name), id, { event_id: id, schema_version: 3, type: "test", ts: now.toISOString(), text: "Test from Percezione" }, now);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  retryNow(): void {
    this.mqtt.retryNow();
    for (const box of this.webhooks.values()) box.retryNow();
  }

  stop(): void {
    this.mqtt.stop();
    for (const box of this.webhooks.values()) box.stop();
  }

  private webhook(name: string): Outbox<PerceptionEvent> {
    let box = this.webhooks.get(name);
    if (!box) {
      box = new Outbox<PerceptionEvent>(
        resolve(this.d.dir),
        WEBHOOK_PREFIX + name,
        (e) => {
          // the URL and the secret in force at the time of the send
          const w = this.d.config().outputs.webhooks[name];
          if (!w) return Promise.resolve();
          return postSigned(w.url, this.d.secrets.get(name), e.event_id, e, this.d.now?.());
        },
        this.d.outbox,
      );
      this.webhooks.set(name, box);
    }
    return box;
  }
}
