import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, type Observation, type PerceptionEvent } from "../src/events.ts";
import { toItem } from "../src/publish.ts";

const base = { event_id: "x", ts: "2026-10-30T16:00:00Z", media: { frigate_ids: [] } };
const alice = { name: "Alice", confidence: 0.9, source: "face" as const };

test("event sentences / frasi degli eventi", () => {
  const cases: [Partial<Observation>, string, string][] = [
    [{ type: "arrived", person: alice, camera: "living_room" }, "living_room", "Alice arrived in living room"],
    [{ type: "left", person: alice, camera: "attic" }, "attic", "Alice left attic"],
    [
      { type: "activity_changed", person: { ...alice, name: "Carol" }, camera: "living_room", value: { from: "resting", to: "watching_tv" } },
      "living_room",
      "Carol in living room: watching tv",
    ],
    [{ type: "approach", person: null, camera: "front_left", zone: "entrance" }, "outdoor", "Unknown person at the entrance"],
    [
      { type: "passage", person: null, camera: "front_left", cameras: ["front_left", "front_right"], duration_s: 46, approached: true },
      "outdoor",
      "Unknown person passed by (front left and front right, 46 s, came close)",
    ],
    [{ type: "passage", person: alice, camera: "front_right", duration_s: 12, approached: false }, "outdoor", "Alice passed by (front right, 12 s)"],
  ];
  for (const [o, place, text] of cases) assert.equal(describe({ ...base, ...o } as Observation, place), text);
});

test("card items carry the fields to translate the sentence / le voci della card portano i campi per tradurre la frase", () => {
  const e = {
    ...base,
    schema_version: 3,
    type: "passage",
    camera: "front",
    cameras: ["front", "side"],
    place: "outdoor",
    person: null,
    duration_s: 46,
    approached: true,
    text: "Unknown person passed by (front and side, 46 s, came close)",
    reactions: [{ react: "memory", rules: ["street"] }],
    importance: "low",
  } as PerceptionEvent;
  const item = JSON.parse(JSON.stringify(toItem(e)));
  assert.deepEqual(item, {
    ts: base.ts,
    type: "passage",
    person: null,
    camera: "front",
    cameras: ["front", "side"],
    place: "outdoor",
    duration_s: 46,
    approached: true,
    importance: "low",
    text: "Unknown person passed by (front and side, 46 s, came close)",
  });
});
