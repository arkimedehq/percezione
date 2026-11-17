import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PerceptionEvent } from "../src/events.ts";
import { HA_TOPIC } from "../src/ha.ts";
import { EVENTS_TOPIC, Outputs, type MqttMessage } from "../src/outputs.ts";
import { evaluateRules } from "../src/rules.ts";
import { validate, type Config } from "../src/settings.ts";
import { sign, WebhookSecrets } from "../src/webhooks.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timeout");
    await wait(5);
  }
};

function config(url: string): Config {
  const v = validate({
    version: 1,
    cameras: {
      front_right: { place: "outdoor", kind: "outdoor", zones: { entrance: [[0, 0], [1, 0], [1, 1]] }, observe: { passages: { group: "street" }, approach: { zone: "entrance" } } },
    },
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    rules: [
      {
        id: "night_entrance",
        name: "Someone at the entrance",
        when: { event: "approach" },
        then: [{ react: "memory" }, { react: "ha" }, { react: "webhook", to: "automation" }],
      },
    ],
    outputs: { webhooks: { automation: { url } } },
  });
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  return v.config;
}

function event(i: number, cfg: Config): PerceptionEvent {
  const o = { event_id: `e${i}`, schema_version: 3 as const, ts: new Date(Date.UTC(2026, 10, 11, 2, 0, i)).toISOString(), type: "approach" as const, camera: "front_right", place: "outdoor", person: null, zone: "entrance", media: { frigate_ids: [] } };
  return { ...o, text: "Unknown person at the entrance", ...evaluateRules(o, cfg.rules, new Date()) } as PerceptionEvent;
}

/** A webhook receiver that can be switched off: it answers 503 (a destination that is down). */
async function receiver(t: { after(fn: () => void): void }) {
  const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const state = { up: false };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!state.up) {
        res.writeHead(503).end();
        return;
      }
      got.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, got, state };
}

