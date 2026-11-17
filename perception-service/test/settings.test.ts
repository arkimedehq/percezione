import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalize, type Observation } from "../src/events.ts";
import { polygon } from "../src/seed.ts";
import { ConfigStore, TUNING, tuningOf, validate } from "../src/settings.ts";

const square: [number, number][] = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]];

function sample() {
  return {
    version: 1,
    cameras: {
      living_room: {
        place: "living_room",
        kind: "indoor",
        observe: {
          presence: {},
          activity: { rules: [{ if: { lying_down: true }, then: "resting" }], default: "other", interval_s: 10, stable_s: 40 },
        },
      },
      front_right: {
        place: "outdoor",
        kind: "outdoor",
        zones: { entrance: square },
        observe: { passages: { group: "street" }, approach: { zone: "entrance" } },
      },
    },
    analyzers: { vlm: { model: "qwen3-vl:4b-instruct", vocabulary: { resting: "…", other: "…" }, attributes: { lying_down: "…" } } },
    rules: [{ id: "street", name: "Passages", when: { event: "passage" }, then: [{ react: "memory", importance: "low" }] }],
  } as Record<string, any>;
}

function errorsOf(cfg: unknown): string[] {
  const v = validate(cfg);
  return v.ok ? [] : v.errors;
}

test("a valid configuration passes and gets the defaults / una configurazione valida passa e riceve i default", () => {
  const v = validate(sample());
  assert.ok(v.ok);
  assert.deepEqual(v.config.cameras.living_room!.zones, {});
  assert.equal(v.config.cameras.front_right!.observe.passages!.merge_s, 15);
  assert.equal(v.config.rules[0]!.enabled, true);
});

test("consistency: zones, vocabulary, cameras and rule ids / coerenza: zone, vocabolario, camere e id delle regole", () => {
  const cases: [(c: Record<string, any>) => void, RegExp][] = [
    [(c) => (c.cameras.front_right.observe.approach.zone = "gate"), /zone "gate" is not defined/],
    [(c) => delete c.cameras.front_right.observe.passages, /needs the passages observation/],
    [(c) => (c.cameras.living_room.observe.activity.rules[0].then = "dancing"), /"dancing" is not in the vocabulary/],
    [(c) => (c.cameras.living_room.observe.activity.rules[0].if = { flying: true }), /question "flying" is not defined/],
    [(c) => (c.rules[0].when.cameras = ["garage"]), /camera "garage" does not exist/],
    [(c) => c.rules.push({ ...c.rules[0] }), /duplicate id "street"/],
    [(c) => (c.rules[0].then = [{ react: "webhook", to: "nodered" }]), /webhook "nodered" is not defined/],
    [(c) => (c.rules[0].when.hours = "23-6"), /HH:MM-HH:MM/],
    [(c) => (c.cameras.living_room.observe.posture = {}), /posture/],
    [(c) => (c.cameras["Camera 5"] = c.cameras.living_room), /Camera 5/],
  ];
  for (const [mutate, expected] of cases) {
    const c = sample();
    mutate(c);
    const errors = errorsOf(c);
    assert.ok(errors.some((e) => expected.test(e)), `${expected}: ${JSON.stringify(errors)}`);
  }
});

test("camera credentials only as Frigate placeholders / credenziali delle camere solo come segnaposto di Frigate", () => {
  const withStream = (rtsp: string) => {
    const c = sample();
    c.cameras.living_room.stream = { rtsp };
    return errorsOf(c);
  };
  assert.deepEqual(withStream("rtsp://{FRIGATE_CAM4_USER}:{FRIGATE_CAM4_PASSWORD}@{FRIGATE_CAM4_HOST}:554/Streaming/Channels/101"), []);
  assert.deepEqual(withStream("rtsp://192.0.2.93:554/live"), []);
  assert.match(withStream("rtsp://admin:secret@192.0.2.93:554/live").join(), /plain-text password/);
});

test("Frigate coordinates: relative or in pixels / coordinate di Frigate: relative o in pixel", () => {
  assert.deepEqual(polygon("0.523,0.288,0.597,0.289,0.559,0.742", { width: 2688, height: 1520 }), [
    [0.523, 0.288],
    [0.597, 0.289],
    [0.559, 0.742],
  ]);
  assert.deepEqual(polygon(["1344,760", "2688,1520", "0,1520"], { width: 2688, height: 1520 }), [
    [0.5, 0.5],
    [1, 1],
    [0, 1],
  ]);
});

