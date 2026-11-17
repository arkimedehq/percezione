import assert from "node:assert/strict";
import { test } from "node:test";
import type { FrigateEvent, FrigateObject } from "../src/frigate.ts";
import type { Observation } from "../src/events.ts";
import { Outdoor } from "../src/outdoor.ts";

const GAP = 15_000;

function setup(minFaceScore?: (camera: string) => number | undefined) {
  let now = 1_000_000;
  const events: Observation[] = [];
  const outdoor = new Outdoor(
    {
      cameras: new Set(["front_right", "front_left"]),
      zones: new Map([["front_right", "entrance"], ["front_left", "entrance"]]),
      trackStaleMs: 90_000,
      mergeGapMs: GAP,
    },
    { now: () => now, emit: (e) => events.push(e), minFaceScore },
  );
  /** Frigate event at the current time; start_time defaults to now on the track's first event */
  const starts = new Map<string, number>();
  const ev = (type: FrigateEvent["type"], o: Partial<FrigateObject> = {}): void => {
    const id = o.id ?? "t1";
    if (!starts.has(id)) starts.set(id, now / 1000);
    outdoor.handleEvent({
      type,
      after: {
        id,
        camera: "front_right",
        label: "person",
        sub_label: null,
        frame_time: now / 1000,
        start_time: starts.get(id)!,
        end_time: type === "end" ? now / 1000 : null,
        stationary: false,
        false_positive: false,
        box: [0, 0, 10, 10],
        current_zones: [],
        ...o,
      },
    });
  };
  const advance = (ms: number) => {
    now += ms;
    outdoor.sweepStale();
  };
  return { events, ev, advance, outdoor };
}

test("unknown person passing without coming close: a single passage after the gap, person null / sconosciuto che passa senza avvicinarsi: un solo passaggio dopo la pausa, persona null", () => {
  const { events, ev, advance } = setup();
  ev("new");
  advance(12_000);
  ev("end");
  advance(10_000);
  assert.equal(events.length, 0, "not yet: it may show up on the other camera");
  advance(10_000);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "passage");
  assert.equal(events[0]!.person, null);
  assert.equal(events[0]!.duration_s, 12);
  assert.equal(events[0]!.approached, false);
  assert.deepEqual(events[0]!.cameras, ["front_right"]);
  assert.deepEqual(events[0]!.media.frigate_ids, ["t1"]);
});

test("the same person seen by both cameras is a single passage / la stessa persona vista dalle due camere è un solo passaggio", () => {
  const { events, ev, advance } = setup();
  ev("new", { id: "left", camera: "front_left" });
  advance(20_000);
  ev("new", { id: "right", camera: "front_right" }); // shows up on the other camera while still on the first
  advance(6_000);
  ev("end", { id: "left", camera: "front_left" });
  advance(20_000);
  ev("end", { id: "right", camera: "front_right" });
  advance(20_000);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.cameras, ["front_left", "front_right"]);
  assert.deepEqual(events[0]!.media.frigate_ids, ["left", "right"]);
  assert.equal(events[0]!.duration_s, 46);
});

test("merges also when the other camera sees them within the gap, not beyond / unisce anche se l'altra camera la vede entro la pausa, non oltre", () => {
  const { events, ev, advance } = setup();
  ev("new", { id: "a", camera: "front_left" });
  advance(5_000);
  ev("end", { id: "a", camera: "front_left" });
  advance(8_000);
  ev("new", { id: "b", camera: "front_right" }); // 8 s later: same person
  advance(5_000);
  ev("end", { id: "b", camera: "front_right" });
  advance(20_000);
  assert.equal(events.length, 1);
  ev("new", { id: "c", camera: "front_left" }); // much later: another passage
  advance(5_000);
  ev("end", { id: "c", camera: "front_left" });
  advance(20_000);
  assert.equal(events.length, 2);
});

test("two people together on the same camera stay two passages / due persone insieme sulla stessa camera restano due passaggi", () => {
  const { events, ev, advance } = setup();
  ev("new", { id: "p1" });
  ev("new", { id: "p2" });
  advance(5_000);
  ev("end", { id: "p1" });
  ev("end", { id: "p2" });
  advance(20_000);
  assert.equal(events.filter((e) => e.type === "passage").length, 2);
});

