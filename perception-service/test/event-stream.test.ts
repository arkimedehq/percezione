import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventStream, missed } from "../src/event-stream.ts";
import type { PerceptionEvent } from "../src/events.ts";
import { McpTokens } from "../src/mcp-tokens.ts";

const NOW = new Date("2026-11-11T12:00:00Z");

const ev = (id: string, ts: string): PerceptionEvent => ({
  event_id: id,
  schema_version: 3,
  ts,
  type: "arrived",
  camera: "living_room",
  place: "living_room",
  person: { name: "Alice", confidence: 0.9, source: "face" },
  text: "Alice arrived in living room",
  reactions: [],
  importance: "normal",
  media: { frigate_ids: [] },
});

const TIMELINE = [ev("a", "2026-11-01T10:00:00Z"), ev("b", "2026-11-11T09:00:00Z"), ev("c", "2026-11-11T10:00:00Z"), ev("d", "2026-11-11T11:00:00Z")];

test("missed: after the last id, since a time, nothing for a new client / persi: dopo l'ultimo id, da un'ora, niente per un client nuovo", () => {
  const ids = (es: PerceptionEvent[]) => es.map((e) => e.event_id);
  assert.deepEqual(ids(missed(TIMELINE, "b", undefined, NOW)), ["c", "d"]);
  assert.deepEqual(ids(missed(TIMELINE, "d", undefined, NOW)), []);
  // an id no longer in the timeline: the last day
  assert.deepEqual(ids(missed(TIMELINE, "zz", undefined, NOW)), ["b", "c", "d"]);
  assert.deepEqual(ids(missed(TIMELINE, undefined, "2026-11-11T10:00:00Z", NOW)), ["c", "d"]);
  // at most 7 days back
  assert.deepEqual(ids(missed(TIMELINE, undefined, "2026-10-01T00:00:00Z", NOW)), ["b", "c", "d"]);
  assert.deepEqual(ids(missed(TIMELINE, undefined, undefined, NOW)), []);
});

/** Reads SSE frames from a response until `count` events have arrived. */
async function read(res: Response, count: number): Promise<{ id: string; data: PerceptionEvent }[]> {
  const out: { id: string; data: PerceptionEvent }[] = [];
  const reader = res.body!.getReader();
  let buf = "";
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const id = block.match(/^id: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (id && data) out.push({ id, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return out;
}

test("live events with the client token, resumed with Last-Event-ID / eventi in diretta con il token, ripresi con Last-Event-ID", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sse-"));
  const tokens = new McpTokens(join(dir, "clients.json"), () => NOW);
  const timeline = [...TIMELINE];
  const stream = new EventStream({ tokens, events: () => timeline, now: () => NOW, heartbeatMs: 50 });
  const server = createServer((req, res) => stream.handle(req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
  const { token } = tokens.create("arkimede");

  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: "Bearer pcz_nope" } })).status, 401);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": "c" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const got = read(res, 2);
  // wait until the client is subscribed, then a new event arrives live
  while (stream.size === 0) await new Promise((r) => setTimeout(r, 5));
  const e = ev("e", "2026-11-11T11:30:00Z");
  timeline.push(e);
  stream.push(e);
  const frames = await got;
  assert.deepEqual(frames.map((f) => f.id), ["d", "e"]);
  assert.equal(frames[1]!.data.text, "Alice arrived in living room");
});
