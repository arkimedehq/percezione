import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityStateMachine } from "../src/activity.ts";

const params = { stableMs: 40_000, minConf: 0.6, minSamples: 3, enterRatio: 0.66 };
const S = 10_000;

function feed(sm: ActivityStateMachine, labels: string[], start = 0, conf = 0.9) {
  return labels.map((label, i) => sm.push({ label, conf, ts: start + i * S })).filter((t) => t !== null);
}

test("enters an activity only after minSamples agreeing samples / entra in un'attività solo dopo minSamples campioni concordi", () => {
  const sm = new ActivityStateMachine(params);
  const out = feed(sm, ["at_computer", "at_computer", "at_computer"]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { from: null, to: "at_computer", firstSampleTs: 0 });
});

test("a single different sample causes no oscillation / un campione isolato diverso non provoca oscillazioni", () => {
  const sm = new ActivityStateMachine(params);
  const out = feed(sm, ["at_computer", "at_computer", "at_computer", "using_phone", "at_computer", "using_phone", "at_computer"]);
  assert.equal(out.length, 1);
});

test("a real change produces a single activity_changed / un cambio reale produce un solo activity_changed", () => {
  const sm = new ActivityStateMachine(params);
  const out = feed(sm, ["at_computer", "at_computer", "at_computer", "using_phone", "using_phone", "using_phone", "using_phone", "using_phone"]);
  assert.equal(out.length, 2);
  assert.equal(out[1]!.from, "at_computer");
  assert.equal(out[1]!.to, "using_phone");
});

test("uncertain and low confidence do not count / incerto e confidenza bassa non contano", () => {
  const sm = new ActivityStateMachine(params);
  feed(sm, ["at_computer", "at_computer", "at_computer"]);
  const out = [
    ...feed(sm, ["uncertain", "uncertain", "uncertain", "uncertain"], 3 * S),
    ...feed(sm, ["using_phone", "using_phone", "using_phone"], 7 * S, 0.3),
  ];
  assert.equal(out.length, 0);
  assert.equal(sm.current, "at_computer");
});

test("hysteresis: with votes split in half the current activity stays / isteresi: con voti divisi a metà resta l'attività corrente", () => {
  const sm = new ActivityStateMachine(params);
  feed(sm, ["at_computer", "at_computer", "at_computer"]);
  const out = feed(sm, ["using_phone", "at_computer", "using_phone", "at_computer", "using_phone", "at_computer"], 3 * S);
  assert.equal(out.length, 0);
});