function setup(t: { after(fn: () => void): void }, url: string) {
  const dir = mkdtempSync(join(tmpdir(), "outputs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = config(url);
  const mqtt: MqttMessage[] = [];
  const broker = { up: true };
  const secrets = new WebhookSecrets(join(dir, "webhook-secrets.json"));
  const outputs = new Outputs({
    dir: join(dir, "outbox"),
    config: () => cfg,
    secrets,
    mqtt: async (m) => {
      if (!broker.up) throw new Error("MQTT broker not connected");
      mqtt.push(m);
    },
    outbox: { minDelayMs: 10, maxDelayMs: 40 },
  });
  t.after(() => outputs.stop());
  return { cfg, mqtt, broker, secrets, outputs, dir };
}

test("P5: one rule with three reactions, a webhook down and back up, nothing lost / P5: una regola con tre reazioni, un webhook giù e poi di nuovo su, nessuna perdita", async (t) => {
  const hook = await receiver(t);
  const { cfg, mqtt, secrets, outputs } = setup(t, hook.url);
  for (let i = 1; i <= 3; i++) outputs.route(event(i, cfg));

  // MQTT: every event, and an HA event per rule with the ha reaction
  await until(() => mqtt.length === 6);
  assert.deepEqual(mqtt.filter((m) => m.topic === EVENTS_TOPIC).map((m) => JSON.parse(m.payload).event_id), ["e1", "e2", "e3"]);
  const rule = mqtt.filter((m) => m.topic === HA_TOPIC.rule).map((m) => JSON.parse(m.payload));
  assert.deepEqual(rule.map((r) => [r.event_type, r.event_id, r.text]), [
    ["night_entrance", "e1", "Unknown person at the entrance"],
    ["night_entrance", "e2", "Unknown person at the entrance"],
    ["night_entrance", "e3", "Unknown person at the entrance"],
  ]);

  // webhook down: queued, retried
  await until(() => outputs.status().find((s) => s.name === "automation")!.retry_at !== null);
  assert.equal(outputs.status().find((s) => s.name === "automation")!.pending, 3);
  assert.equal(hook.got.length, 0);

  // back up: everything arrives, in order, signed
  hook.state.up = true;
  outputs.route(event(4, cfg));
  await until(() => hook.got.length === 4);
  assert.deepEqual(hook.got.map((g) => JSON.parse(g.body).event_id), ["e1", "e2", "e3", "e4"]);
  const secret = secrets.get("automation");
  for (const g of hook.got) {
    const ts = Number(g.headers["x-percezione-timestamp"]);
    assert.equal(g.headers["x-percezione-signature"], "sha256=" + createHmac("sha256", secret).update(`${ts}.${g.body}`).digest("hex"));
    assert.equal(g.headers["x-percezione-event"], JSON.parse(g.body).event_id);
  }
  // the receiver counts a request on arrival, the outbox once the answer is back
  await until(() => outputs.status().find((s) => s.name === "automation")!.delivered === 4);
  const st = outputs.status().find((s) => s.name === "automation")!;
  assert.deepEqual([st.kind, st.pending, st.delivered, st.enabled, st.has_secret], ["webhook", 0, 4, true, true]);
});

test("broker down: MQTT messages wait and go out in order / broker giù: i messaggi MQTT aspettano ed escono in ordine", async (t) => {
  const { cfg, mqtt, broker, outputs } = setup(t, "http://127.0.0.1:9/never");
  broker.up = false;
  outputs.route(event(1, cfg));
  outputs.route(event(2, cfg));
  await wait(30);
  assert.equal(mqtt.length, 0);
  broker.up = true;
  outputs.retryNow();
  await until(() => mqtt.length === 4);
  assert.deepEqual(mqtt.map((m) => [m.topic, JSON.parse(m.payload).event_id]), [
    [EVENTS_TOPIC, "e1"],
    [HA_TOPIC.rule, "e1"],
    [EVENTS_TOPIC, "e2"],
    [HA_TOPIC.rule, "e2"],
  ]);
});

test("a disabled webhook or HA gets nothing; a removed webhook loses queue and secret / un webhook o HA spenti non ricevono nulla; un webhook tolto perde coda e segreto", async (t) => {
  const { cfg, mqtt, secrets, outputs, dir } = setup(t, "http://127.0.0.1:9/never");
  cfg.outputs.webhooks.automation!.enabled = false;
  cfg.outputs.homeassistant.enabled = false;
  outputs.route(event(1, cfg));
  await until(() => mqtt.length === 1);
  assert.equal(mqtt[0]!.topic, EVENTS_TOPIC);
  assert.equal(outputs.status().find((s) => s.name === "automation")!.pending, 0);

  cfg.outputs.webhooks.automation!.enabled = true;
  outputs.route(event(2, cfg));
  secrets.get("automation");
  delete cfg.outputs.webhooks.automation;
  outputs.reconcile();
  assert.equal(outputs.status().length, 1);
  assert.equal(secrets.has("automation"), false);
  assert.throws(() => statSync(join(dir, "outbox", "webhook_automation.jsonl")));
});

test("test send and signature format / invio di prova e formato della firma", async (t) => {
  const hook = await receiver(t);
  hook.state.up = true;
  const { outputs, secrets } = setup(t, hook.url);
  assert.deepEqual(await outputs.testWebhook("automation"), { ok: true });
  assert.equal(JSON.parse(hook.got[0]!.body).type, "test");
  assert.deepEqual(await outputs.testWebhook("nobody"), { ok: false, error: 'webhook "nobody" not defined' });
  hook.state.up = false;
  assert.deepEqual(await outputs.testWebhook("automation"), { ok: false, error: "HTTP 503" });
  assert.match(secrets.rotate("automation"), /^whsec_[0-9a-f]{64}$/);
  assert.equal(sign("s", 1, "{}"), "sha256=" + createHmac("sha256", "s").update("1.{}").digest("hex"));
});
