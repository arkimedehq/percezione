import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAttempt } from "../src/people.ts";
import { validate, type Config } from "../src/settings.ts";
import { Sightings } from "../src/sightings.ts";
import { whoIsAt, whoRequest } from "../src/who.ts";

const NOW = new Date(1_800_000_000_500); // Frigate ids have a fraction of a second
const s = NOW.getTime() / 1000;

function config(): Config {
  const v = validate({
    version: 1,
    cameras: { front_door: { place: "entrance", kind: "outdoor" }, attic: { place: "attic", kind: "indoor" } },
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
  });
  assert.ok(v.ok);
  return v.config;
}

test("who is at a camera: names, unrecognized, recent faces nobody named / chi c'è a una camera: nomi, non riconosciuti, volti recenti senza nome", async () => {
  const who = await whoIsAt("front_door", {
    config,
    now: () => NOW,
    active: () => [
      { id: `${s - 30}-aaa`, camera: "front_door", label: "person", sub_label: ["Alice", 0.93] },
      { id: `${s - 20}-bbb`, camera: "front_door", label: "person", sub_label: null },
      { id: `${s - 10}-ccc`, camera: "attic", label: "person", sub_label: ["Bob", 0.95] },
      { id: `${s - 5}-ddd`, camera: "front_door", label: "car", sub_label: null },
    ],
    attempts: async () =>
      [
        `${s - 20}-bbb-${s - 15}-unknown-0.41.webp`, // the unnamed one in view
        `${s - 20}-bbb-${s - 12}-Dave-0.62.webp`, // a weak guess
        `${s - 30}-aaa-${s - 25}-Alice-0.97.webp`, // already a recognition: not a face to name
        `${s - 900}-eee-${s - 890}-unknown-0.3.webp`, // too old
        `${s - 60}-fff-${s - 50}-unknown-0.2.webp`, // gone from view, logged on this camera
        `${s - 40}-ggg-${s - 35}-unknown-0.2.webp`, // another camera
      ].map((f) => parseAttempt(f)!),
    trackCamera: (id) => ({ [`${s - 60}-fff`]: "front_door", [`${s - 40}-ggg`]: "attic" })[id],
  });
  assert.equal(who.place, "entrance");
  assert.deepEqual(who.people, [{ name: "Alice", confidence: 0.93 }]);
  assert.equal(who.unrecognized, 1);
  assert.deepEqual(
    who.unknown_faces.map((f) => [f.guess, f.score]),
    [
      ["Dave", 0.62],
      [null, 0.41],
      [null, 0.2],
    ],
  );
});

test("an MQTT request: JSON with an id, or just the camera / una richiesta MQTT: JSON con un id, o solo la camera", () => {
  const cams = ["front_door"];
  assert.deepEqual(whoRequest('{"camera":"front_door","id":"ring-1"}', cams), { camera: "front_door", id: "ring-1", photos: false });
  assert.deepEqual(whoRequest('{"camera":"front_door","photos":true}', cams), { camera: "front_door", id: null, photos: true });
  assert.deepEqual(whoRequest("front_door", cams), { camera: "front_door", id: null, photos: false });
  assert.deepEqual(whoRequest('{"camera":"garage"}', cams), { id: null, error: 'unknown camera "garage"' });
});

test("a group: people counted on the main camera, names from the others in their zones / un gruppo: persone contate sulla principale, nomi dalle altre nelle loro zone", async () => {
  const v = validate({
    version: 1,
    cameras: {
      front_door: { place: "entrance", kind: "outdoor" },
      yard: { place: "outdoor", kind: "outdoor", zones: { path: [[0, 0], [1, 0], [1, 1]] } },
      attic: { place: "attic", kind: "indoor" },
    },
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    groups: { door: { label: "Door", main: "front_door", members: { yard: { zones: ["path"] } }, window_s: 60 } },
  });
  assert.ok(v.ok);
  const sightings = new Sightings();
  const ev = (id: string, camera: string, name: string | null, zones: string[], at: number) =>
    sightings.handleEvent(
      { type: "update", after: { id, camera, label: "person", sub_label: name ? [name, 0.9] : null, frame_time: 0, start_time: 0, end_time: null, stationary: false, false_positive: false, box: [0, 0, 1, 1], entered_zones: zones } },
      at,
    );
  ev("t1", "yard", "Bob", ["path"], NOW.getTime() - 20_000); // on the way to the door
  ev("t2", "yard", "Carol", [], NOW.getTime() - 10_000); // in the yard, not on the path
  ev("t3", "yard", "Dave", ["path"], NOW.getTime() - 120_000); // too long ago
  ev("t4", "yard", "Alice", ["path"], NOW.getTime() - 5_000); // also at the door: counted there
  const deps = {
    config: () => v.config,
    now: () => NOW,
    active: () => [
      { id: "a", camera: "front_door", label: "person", sub_label: ["Alice", 0.93] as [string, number] },
      { id: "b", camera: "front_door", label: "person", sub_label: null },
    ],
    attempts: async () => [],
    trackCamera: () => undefined,
    sightings: (c: string, z: string[], since: number) => sightings.recent(c, z, since),
  };
  for (const target of ["door", "front_door"]) {
    const who = await whoIsAt(target, deps);
    assert.equal(who.camera, "front_door");
    assert.deepEqual(who.group, { id: "door", label: "Door", cameras: ["front_door", "yard"] });
    assert.deepEqual(who.people, [
      { name: "Alice", confidence: 0.93 },
      { name: "Bob", confidence: 0.9, seen_by: "yard", seen_at: new Date(NOW.getTime() - 20_000).toISOString() },
    ]);
    assert.equal(who.unrecognized, 1);
  }
  // a member camera asked alone is just a camera
  assert.equal((await whoIsAt("yard", deps)).group, undefined);
});

test("groups are checked: cameras, zones, one group per main camera, no camera's name / i gruppi sono controllati: camere, zone, un gruppo per principale, niente nomi di camere", () => {
  const v = validate({
    version: 1,
    cameras: { front_door: { place: "entrance", kind: "outdoor" }, yard: { place: "outdoor", kind: "outdoor" } },
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    groups: {
      door: { main: "front_door", members: { yard: { zones: ["path"] }, garage: {} } },
      again: { main: "front_door", members: { front_door: {} } },
      yard: { main: "garage" },
    },
  });
  assert.ok(!v.ok);
  assert.deepEqual(v.errors, [
    'groups.door.members.yard.zones: zone "path" is not defined on the camera',
    'groups.door.members.garage: camera "garage" does not exist',
    'groups.again.main: camera "front_door" is already the main camera of group "door"',
    "groups.again.members.front_door: the main camera is not a member too",
    'groups.yard: "yard" is already a camera\'s name',
    'groups.yard.main: camera "garage" does not exist',
  ]);
});
