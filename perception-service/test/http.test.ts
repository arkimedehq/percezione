import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import type { FrigateSync } from "../src/frigate-sync.ts";
import type { Analyzers } from "../src/analyzers.ts";
import { Api, type ApiDeps } from "../src/http.ts";
import { UiPassword } from "../src/secrets.ts";
import { FaceImports } from "../src/face-import.ts";
import { McpTokens } from "../src/mcp-tokens.ts";
import type { McpDeps } from "../src/mcp.ts";
import type { External } from "../src/external.ts";
import type { FrigateFaces } from "../src/people.ts";
import { ConfigStore } from "../src/settings.ts";

async function setup(t: { after(fn: () => void): void }, extra: Partial<ApiDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "perception-api-"));
  const store = new ConfigStore(join(dir, "config.json"), () => ({
    version: 1,
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    cameras: { front_right: { place: "outdoor", kind: "outdoor" } },
  }));
  const dist = join(dir, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Percezione</title>");
  writeFileSync(join(dir, "secret.txt"), "no");
  const timeline = join(dir, "timeline.jsonl");
  const ev = (ts: string, person: string | null) =>
    JSON.stringify({ schema_version: 3, event_id: ts, ts, type: "passage", camera: "front_right", place: "outdoor", person: person && { name: person, confidence: 0.9, source: "face" }, media: { frigate_ids: [] }, text: "", reactions: [], importance: "normal" });
  const now = Date.now();
  writeFileSync(
    timeline,
    [
      JSON.stringify({ schema_version: 1, type: "arrived" }), // v1: ignored
      ev(new Date(now - 30 * 3600_000).toISOString(), null), // outside the 24 h
      ev(new Date(now - 2 * 3600_000).toISOString(), null),
      ev(new Date(now - 3600_000).toISOString(), "Carol"),
    ].join("\n") + "\n",
  );
  const deps = {
    store,
    sync: { fetchRaw: async () => ({ cameras: {} }) } as unknown as FrigateSync,
    analyzers: { list: () => [], refresh: async () => undefined } as unknown as Analyzers,
    frigateUrl: "http://127.0.0.1:9",
    go2rtc: {},
    timelinePath: timeline,
    mediaDir: dir,
    password: new UiPassword(join(dir, "ui.json"), "right"),
    distDir: dist,
    sessionsPath: join(dir, "ui-sessions.json"),
    tryActivity: async () => ({}),
    ...extra,
  };
  let api = new Api(deps);
  await api.listen(0, "127.0.0.1");
  let base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  /** a new process with the same data directory */
  const restart = async () => {
    api.close();
    api = new Api(deps);
    await api.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  };
  t.after(() => {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  };
  return { store, call, restart, base: () => base, jar: { get: () => cookie, set: (c: string) => void (cookie = c) } };
}

test("without login only /api/login; wrong password rejected; then the session opens the API / senza login solo /api/login; password sbagliata rifiutata; poi la sessione apre l'API", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("GET", "/api/config")).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "wrong" })).status, 401);
  assert.equal((await call("GET", "/api/config")).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "right" })).status, 200);
  const cfg = await call("GET", "/api/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.version, 1);
  await call("POST", "/api/logout");
  assert.equal((await call("GET", "/api/config")).status, 401);
});

test("sessions survive a restart, logout too / le sessioni sopravvivono al riavvio, anche il logout", async (t) => {
  const { call, restart, jar } = await setup(t);
  await call("POST", "/api/login", { password: "right" });
  await restart();
  assert.equal((await call("GET", "/api/config")).status, 200);
  const old = jar.get();
  await call("POST", "/api/logout");
  await restart();
  // the logged-out token stays invalid even if the browser still sends it
  jar.set(old);
  assert.equal((await call("GET", "/api/config")).status, 401);
});

test("saving: preview, version conflict, per-field errors, history and restore / salvataggio: anteprima, conflitto di versione, errori per campo, cronologia e ripristino", async (t) => {
  const { call, store } = await setup(t);
  await call("POST", "/api/login", { password: "right" });
  const cfg = (await call("GET", "/api/config")).data;
  const next = structuredClone(cfg);
  next.cameras.front_right.label = "Street right";

  const preview = await call("POST", "/api/config/preview", { config: next });
  assert.deepEqual(preview.data, { ok: true, errors: [], frigate: [] });

  assert.equal((await call("PUT", "/api/config", { config: next, base_version: 0 })).status, 409);
  const saved = await call("PUT", "/api/config", { config: next, base_version: 1 });
  assert.deepEqual(saved.data, { ok: true, version: 2 });

  const bad = structuredClone(next);
  bad.cameras.front_right.kind = "underground";
  const r = await call("PUT", "/api/config", { config: bad, base_version: 2 });
  assert.equal(r.status, 422);
  assert.match(r.data.errors.join(), /cameras\.front_right\.kind/);

  const history = (await call("GET", "/api/config/history")).data as { file: string; version: number }[];
  assert.deepEqual(history.map((h) => h.version), [2, 1]);
  const restored = await call("POST", "/api/config/restore", { file: history[1]!.file });
  assert.equal(restored.data.version, 3);
  assert.equal(store.current.cameras.front_right!.label, undefined);
  assert.equal((await call("GET", "/api/config/history/..%2Fconfig.json")).status, 500);
});

