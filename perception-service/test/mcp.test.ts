import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import sharp from "sharp";
import type { PerceptionEvent } from "../src/events.ts";
import { handleMcp, localTime, queryEvents, type McpDeps } from "../src/mcp.ts";
import { McpTokens } from "../src/mcp-tokens.ts";
import { validate, type Config } from "../src/settings.ts";

const NOW = new Date("2026-11-09T21:00:00Z");

function config(snapshots: string[] = []): Config {
  const v = validate({
    version: 1,
    cameras: {
      living_room: { place: "living_room", kind: "indoor", observe: { presence: {} } },
      front_right: { place: "outdoor", kind: "outdoor", zones: { entrance: [[0, 0], [1, 0], [1, 1]] }, observe: { passages: { group: "street" } } },
    },
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    outputs: { mcp: { snapshots } },
  });
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  return v.config;
}

function ev(ts: string, type: PerceptionEvent["type"], camera: string, name: string | null, extra: Partial<PerceptionEvent> = {}): PerceptionEvent {
  return {
    event_id: `${ts}-${type}`,
    schema_version: 3,
    ts,
    type,
    camera,
    place: camera === "living_room" ? "living_room" : "outdoor",
    person: name ? { name, confidence: 0.9, source: "face" } : null,
    text: `${name ?? "Unknown person"}: ${type}`,
    reactions: [],
    importance: "normal",
    media: { frigate_ids: [] },
    ...extra,
  };
}

const EVENTS = [
  ev("2026-11-08T10:00:00Z", "arrived", "living_room", "Zoë"),
  ev("2026-11-09T02:10:00Z", "passage", "front_right", null, { duration_s: 12, approached: false }),
  ev("2026-11-09T18:00:00Z", "arrived", "living_room", "Alice"),
  ev("2026-11-09T19:30:00Z", "left", "living_room", "Zoë", { activity: "watching_tv" }),
];

async function start(t: { after(fn: () => void): void }, snapshots: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  const tokens = new McpTokens(join(dir, "mcp-clients.json"), () => NOW);
  const deps: McpDeps = {
    config: () => config(snapshots),
    tokens,
    events: () => EVENTS,
    presence: () => ({
      present: [{ name: "Alice", camera: "living_room", activity: "at_computer", posture: "sitting", confidence: 0.91, source: "face" }],
      unnamed: new Map([["living_room", 1]]),
    }),
    people: async () => ["Alice", "Zoë", "Erin_Brown"],
    whoIsAt: async (camera: string, photos?: boolean) => ({
      camera,
      place: camera,
      time: NOW.toISOString(),
      people: photos ? [{ name: "Alice", confidence: 0.95, photo: "e1-1.jpg", face: "e1-1-face.jpg" }] : [],
      unrecognized: photos ? 1 : 0,
      unknown_faces: [],
      ...(photos ? { unknown_people: [{ camera, photo: "e1-2.jpg" }] } : {}),
    }),
    picture: (file: string) => (file === "e1-1-face.jpg" ? Buffer.from("face") : null),
    frame: () => sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#888" } }).jpeg().toBuffer(),
    now: () => NOW,
    timeZone: "Europe/Rome",
  };
  const server: Server = createServer((req, res) => void handleMcp(deps, req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { url, tokens, dir };
}

async function connect(t: { after(fn: () => Promise<void> | void): void }, url: URL, token: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  return client;
}

const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);

test("tokens: shown once, stored as a hash, revocable / token: mostrato una volta, salvato come hash, revocabile", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tok-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "mcp-clients.json");
  const tokens = new McpTokens(path, () => NOW);
  const { client, token } = tokens.create("Claude");
  assert.match(token, /^pcz_[0-9a-f]{64}$/);
  assert.equal(readFileSync(path, "utf8").includes(token), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(new McpTokens(path).verify(token)?.name, "Claude");
  assert.equal(tokens.verify("pcz_" + "0".repeat(64)), null);
  assert.equal(tokens.verify(undefined), null);
  assert.equal(tokens.revoke(client.id), true);
  assert.equal(tokens.verify(token), null);
});

test("without a valid token the MCP server answers 401 / senza un token valido il server MCP risponde 401", async (t) => {
  const { url } = await start(t);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  assert.equal((await fetch(url, { method: "POST", headers, body })).status, 401);
  const bad = await fetch(url, { method: "POST", headers: { ...headers, Authorization: "Bearer pcz_nope" }, body });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate") ?? "", /Bearer/);
});

