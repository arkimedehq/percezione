import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "../src/events.ts";
import { evaluateRules, inHours } from "../src/rules.ts";
import type { Rule } from "../src/settings.ts";

const at = (hm: string) => new Date(`2026-11-07T${hm}:00`); // local time

function obs(o: Partial<Observation> = {}): Observation & { place: string } {
  return {
    event_id: "e",
    ts: "2026-11-07T12:00:00Z",
    type: "approach",
    camera: "front_right",
    person: null,
    zone: "entrance",
    media: { frigate_ids: [] },
    place: "outdoor",
    ...o,
  };
}

function rule(id: string, when: Rule["when"], then: Rule["then"], enabled = true): Rule {
  return { id, name: id, enabled, when, then };
}

test("time range across midnight, end excluded / fascia oraria a cavallo della mezzanotte, estremo finale escluso", () => {
  assert.equal(inHours("23:00-06:00", at("23:30")), true);
  assert.equal(inHours("23:00-06:00", at("05:59")), true);
  assert.equal(inHours("23:00-06:00", at("06:00")), false);
  assert.equal(inHours("23:00-06:00", at("12:00")), false);
  assert.equal(inHours("08:00-20:00", at("12:00")), true);
});

test("filters on event, camera, person, zone, value and duration / filtri su evento, camera, persona, zona, valore e durata", () => {
  const ok = (when: Rule["when"], o = obs(), now = at("12:00")) =>
    evaluateRules(o, [rule("r", when, [{ react: "memory" }])], now).reactions.length === 1;
  assert.equal(ok({ event: "approach" }), true);
  assert.equal(ok({ event: ["passage", "arrived"] }), false);
  assert.equal(ok({ cameras: ["front_left"] }), false);
  assert.equal(ok({ cameras: ["front_left"] }, obs({ type: "passage", cameras: ["front_right", "front_left"] })), true);
  assert.equal(ok({ places: ["outdoor"] }), true);
  assert.equal(ok({ person: "unknown" }), true);
  assert.equal(ok({ person: "known" }), false);
  assert.equal(ok({ person: ["alice", "Carol"] }, obs({ person: { name: "Alice", confidence: 0.9, source: "face" } })), true);
  assert.equal(ok({ person: "anyone" }), true);
  assert.equal(ok({ zone: "gate" }), false);
  assert.equal(ok({ value: "sleeping" }, obs({ type: "activity_changed", value: { from: "resting", to: "sleeping" } })), true);
  assert.equal(ok({ value: "sleeping" }, obs({ type: "left", activity: "sleeping" })), true);
  assert.equal(ok({ value: "sleeping" }, obs()), false);
  assert.equal(ok({ for_s: 10 }, obs({ type: "passage", duration_s: 12 })), true);
  assert.equal(ok({ for_s: 10 }, obs({ type: "passage", duration_s: 4 })), false);
  assert.equal(ok({ hours: "23:00-06:00" }, obs(), at("02:10")), true);
});

test("all rules evaluated; equal reactions merged; event importance / tutte le regole valutate; reazioni uguali fuse; importanza dell'evento", () => {
  const rules = [
    rule("night-entrance", { event: "approach", hours: "23:00-06:00" }, [
      { react: "notify", to: "family", snapshot: true },
      { react: "memory" },
    ]),
    rule("strangers", { person: "unknown" }, [{ react: "notify", to: "family", urgent: true }, { react: "memory", importance: "low" }]),
    rule("disabled", {}, [{ react: "announce" }], false),
  ];
  const night = evaluateRules(obs(), rules, at("01:00"));
  assert.deepEqual(night.reactions, [
    { react: "notify", to: "family", snapshot: true, urgent: true, rules: ["night-entrance", "strangers"] },
    { react: "memory", importance: "normal", rules: ["night-entrance", "strangers"] },
  ]);
  assert.equal(night.importance, "high");

  const day = evaluateRules(obs({ person: { name: "Alice", confidence: 0.9, source: "face" } }), rules, at("12:00"));
  assert.deepEqual(day, { reactions: [], importance: "normal" });
});

test("unspecified importance counts as normal whatever the rule order / importanza non indicata vale normale in qualunque ordine", () => {
  const street = rule("street", { event: "passage" }, [{ react: "memory", importance: "low" }]);
  const unknown = rule("strangers-street", { event: "passage", person: "unknown" }, [{ react: "memory" }]);
  const pass = obs({ type: "passage", zone: undefined });
  for (const rules of [[street, unknown], [unknown, street]]) {
    const r = evaluateRules(pass, rules, at("12:00"));
    assert.equal(r.importance, "normal");
    assert.equal(r.reactions.length, 1);
  }
  // a recognized neighbour stays low
  const known = evaluateRules(obs({ type: "passage", person: { name: "Alice", confidence: 0.9, source: "face" } }), [street, unknown], at("12:00"));
  assert.equal(known.importance, "low");
});
