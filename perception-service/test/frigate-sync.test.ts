import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { FrigateSync } from "../src/frigate-sync.ts";
import { ConfigStore } from "../src/settings.ts";

const camera = (fps: number) => ({
  ffmpeg: { inputs: [{ path: "rtsp://192.0.2.134:8554/living_room", input_args: "preset-rtsp-restream", roles: ["detect"] }] },
  detect: { enabled: true, width: 1920, height: 1080, fps },
});

/** Fake Frigate: YAML in memory, `config/set` that merges like Frigate and can reject a topic. */
function fakeFrigate(reject?: RegExp) {
  const state = { cameras: { living_room: camera(5) } as Record<string, any> };
  const calls: string[] = [];
  const merge = (dst: Record<string, any>, src: Record<string, any>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v === null) delete dst[k];
      else if (typeof v === "object" && !Array.isArray(v)) merge((dst[k] ??= {}), v);
      else dst[k] = v;
    }
  };
  const fetch = async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/api/config/raw")) return new Response(JSON.stringify(stringify(state)));
    const body = JSON.parse(String(init!.body));
    calls.push(body.update_topic);
    if (reject?.test(body.update_topic)) return Response.json({ success: false, message: "Error saving config: no" }, { status: 400 });
    merge(state, body.config_data);
    return Response.json({ success: true, message: "Config successfully updated" });
  };
  return { state, calls, fetch };
}

function setup(reject?: RegExp) {
  const dir = mkdtempSync(join(tmpdir(), "perception-sync-"));
  const store = new ConfigStore(join(dir, "config.json"), () => ({
    version: 1,
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    cameras: { living_room: { place: "living_room", kind: "indoor" } },
  }));
  const frigate = fakeFrigate(reject);
  const logs: string[] = [];
  const sync = new FrigateSync("http://frigate", store, "rtsp://192.0.2.134:8554", {
    info: (m) => logs.push(m),
    error: (m) => logs.push(`ERR ${m}`),
  });
  const pushes: Promise<void>[] = [];
  store.onChange((next, prev) => pushes.push(sync.onChange(next, prev)));
  const settle = async () => {
    for (let i = 0; i < pushes.length; i++) await pushes[i];
  };
  return { store, frigate, logs, sync, settle, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("initial import, then our change goes to Frigate only for the changed section / import iniziale, poi una modifica nostra va a Frigate solo per la sezione cambiata", async (t) => {
  const realFetch = globalThis.fetch;
  const { store, frigate, sync, settle, cleanup } = setup();
  globalThis.fetch = frigate.fetch as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });

  await sync.importChanges();
  await settle();
  assert.deepEqual(store.current.cameras.living_room!.stream, { go2rtc: "living_room" });
  assert.deepEqual(frigate.calls, [], "the import sends nothing back");

  const next = structuredClone(store.current);
  next.cameras.living_room!.zones.sofa = { points: [[0.1, 0.5], [0.4, 0.5], [0.4, 0.9]] };
  store.save(next);
  await settle();
  assert.deepEqual(frigate.calls, ["config/cameras/living_room/zones"]);
  assert.equal(frigate.state.cameras.living_room.zones.sofa.coordinates, "0.1,0.5,0.4,0.5,0.4,0.9");

  await sync.importChanges();
  assert.equal(store.current.version, 3, "no empty version after the push");
});

test("Frigate rejects a section: configuration and Frigate go back to how they were / Frigate rifiuta una sezione: configurazione e Frigate tornano come prima", async (t) => {
  const realFetch = globalThis.fetch;
  const { store, frigate, logs, sync, settle, cleanup } = setup(/\/zones$/);
  globalThis.fetch = frigate.fetch as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });
  await sync.importChanges();
  const before = store.current;

  const next = structuredClone(before);
  next.cameras.living_room!.detect!.fps = 2; // accepted
  next.cameras.living_room!.zones.sofa = { points: [[0.1, 0.5], [0.4, 0.5], [0.4, 0.9]] }; // rejected
  store.save(next);
  await settle();

  assert.deepEqual(frigate.calls, ["config/cameras/living_room/detect", "config/cameras/living_room/zones", "config/cameras/living_room/detect"]);
  assert.equal(frigate.state.cameras.living_room.detect.fps, 5, "the detect already sent was rolled back");
  assert.equal(store.current.version, before.version + 2);
  assert.equal(store.current.cameras.living_room!.detect!.fps, 5);
  assert.deepEqual(store.current.cameras.living_room!.zones, {});
  assert.ok(logs.some((l) => /ERR Frigate: v3 not applied: living_room\/zones: Error saving config: no/.test(l)), logs.join("\n"));
});

test("a change without cameras does not ask Frigate / una modifica senza camere non interpella Frigate", async (t) => {
  const realFetch = globalThis.fetch;
  const { store, frigate, sync, settle, cleanup } = setup();
  let asked = 0;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    asked++;
    return frigate.fetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });
  await sync.importChanges();
  asked = 0;
  // rules only: Frigate is not asked
  const next = structuredClone(store.current);
  next.rules.push({ id: "r", name: "r", enabled: true, when: {}, then: [{ react: "memory" }] });
  store.save(next);
  await settle();
  assert.equal(asked, 0);
  assert.equal(store.current.rules.length, 1, "kept");
});

test("Frigate down: the change is kept and sent when it is back, before any import / Frigate spento: la modifica resta e parte quando torna, prima di ogni import", async (t) => {
  const realFetch = globalThis.fetch;
  const { store, frigate, logs, sync, settle, cleanup } = setup();
  let up = true;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    up ? frigate.fetch(url, init) : Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });
  await sync.importChanges();
  const start = store.current.version;

  up = false;
  const next = structuredClone(store.current);
  next.cameras.living_room!.detect!.fps = 2;
  store.save(next);
  await settle();
  assert.equal(store.current.version, start + 1, "not rolled back");
  assert.equal(store.current.cameras.living_room!.detect!.fps, 2);
  assert.ok(sync.waiting);
  assert.ok(logs.some((l) => /Frigate unreachable: v\d+ will be sent when it is back/.test(l)), logs.join("\n"));

  await sync.importChanges(); // still down: nothing happens
  assert.ok(sync.waiting);

  up = true;
  await sync.importChanges();
  await settle();
  assert.equal(sync.waiting, false);
  assert.equal(frigate.state.cameras.living_room.detect.fps, 2, "Frigate caught up");
  assert.equal(store.current.cameras.living_room!.detect!.fps, 2, "Frigate's older value was not imported");
  assert.equal(store.current.version, start + 1);
});

test("detection off in Frigate: the import round turns it on, without a new version / detect spenta in Frigate: il giro di import la accende, senza una nuova versione", async (t) => {
  const realFetch = globalThis.fetch;
  const { store, frigate, sync, logs, settle, cleanup } = setup();
  globalThis.fetch = frigate.fetch as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });

  await sync.importChanges();
  await settle();
  const version = store.current.version;
  delete frigate.state.cameras.living_room.detect.enabled; // Frigate's default
  await sync.importChanges();
  assert.deepEqual(frigate.calls, ["config/cameras/living_room/detect"]);
  assert.equal(frigate.state.cameras.living_room.detect.enabled, true);
  assert.equal(store.current.version, version);
  assert.ok(logs.some((l) => l.includes("detection was off")));
  await sync.importChanges();
  assert.equal(frigate.calls.length, 1, "nothing more once it is on");
});