test("recent events and testing a rule on the last 24 h / eventi recenti e prova di una regola sulle ultime 24 h", async (t) => {
  const { call } = await setup(t);
  await call("POST", "/api/login", { password: "right" });
  const events = (await call("GET", "/api/events")).data as { person: { name: string } | null }[];
  assert.equal(events.length, 3, "only v3 events");
  assert.equal(events[0]!.person?.name, "Carol", "newest first");

  const r = await call("POST", "/api/rules/test", {
    rule: { id: "x", name: "x", when: { event: "passage", person: "unknown" }, then: [{ react: "memory" }] },
  });
  assert.equal(r.data.total, 2);
  assert.equal(r.data.hits.length, 1);
  assert.equal((await call("POST", "/api/rules/test", { rule: { id: "x" } })).status, 422);
});

test("frontend: static files, frontend routes on index.html, no escaping the folder / frontend: file statici, rotte del frontend su index.html, niente uscita dalla cartella", async (t) => {
  const { base } = await setup(t);
  const page = await fetch(`${base()}/cameras/front_right`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Percezione/);
  const escape = await fetch(`${base()}/%2e%2e/secret.txt`);
  assert.doesNotMatch(await escape.text(), /^no$/);
});

test("/healthz without login: 200 when every part answers, 503 naming the one down / /healthz senza login: 200 se ogni parte risponde, 503 con quella giù", async (t) => {
  const parts = { mqtt: true, frigate: true };
  const { call } = await setup(t, { health: async () => ({ ...parts }) });
  assert.deepEqual(await call("GET", "/healthz"), { status: 200, data: { ok: true, mqtt: true, frigate: true } });
  parts.frigate = false;
  assert.deepEqual(await call("GET", "/healthz"), { status: 503, data: { ok: false, mqtt: true, frigate: false } });
});

test("first start: the password is chosen once from the UI, then only the login works / primo avvio: la password si sceglie una volta dalla UI, poi vale solo il login", async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "perception-ui-")), "ui.json");
  const { call, jar } = await setup(t, { password: new UiPassword(path) });
  assert.deepEqual((await call("GET", "/api/setup")).data, { password_set: false });
  assert.equal((await call("GET", "/api/config")).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "" })).status, 401);
  assert.equal((await call("POST", "/api/setup", { password: "short" })).status, 422);
  assert.equal((await call("POST", "/api/setup", { password: "long enough" })).status, 200);
  assert.equal((await call("GET", "/api/config")).status, 200, "choosing it opens a session");
  assert.deepEqual((await call("GET", "/api/setup")).data, { password_set: true });

  jar.set("");
  assert.equal((await call("POST", "/api/setup", { password: "taken over" })).status, 409);
  assert.equal((await call("GET", "/api/config")).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "long enough" })).status, 200);
  assert.equal((await call("GET", "/api/config")).status, 200);
});

test("restore: the restart waits until the configuration has reached Frigate / ripristino: il riavvio aspetta che la configurazione sia arrivata a Frigate", async (t) => {
  const steps: string[] = [];
  let reach!: () => void;
  const reached = new Promise<void>((ok) => (reach = ok));
  const { call, store, base, jar } = await setup(t, {
    dataDir: mkdtempSync(join(tmpdir(), "perception-restore-")),
    settled: async () => {
      steps.push("waiting for Frigate");
      await reached;
      steps.push("Frigate has it");
    },
    restart: () => void steps.push("restart"),
  });
  await call("POST", "/api/login", { password: "right" });
  const backup = gzipSync(JSON.stringify({ format: "percezione-backup", version: 1, created: "", config: store.current, files: {}, people: [] }));
  const pending = fetch(`${base()}/api/restore`, { method: "POST", headers: { Cookie: jar.get(), "Content-Type": "application/gzip" }, body: backup });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(steps, ["waiting for Frigate"], "no answer and no restart before Frigate has the cameras");
  reach();
  assert.equal((await pending).status, 200);
  await new Promise((ok) => setTimeout(ok, 600));
  assert.deepEqual(steps, ["waiting for Frigate", "Frigate has it", "restart"]);
});

