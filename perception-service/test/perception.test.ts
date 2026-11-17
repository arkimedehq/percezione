import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { FrigateEvent } from "../src/frigate.ts";
import type { Observation } from "../src/events.ts";
import { passes, Perception } from "../src/perception.ts";
import { parseResponse } from "../src/vlm.ts";

const params = { stableMs: 40_000, minConf: 0.6, minSamples: 3, enterRatio: 0.66, absenceMs: 60_000, trackStaleMs: 600_000, inheritIou: 0.3 };

function ev(type: FrigateEvent["type"], id: string, name: string | null, t: number): FrigateEvent {
  return {
    type,
    after: {
      id,
      camera: "attic",
      label: "person",
      sub_label: name ? [name, 0.95] : null,
      frame_time: t / 1000,
      start_time: t / 1000,
      end_time: type === "end" ? t / 1000 : null,
      stationary: false,
      false_positive: false,
      box: [100, 100, 300, 600],
    },
  };
}

function setup() {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const events: Observation[] = [];
  const observed = new Set(["attic"]);
  const p = new Perception(params, { now: Date.now, emit: (e) => events.push(e), observes: (c) => observed.has(c) });
  return { p, events, observed, tick: (ms: number) => mock.timers.tick(ms) };
}

test("arrived only when the sub_label arrives, only once / arrived solo quando arriva il sub_label, una volta sola", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events } = setup();
  p.handleEvent(ev("new", "a", null, Date.now()));
  assert.equal(events.length, 0);
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  assert.deepEqual(events.map((e) => e.type), ["arrived"]);
  assert.deepEqual(events[0]!.person, { name: "Alice", confidence: 0.95, source: "face" });
  assert.equal(events[0]!.camera, "attic");
  assert.deepEqual(events[0]!.media.frigate_ids, ["a"]);
});

test("back within ABSENCE_SECONDS with a new track: neither left nor arrived / rientro entro ABSENCE_SECONDS con un nuovo track: nessun left né arrived", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events, tick } = setup();
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  p.handleEvent(ev("end", "a", "Alice", Date.now()));
  tick(20_000);
  p.handleEvent(ev("new", "b", null, Date.now()));
  p.handleEvent(ev("update", "b", "Alice", Date.now()));
  tick(120_000);
  assert.deepEqual(events.map((e) => e.type), ["arrived"]);
  assert.equal(p.present().length, 1);
});

test("left after ABSENCE_SECONDS, with the last activity / left dopo ABSENCE_SECONDS, con l'ultima attività", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events, tick } = setup();
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  for (let i = 0; i < 3; i++) {
    p.addSample("Alice", { label: "tinkering", conf: 0.9, ts: Date.now() });
    tick(10_000);
  }
  p.handleEvent(ev("end", "a", "Alice", Date.now()));
  tick(59_000);
  assert.equal(events.at(-1)!.type, "activity_changed");
  tick(1_000);
  const left = events.at(-1)!;
  assert.equal(left.type, "left");
  assert.equal(left.activity, "tinkering");
  assert.equal(p.present().length, 0);
});

test("unknown people generate no events / persone sconosciute non generano eventi", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events } = setup();
  p.handleEvent(ev("new", "x", null, Date.now()));
  p.handleEvent(ev("end", "x", null, Date.now()));
  assert.equal(events.length, 0);
});

test("parseResponse discards invalid JSON and missing or non-boolean attributes / parseResponse scarta JSON non valido e attributi mancanti o non booleani", () => {
  const names = ["phone_in_hand", "phone_at_ear"];
  assert.deepEqual(parseResponse('{"phone_in_hand":true,"phone_at_ear":false}', names), {
    phone_in_hand: true,
    phone_at_ear: false,
  });
  assert.equal(parseResponse("not json", names), null);
  assert.equal(parseResponse('{"phone_in_hand":true}', names), null);
  assert.equal(parseResponse('{"phone_in_hand":"yes","phone_at_ear":false}', names), null);
});