function tempStore(seed = sample) {
  const dir = mkdtempSync(join(tmpdir(), "perception-config-"));
  const path = join(dir, "config.json");
  return { dir, path, store: new ConfigStore(path, seed), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("first start from the seed, then versioned saves in config-history / primo avvio dal seme, poi salvataggi versionati in config-history", (t) => {
  const { dir, path, store, cleanup } = tempStore();
  t.after(cleanup);
  assert.equal(store.current.version, 1);
  assert.ok(existsSync(path));
  const changes: number[][] = [];
  store.onChange((next, prev) => changes.push([prev.version, next.version]));

  const next = structuredClone(store.current);
  next.rules[0]!.then = [{ react: "notify", to: "family" }];
  const r = store.save(next);
  assert.ok(r.ok);
  assert.equal(store.current.version, 2);
  assert.deepEqual(changes, [[1, 2]]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
  assert.deepEqual(readdirSync(join(dir, "config-history")).map((f) => f.split("-")[0]).sort(), ["v1", "v2"]);

  // an invalid configuration changes nothing
  const bad = structuredClone(store.current) as Record<string, any>;
  bad.rules[0].when.cameras = ["garage"];
  assert.equal(store.save(bad).ok, false);
  assert.equal(store.current.version, 2);
});

test("manual edit: a valid one applies with the next version, an invalid one keeps the previous / modifica a mano: valida si applica con la versione successiva, non valida resta la precedente", (t) => {
  const { path, store, cleanup } = tempStore();
  t.after(cleanup);
  const errors: string[][] = [];

  writeFileSync(path, "{ not json");
  store.reload((e) => errors.push(e));
  assert.match(errors[0]![0]!, /invalid JSON/);
  assert.equal(store.current.version, 1);

  const edited = sample();
  edited.rules[0].name = "Street (edited)";
  writeFileSync(path, JSON.stringify(edited)); // version still 1: the service bumps it
  store.reload((e) => errors.push(e));
  assert.equal(errors.length, 1);
  assert.equal(store.current.version, 2);
  assert.equal(store.current.rules[0]!.name, "Street (edited)");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
});

test("hot reload: rules changed in the file while the service runs, no event lost / hot reload: regole cambiate nel file a servizio acceso, nessun evento perso", async (t) => {
  const { path, store, cleanup } = tempStore();
  t.after(() => {
    store.close();
    cleanup();
  });
  store.watch(() => assert.fail("configuration rejected"));
  const applied = new Promise<void>((done) => store.onChange(() => done()));

  const passage = (n: number): Observation => ({
    event_id: `p${n}`,
    ts: "2026-11-07T12:00:00Z",
    type: "passage",
    camera: "front_right",
    cameras: ["front_right"],
    person: null,
    duration_s: 8,
    media: { frigate_ids: [`f${n}`] },
  });
  const out = [finalize(passage(1), store.current)];

  const edited = sample();
  edited.rules[0].then = [{ react: "notify", to: "family", urgent: true }];
  // on macOS a write right after the watch starts may go unreported (FSEvents)
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync(path, JSON.stringify(edited, null, 2));
  await Promise.race([applied, new Promise((_, ko) => setTimeout(() => ko(new Error("no reload within 3 s")), 3_000))]);

  out.push(finalize(passage(2), store.current));
  assert.deepEqual(out.map((e) => e.event_id), ["p1", "p2"]);
  assert.deepEqual(out.map((e) => e.reactions.map((r) => r.react)), [["memory"], ["notify"]]);
  assert.deepEqual(out.map((e) => e.importance), ["low", "high"]);
  assert.equal(out[1]!.place, "outdoor");
  assert.equal(store.current.version, 2);
});

test("tuning: the defaults, what is set wins, out of range is refused / regolazioni: i default, vince quello impostato, fuori misura è rifiutato", () => {
  const r = validate({ ...sample(), tuning: { absence_s: 120, min_conf: 0.7 } });
  assert.ok(r.ok);
  assert.deepEqual(tuningOf(r.config), { ...TUNING, absence_s: 120, min_conf: 0.7 });
  const plain = validate(sample());
  assert.ok(plain.ok);
  assert.deepEqual(tuningOf(plain.config), TUNING);
  assert.equal(validate({ ...sample(), tuning: { enter_ratio: 0.3 } }).ok, false);
  assert.equal(validate({ ...sample(), tuning: { walking: 1 } }).ok, false);
});