test("face import API: token required, people created on purpose, the same photo imported once / API di import dei volti: token obbligatorio, persone create apposta, la stessa foto importata una volta", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "perception-import-"));
  const tokens = new McpTokens(join(dir, "mcp-clients.json"));
  const { token } = tokens.create("photo-archive", "device");
  const agent = { Authorization: `Bearer ${tokens.create("assistant").token}` };
  const library = new Map<string, string[]>([["Alice", ["a1.webp"]]]);
  const uploads: string[] = [];
  const faces = {
    list: async () => [...library].map(([id, f]) => ({ id, faces: f })),
    create: async (id: string) => void library.set(id, []),
    upload: async (id: string, image: Blob) => {
      if ((await image.text()) === "no face") throw new Error("No face was detected.");
      uploads.push(id);
      library.get(id)!.push(`f${uploads.length}.webp`);
      return false;
    },
    remove: async (id: string) => void library.delete(id),
  } as unknown as FrigateFaces;
  const { base, call } = await setup(t, { mcp: { tokens } as unknown as McpDeps, faces, faceImports: new FaceImports(join(dir, "people-imports.json")) });
  const auth = { Authorization: `Bearer ${token}` };
  const send = (path: string, init: RequestInit = {}) => fetch(base() + path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const photo = (text: string) => {
    const form = new FormData();
    form.set("file", new Blob([text], { type: "image/jpeg" }), "p.jpg");
    return { method: "POST", body: form };
  };

  assert.equal((await fetch(base() + "/people")).status, 401);
  assert.deepEqual(await (await send("/people")).json(), [{ id: "Alice", faces: 1 }]);
  // an agent reads the list but adds nobody
  assert.equal((await fetch(base() + "/people", { headers: agent })).status, 200);
  const byAgent = await fetch(base() + "/people", { method: "POST", headers: { ...agent, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Eve" }) });
  assert.equal(byAgent.status, 403);
  assert.equal((await send("/people/Bob/faces", photo("bob"))).status, 404, "a face does not create a person");
  const created = await send("/people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Bob Smith" }) });
  assert.deepEqual([created.status, (await created.json()).id], [201, "Bob_Smith"]);
  const again = await send("/people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "bob smith" }) });
  assert.deepEqual([again.status, (await again.json()).id], [409, "Bob_Smith"]);

  assert.deepEqual(await (await send("/people/Bob_Smith/faces", photo("bob"))).json(), { ok: true, added: true, night: false });
  assert.deepEqual(await (await send("/people/Bob_Smith/faces", photo("bob"))).json(), { ok: true, added: false }, "the same photo again");
  const bad = await send("/people/Bob_Smith/faces", photo("no face"));
  assert.deepEqual([bad.status, (await bad.json()).errors], [422, ["No face was detected."]]);
  assert.deepEqual(uploads, ["Bob_Smith"]);
  // a huge body is stopped while it arrives, not read into memory first
  const big = new FormData();
  big.set("file", new Blob([Buffer.alloc(13_000_000)], { type: "image/jpeg" }), "big.jpg");
  assert.equal((await send("/people/Bob_Smith/faces", { method: "POST", body: big })).status, 413);
  // the same without a declared length (chunked): cut off while reading
  const chunks = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.jpg\"\r\n\r\n"));
      for (let i = 0; i < 14; i++) c.enqueue(new Uint8Array(1_000_000));
      c.close();
    },
  });
  const chunked = await send("/people/Bob_Smith/faces", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: chunks, duplex: "half" } as RequestInit).catch(() => null);
  assert.equal(chunked?.status ?? 413, 413);
  assert.deepEqual(uploads, ["Bob_Smith"], "nothing reached Frigate");

  // deleting the person from the UI forgets its photos: they can be imported again
  await call("POST", "/api/login", { password: "right" });
  // a person's id is never a path
  assert.equal((await call("POST", "/api/people/Bob_Smith/merge", { into: "../train" })).status, 422);
  assert.equal((await call("DELETE", "/api/people/..%252Ftrain")).status, 422);
  await call("DELETE", "/api/people/Bob_Smith");
  await send("/people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Bob Smith" }) });
  assert.equal((await (await send("/people/Bob_Smith/faces", photo("bob"))).json()).added, true);
});