test("track split by a still person: the new unnamed track inherits the name / track spezzato da persona ferma: il nuovo track senza nome eredita il nome", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events, tick } = setup();
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  p.handleEvent(ev("end", "a", "Alice", Date.now()));
  tick(2_000);
  p.handleEvent(ev("new", "b", null, Date.now()));
  tick(120_000);
  assert.deepEqual(events.map((e) => e.type), ["arrived"]);
  assert.deepEqual(p.present().map((x) => x.name), ["Alice"]);
});

test("no inheritance if the new track is elsewhere in the frame / nessuna eredità se il nuovo track è altrove nell'inquadratura", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events, tick } = setup();
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  p.handleEvent(ev("end", "a", "Alice", Date.now()));
  const far = ev("new", "b", null, Date.now());
  far.after.box = [1500, 100, 1700, 600];
  p.handleEvent(far);
  tick(61_000);
  assert.deepEqual(events.map((e) => e.type), ["arrived", "left"]);
});

test("on startup rebuilds the already recognized people from the WebSocket / all'avvio ricostruisce dal WebSocket le persone già riconosciute", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events } = setup();
  p.syncActive([
    { id: "a", camera: "attic", label: "person", sub_label: ["Alice", 0.9] },
    { id: "x", camera: "attic", label: "person", sub_label: null },
  ]);
  assert.deepEqual(events.map((e) => [e.type, e.person?.name]), [["arrived", "Alice"]]);
  assert.deepEqual(p.present(), [
    { name: "Alice", room: "attic", box: null, person: { name: "Alice", confidence: 0.9, source: "face" }, trackId: "a", activity: null },
  ]);
});

test("tracks kept alive by the WebSocket do not expire / i track tenuti vivi dal WebSocket non scadono", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events, tick } = setup();
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  for (let i = 0; i < 100; i++) {
    tick(15_000);
    p.syncActive([{ id: "a", camera: "attic", label: "person", sub_label: null }]);
    p.sweepStale();
  }
  assert.deepEqual(events.map((e) => e.type), ["arrived"]);
});

test("hot change: a camera without presence is ignored, ongoing tracks stay / a caldo: una camera senza presenza viene ignorata, i track già in corso restano", (t) => {
  t.after(() => mock.timers.reset());
  const { p, events, observed, tick } = setup();
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  observed.delete("attic");
  p.handleEvent(ev("update", "b", "Carol", Date.now()));
  assert.deepEqual(events.map((e) => e.person?.name), ["Alice"]);
  // the end arrives anyway: Alice leaves normally
  p.handleEvent(ev("end", "a", "Alice", Date.now()));
  tick(61_000);
  assert.deepEqual(events.map((e) => e.type), ["arrived", "left"]);
});

test("activity_changed carries from and to in value; the debounce window is the camera's / activity_changed porta da e a in valore; la finestra del debounce è quella della camera", (t) => {
  t.after(() => mock.timers.reset());
  const events: Observation[] = [];
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  // camera window 25 s: three samples 10 s apart cover 20 s and are enough
  const p = new Perception({ ...params, stableMs: 5_000 }, { now: Date.now, emit: (e) => events.push(e), stableMsFor: () => 25_000 });
  p.handleEvent(ev("update", "a", "Alice", Date.now()));
  for (let i = 0; i < 3; i++) {
    p.addSample("Alice", { label: "reading", conf: 1, ts: Date.now() });
    mock.timers.tick(10_000);
  }
  assert.deepEqual(events.at(-1)!.value, { from: null, to: "reading" });
});

test("a new name needs the camera's minimum face score / un nome nuovo vuole il punteggio minimo della camera", (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const events: Observation[] = [];
  const p = new Perception(params, { now: Date.now, emit: (e) => events.push(e), minFaceScore: () => 0.96 });
  p.handleEvent(ev("update", "a", "Alice", Date.now())); // 0.95
  assert.equal(events.length, 0);
  const sure = ev("update", "a", "Alice", Date.now());
  sure.after.sub_label = ["Alice", 0.97];
  p.handleEvent(sure);
  assert.deepEqual(events.map((e) => e.type), ["arrived"]);
  assert.equal(passes(null, 0.9), false);
  assert.equal(passes(null, undefined), true);
});