test("approach right away and once per passage, even when entering the zone from both cameras / avvicinamento subito e una sola volta per passaggio, anche se entra nella zona da tutte e due le camere", () => {
  const { events, ev, advance } = setup();
  ev("new", { id: "left", camera: "front_left" });
  ev("update", { id: "left", camera: "front_left", current_zones: ["entrance"] });
  assert.deepEqual(events.map((e) => e.type), ["approach"]);
  assert.equal(events[0]!.camera, "front_left");
  assert.equal(events[0]!.zone, "entrance");
  ev("new", { id: "right", camera: "front_right", current_zones: ["entrance"] });
  advance(3_000);
  ev("end", { id: "left", camera: "front_left" });
  ev("end", { id: "right", camera: "front_right" });
  advance(20_000);
  assert.deepEqual(events.map((e) => e.type), ["approach", "passage"]);
  assert.equal(events[1]!.approached, true);
});

test("the name recognized on one camera holds for the whole passage / il nome riconosciuto su una camera vale per tutto il passaggio", () => {
  const { events, ev, advance } = setup();
  ev("new", { id: "left", camera: "front_left" });
  ev("new", { id: "right", camera: "front_right" });
  ev("update", { id: "right", camera: "front_right", sub_label: ["Alice", 0.9] });
  advance(3_000);
  ev("end", { id: "left", camera: "front_left" });
  ev("end", { id: "right", camera: "front_right", sub_label: ["Alice", 0.9] });
  advance(20_000);
  assert.deepEqual(events.at(-1)!.person, { name: "Alice", confidence: 0.9, source: "face" });
});

test("indoor cameras and false positives ignored / camere interne e falsi positivi ignorati", () => {
  const { events, ev, advance } = setup();
  ev("new", { camera: "living_room" });
  ev("end", { camera: "living_room" });
  ev("new", { id: "fp", false_positive: true });
  ev("end", { id: "fp", false_positive: true });
  advance(30_000);
  assert.equal(events.length, 0);
});

test("lost end: the track closes after trackStaleMs and the passage goes out / end perso: il track si chiude dopo trackStaleMs e il passaggio esce", () => {
  const { events, ev, advance } = setup();
  ev("new");
  advance(60_000);
  assert.equal(events.length, 0);
  advance(40_000); // closed for inactivity (lastSeen 100 s ago)
  advance(20_000);
  assert.deepEqual(events.map((e) => e.type), ["passage"]);
});

test("hot change: removed zone and changed merge gap apply from the next event, the ongoing passage stays / a caldo: zona tolta e intervallo di unione cambiato valgono dal prossimo evento, il passaggio in corso resta", () => {
  const { events, ev, advance, outdoor } = setup();
  ev("new", { id: "a", camera: "front_left" });
  outdoor.configure({ cameras: new Set(["front_right", "front_left"]), zones: new Map(), trackStaleMs: 90_000, mergeGapMs: 40_000 });
  ev("update", { id: "a", camera: "front_left", current_zones: ["entrance"] });
  advance(5_000);
  ev("end", { id: "a", camera: "front_left" });
  advance(30_000);
  ev("new", { id: "b", camera: "front_right" }); // 30 s later: with a 40 s merge gap it is the same passage
  advance(5_000);
  ev("end", { id: "b", camera: "front_right" });
  advance(45_000);
  assert.deepEqual(events.map((e) => e.type), ["passage"]);
  assert.deepEqual(events[0]!.media.frigate_ids, ["a", "b"]);
  assert.equal(events[0]!.approached, false);
});

test("names below the camera's minimum face score are ignored / nomi sotto il punteggio minimo della camera ignorati", () => {
  const { events, ev, advance } = setup(() => 0.92);
  ev("new", { id: "a" });
  ev("update", { id: "a", sub_label: ["Eve", 0.86] });
  ev("end", { id: "a", sub_label: ["Eve", 0.86] });
  advance(20_000);
  assert.equal(events.at(-1)!.person, null);
  ev("new", { id: "b" });
  ev("end", { id: "b", sub_label: ["Alice", 0.95] });
  advance(20_000);
  assert.equal(events.at(-1)!.person?.name, "Alice");
});
