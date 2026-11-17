import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "../src/events.ts";
import { describe as describeEvent } from "../src/events.ts";
import { inside, PostureTracker, resolvePosture, withPosture } from "../src/posture.ts";
import { validate } from "../src/settings.ts";

const sofa: [number, number][] = [[0.2, 0.4], [0.6, 0.4], [0.6, 0.9], [0.2, 0.9]];

test("point in polygon / punto nel poligono", () => {
  assert.equal(inside([0.4, 0.6], sofa), true);
  assert.equal(inside([0.7, 0.6], sofa), false);
  assert.equal(inside([0.4, 0.95], sofa), false);
});

test("lying on the sofa stays lying, outside it is on the floor; without rest zones nothing is decided / sdraiato sul divano resta sdraiato, fuori è a terra; senza zone di riposo non si decide", () => {
  assert.equal(resolvePosture("lying", [0.4, 0.6], [sofa]), "lying");
  assert.equal(resolvePosture("lying", [0.8, 0.6], [sofa]), "on_floor");
  assert.equal(resolvePosture("lying", [0.8, 0.6], []), "lying");
  assert.equal(resolvePosture("sitting", [0.8, 0.6], [sofa]), "sitting");
});

test("room without sofa or bed: lying is always on the floor / stanza senza divano né letto: sdraiato è sempre a terra", () => {
  assert.equal(resolvePosture("lying", [0.4, 0.6], [], true), "on_floor");
  assert.equal(resolvePosture("sitting", [0.4, 0.6], [], true), "sitting");
  // drawn rest zones win over the flag
  assert.equal(resolvePosture("lying", [0.4, 0.6], [sofa], true), "lying");
});

test("debounce: a change only when the posture is stable; uncertain does not count / debounce: un cambio solo quando la postura è stabile; incerto non conta", () => {
  let now = 0;
  const events: Observation[] = [];
  const t = new PostureTracker({ stableMs: 15_000, minConf: 0, minSamples: 3, enterRatio: 0.66 }, { now: () => now, emit: (e) => events.push(e) });
  const who = { name: "Alice", camera: "living_room", person: { name: "Alice", confidence: 0.9, source: "face" as const }, trackId: "t1" };
  for (const label of ["sitting", "sitting", "uncertain", "sitting", "on_floor", "sitting"]) {
    t.push(who, label, 15_000);
    now += 5_000;
  }
  assert.deepEqual(events.map((e) => e.value), [{ from: null, to: "sitting" }]);
  for (const label of ["on_floor", "on_floor", "on_floor", "on_floor"]) {
    t.push(who, label, 15_000);
    now += 5_000;
  }
  assert.deepEqual(events.map((e) => e.value?.to), ["sitting", "on_floor"]);
  assert.equal(events[1]!.type, "posture_changed");
  assert.deepEqual(events[1]!.media.frigate_ids, ["t1"]);
  assert.equal(describeEvent(events[1]!, "living_room"), "Alice in living room: on floor");

  // a short absence keeps the posture; a long one forgets it
  t.prune(new Set());
  assert.equal(t.current("Alice"), "on_floor");
  now += 5 * 60_000 + 1;
  t.prune(new Set());
  assert.equal(t.current("Alice"), null);
});

test("a new track after a short absence does not re-announce the posture / un nuovo track dopo una breve assenza non riannuncia la postura", () => {
  let now = 0;
  const events: Observation[] = [];
  const t = new PostureTracker({ stableMs: 15_000, minConf: 0, minSamples: 3, enterRatio: 0.66 }, { now: () => now, emit: (e) => events.push(e) });
  const who = (trackId: string) => ({ name: "Alice", camera: "living_room", person: { name: "Alice", confidence: 0.9, source: "face" as const }, trackId });
  const sit = (trackId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      t.push(who(trackId), "sitting", 15_000);
      now += 5_000;
    }
  };
  sit("t1", 5);
  // Frigate loses the track for 40 s and opens a new one
  for (let i = 0; i < 8; i++) {
    t.prune(new Set());
    now += 5_000;
  }
  sit("t2", 5);
  assert.deepEqual(events.map((e) => e.value), [{ from: null, to: "sitting" }]);
});

test("schema: posture with existing analyzer and rest zones; rules on posture labels / schema: postura con analizzatore e zone di riposo esistenti; regole sulle etichette di postura", () => {
  const cfg = (posture: Record<string, unknown>, endpoints: Record<string, unknown> = { onnx: { url: "http://127.0.0.1:8100" } }) => ({
    version: 1,
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} }, endpoints },
    cameras: { living_room: { place: "living_room", kind: "indoor", zones: { sofa }, observe: { presence: {}, posture } } },
    rules: [{ id: "fall", name: "Person on the floor", when: { event: "posture_changed", value: "on_floor" }, then: [{ react: "notify", to: "everyone", urgent: true }] }],
  });
  const ok = validate(cfg({ analyzer: "onnx", model: "pose", rest_zones: ["sofa"] }));
  assert.ok(ok.ok, ok.ok ? "" : ok.errors.join());
  assert.equal(ok.ok && ok.config.cameras.living_room!.observe.posture!.interval_s, 5);
  const bad = validate(cfg({ analyzer: "gpu", model: "pose", rest_zones: ["bed"] }));
  assert.ok(!bad.ok);
  assert.match(bad.errors.join(), /analyzer "gpu" is not defined/);
  assert.match(bad.errors.join(), /zone "bed" is not defined/);
});

test("the measured posture answers lying down instead of the VLM / la postura misurata risponde a «sdraiato» al posto del VLM", () => {
  const vlm = { person_visible: true, lying_down: true, eyes_closed: false };
  assert.deepEqual(withPosture(vlm, "sitting"), { ...vlm, lying_down: false }, "sitting back on the sofa is not lying");
  assert.deepEqual(withPosture({ ...vlm, lying_down: false }, "on_floor"), { ...vlm, lying_down: true });
  assert.deepEqual(withPosture(vlm, "uncertain"), vlm, "an uncertain posture leaves the VLM's answer");
  assert.deepEqual(withPosture(vlm, null), vlm, "no posture measured: the VLM's answer");
  assert.deepEqual(withPosture({ person_visible: true }, "lying"), { person_visible: true }, "a camera that does not ask it gets nothing new");
});