test("external events with tokens: devices report and get the pictures, agents only read them and see pictures of allowed cameras / eventi esterni con i token: i dispositivi li segnalano e ne hanno le foto, gli agenti li leggono e vedono le foto solo delle camere permesse", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "perception-external-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokens = new McpTokens(join(dir, "mcp-clients.json"));
  const device = { Authorization: `Bearer ${tokens.create("panel", "device").token}` };
  const agent = { Authorization: `Bearer ${tokens.create("assistant").token}` };
  const id = "0b9e3f52-6a8d-4c1e-9f0a-2d5b7c8e1f34";
  const event = { schema_version: 3, event_id: id, ts: new Date().toISOString(), type: "external", camera: "front_right", cameras: ["front_right"], place: "outdoor", person: { name: "Alice", confidence: 0.9, source: "face", photo: `${id}-1.jpg`, face: `${id}-1-face.jpg` }, people: [{ name: "Alice", confidence: 0.9, source: "face", photo: `${id}-1.jpg`, face: `${id}-1-face.jpg` }], unrecognized: 0, image: `${id}-1.jpg`, value: { from: null, to: "ring" }, media: { frigate_ids: [] }, text: "", reactions: [], importance: "normal" };
  const timeline = join(dir, "timeline.jsonl");
  writeFileSync(timeline, JSON.stringify(event) + "\n");
  writeFileSync(join(dir, `${id}-1.jpg`), "jpeg");
  const handled: string[] = [];
  const handler = { handle: async (r: { kind: string }) => (handled.push(r.kind), event) } as unknown as External;
  const { base, call } = await setup(t, { mcp: { tokens } as unknown as McpDeps, timelinePath: timeline, external: { handler, dir } });
  const post = (headers: Record<string, string>) =>
    fetch(base() + "/external", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "ring", camera: "front_right" }) });

  // an agent cannot make a camera take a picture
  assert.equal((await post(agent)).status, 403);
  assert.deepEqual(handled, []);
  const reported = (await (await post(device)).json()).event;
  assert.deepEqual([handled, reported.image, reported.person.face], [["ring"], `${id}-1.jpg`, `${id}-1-face.jpg`]);

  // the camera's images are not allowed for agents: no picture names, no pictures
  const [seen] = await (await fetch(base() + "/external", { headers: agent })).json();
  assert.deepEqual([seen.image, seen.person.photo, seen.people[0].face, seen.person.name], [undefined, undefined, undefined, "Alice"]);
  assert.equal((await fetch(base() + `/external/${id}-1.jpg`, { headers: agent })).status, 404);
  assert.equal((await fetch(base() + `/external/${id}-1.jpg`, { headers: device })).status, 200);

  // allowed in Agents → Camera images: the agent sees them too
  await call("POST", "/api/login", { password: "right" });
  const cfg = (await call("GET", "/api/config")).data as { version: number; outputs: { mcp: { snapshots: string[] } } };
  cfg.outputs.mcp.snapshots = ["front_right"];
  assert.equal((await call("PUT", "/api/config", { config: cfg, base_version: cfg.version })).status, 200);
  assert.equal((await (await fetch(base() + "/external", { headers: agent })).json())[0].image, `${id}-1.jpg`);
  assert.equal((await fetch(base() + `/external/${id}-1.jpg`, { headers: agent })).status, 200);
});

test("wrong passwords: two are free, then every attempt waits, even in parallel / password sbagliate: due sono libere, poi ogni tentativo aspetta, anche in parallelo", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("POST", "/api/login", { password: "a" })).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "b" })).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "c" })).status, 401);
  // now locked for a second: parallel guesses, and even the right one, are turned away without a check
  const burst = await Promise.all(["d", "e", "right"].map((password) => call("POST", "/api/login", { password })));
  assert.deepEqual(burst.map((r) => r.status), [429, 429, 429]);
  assert.match(burst[0]!.data.errors[0], /too many wrong passwords/);
});

test("first start from another site: refused, by name (DNS rebinding) or by origin / primo avvio da un altro sito: rifiutato, per nome (DNS rebinding) o per origine", async (t) => {
  const { base } = await setup(t, { password: new UiPassword(join(mkdtempSync(join(tmpdir(), "perception-setup-")), "ui.json")) });
  const port = new URL(base()).port;
  const setupFrom = (headers: Record<string, string>) =>
    fetch(base() + "/api/setup", { method: "POST", headers: { "Content-Type": "text/plain", ...headers }, body: JSON.stringify({ password: "attacker-chosen" }) });
  // node's fetch sets Host from the URL: a raw request is needed to send another one
  const { request } = await import("node:http");
  const status = await new Promise<number>((done) => {
    const r = request({ host: "127.0.0.1", port, path: "/api/setup", method: "POST", headers: { Host: `evil.example.com:${port}`, "Content-Type": "text/plain" } }, (res) => done(res.statusCode ?? 0));
    r.end(JSON.stringify({ password: "attacker-chosen" }));
  });
  assert.equal(status, 403);
  assert.equal((await setupFrom({ Origin: "https://evil.example.com" })).status, 403);
  assert.equal((await setupFrom({})).status, 200, "the owner, from the page itself");
});