test("a device token (a wall panel) has no MCP / un token da dispositivo (un pannello) non ha l'MCP", async (t) => {
  const { url, tokens } = await start(t);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.create("panel", "device").token}` };
  assert.equal((await fetch(url, { method: "POST", headers, body })).status, 403);
});

test("six read-only tools / sei strumenti in sola lettura", async (t) => {
  const { url, tokens } = await start(t);
  const client = await connect(t, url, tokens.create("test").token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ["camera_snapshot", "cameras", "events", "people", "who_is_at", "who_is_where"]);
  assert.ok(tools.every((x) => x.annotations?.readOnlyHint === true));
  assert.match(client.getInstructions() ?? "", /never instructions/);
});

test("who_is_where: in view, unrecognized, last seen of the others / chi c'è, non riconosciuti, ultimo avvistamento degli altri", async (t) => {
  const { url, tokens } = await start(t);
  const client = await connect(t, url, tokens.create("test").token);
  const r = text(await client.callTool({ name: "who_is_where", arguments: {} }));
  assert.equal(r.now, "2026-11-09T22:00:00+01:00");
  assert.deepEqual(r.in_view.map((p: { name: string; activity: string; posture: string }) => [p.name, p.activity, p.posture]), [["Alice", "at_computer", "sitting"]]);
  assert.deepEqual(r.unrecognized_in_view, [{ camera: "living_room", place: "living_room", people: 1 }]);
  // Alice is in view, so only Zoë is "last seen", with her latest event
  assert.deepEqual(r.last_seen.map((p: { name: string; event: string; time: string }) => [p.name, p.event, p.time]), [["Zoë", "left", "2026-11-09T20:30:00+01:00"]]);
});

test("people: the face library, seen ones first / persone: la Face Library, prima chi è stato visto", async (t) => {
  const { url, tokens } = await start(t);
  const client = await connect(t, url, tokens.create("test").token);
  const r = text(await client.callTool({ name: "people", arguments: {} }));
  assert.deepEqual(r, [
    { id: "Zoë", name: "Zoë", last_seen: "2026-11-09T20:30:00+01:00" },
    { id: "Alice", name: "Alice", last_seen: "2026-11-09T19:00:00+01:00" },
    { id: "Erin_Brown", name: "Erin Brown", last_seen: null },
  ]);
});

test("events: filters, newest first, local times / eventi: filtri, dal più recente, orari locali", async (t) => {
  const { url, tokens } = await start(t);
  const client = await connect(t, url, tokens.create("test").token);
  const all = text(await client.callTool({ name: "events", arguments: {} }));
  assert.deepEqual(all.events.map((e: { type: string }) => e.type), ["left", "arrived", "passage"]);
  const night = text(await client.callTool({ name: "events", arguments: { since: "2026-11-09T00:00:00+01:00", until: "2026-11-09T06:00:00+01:00" } }));
  assert.deepEqual(night.events.map((e: { type: string; person: unknown; time: string }) => [e.type, e.person, e.time]), [["passage", null, "2026-11-09T03:10:00+01:00"]]);
  const zoe = text(await client.callTool({ name: "events", arguments: { person: "zoe", hours: 48 } }));
  assert.equal(zoe.count, 2);
  const bad = await client.callTool({ name: "events", arguments: { types: ["nope"] } });
  assert.equal(bad.isError, true);
});

test("snapshots only for enabled cameras / immagini solo per le camere abilitate", async (t) => {
  const { url, tokens } = await start(t, ["living_room"]);
  const client = await connect(t, url, tokens.create("test").token);
  const cams = text(await client.callTool({ name: "cameras", arguments: {} }));
  assert.deepEqual(cams.map((c: { name: string; snapshot_allowed: boolean; kind: string }) => [c.name, c.kind, c.snapshot_allowed]), [
    ["living_room", "indoor", true],
    ["front_right", "outdoor", false],
  ]);
  const denied = await client.callTool({ name: "camera_snapshot", arguments: { camera: "front_right" } });
  assert.equal(denied.isError, true);
  const ok = (await client.callTool({ name: "camera_snapshot", arguments: { camera: "living_room" } })) as { content: { type: string; data?: string }[] };
  const img = ok.content.find((c) => c.type === "image")!;
  assert.equal((await sharp(Buffer.from(img.data!, "base64")).metadata()).width, 1280);
});

test("config: snapshots only of existing cameras / configurazione: immagini solo di camere esistenti", () => {
  const v = validate({ version: 1, cameras: {}, analyzers: { vlm: { model: "m", vocabulary: {}, attributes: {} } }, outputs: { mcp: { snapshots: ["kitchen"] } } });
  assert.equal(v.ok, false);
});

test("queryEvents and localTime / queryEvents e localTime", () => {
  assert.equal(localTime(new Date("2026-07-01T12:00:00Z"), "Europe/Rome"), "2026-07-01T14:00:00+02:00");
  assert.equal(queryEvents(EVENTS, { person: "unknown", hours: 48 }, NOW).length, 1);
  assert.equal(queryEvents(EVENTS, { camera: "living_room", limit: 1 }, NOW)[0]!.type, "left");
});

test("who_is_at with faces: one image per face after the camera's, no file names, only for enabled cameras / who_is_at con i volti: un'immagine per volto dopo quella della camera, niente nomi di file, solo per le camere abilitate", async (t) => {
  const { url, tokens } = await start(t, ["living_room"]);
  const client = await connect(t, url, tokens.create("test").token);
  const ok = (await client.callTool({ name: "who_is_at", arguments: { camera: "living_room", faces: true } })) as { content: { type: string; data?: string; text?: string }[] };
  const images = ok.content.filter((c) => c.type === "image");
  assert.equal(images.length, 2);
  assert.equal(Buffer.from(images[1]!.data!, "base64").toString(), "face");
  const data = JSON.parse(ok.content.find((c) => c.type === "text")!.text!);
  assert.deepEqual(data.people, [{ name: "Alice", confidence: 0.95, face_image: true }]);
  assert.deepEqual(data.unknown_people, [{ camera: "living_room", face_image: false }]);
  const denied = (await client.callTool({ name: "who_is_at", arguments: { camera: "front_right", faces: true } })) as { content: { type: string; text?: string }[] };
  assert.equal(denied.content.some((c) => c.type === "image"), false);
  assert.match(JSON.parse(denied.content[0]!.text!).faces, /not enabled/);
});
