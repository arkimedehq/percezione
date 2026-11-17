import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRules, cameraAttributes, loadActivitiesSeed } from "../src/config.ts";

const cfg = loadActivitiesSeed();
const none = Object.fromEntries(Object.keys(cfg.attributes).map((k) => [k, false]));
const check = (rules: Parameters<typeof applyRules>[1], cases: [Record<string, boolean>, string][]) => {
  for (const [attrs, expected] of cases) {
    assert.equal(applyRules({ ...none, person_visible: true, ...attrs }, rules), expected, JSON.stringify(attrs));
  }
};

test("seed rules for indoor cameras / regole iniziali delle camere interne", () => {
  check(cfg.rules.indoor, [
    [{ hands_on_keyboard_or_mouse: true, facing_monitor: true }, "at_computer"],
    [{ facing_monitor: true }, "at_computer"],
    // a phone held while typing without looking at it: still at the computer
    [{ phone_in_hand: true, hands_on_keyboard_or_mouse: true }, "at_computer"],
    [{ phone_in_hand: true, looking_at_phone: true, hands_on_keyboard_or_mouse: true }, "using_phone"],
    [{ phone_at_ear: true, facing_monitor: true }, "on_phone_call"],
    [{ facing_tv: true }, "watching_tv"],
    // on the sofa with the phone: the phone counts, not the TV
    [{ facing_tv: true, phone_in_hand: true, looking_at_phone: true }, "using_phone"],
    [{ lying_down: true, facing_tv: true }, "watching_tv"],
    [{ lying_down: true }, "resting"],
    [{ lying_down: true, eyes_closed: true, facing_tv: true }, "sleeping"],
    [{ reading_paper: true, facing_tv: true }, "reading"],
    [{ at_table_with_food: true }, "eating"],
    [{ at_stove: true }, "cooking"],
    [{ playing_games: true }, "playing"],
    [{ person_visible: false, facing_tv: true }, "uncertain"],
    [{}, "other"],
  ]);
});

test("seed rules for outdoor cameras / regole iniziali delle camere esterne", () => {
  check(cfg.rules.outdoor, [
    [{ near_car: true }, "at_car"],
    [{ near_car: true, phone_at_ear: true }, "on_phone_call"],
    [{ phone_in_hand: true, looking_at_phone: true }, "using_phone"],
    // a phone in hand without looking at it (e.g. while walking): not "using_phone"
    [{ phone_in_hand: true }, "other"],
    [{ person_visible: false }, "uncertain"],
  ]);
  // only the questions needed outdoors go to the VLM
  assert.deepEqual(Object.keys(cameraAttributes(cfg.attributes, cfg.rules.outdoor)).sort(), [
    "looking_at_phone",
    "near_car",
    "person_visible",
    "phone_at_ear",
    "phone_in_hand",
  ]);
  assert.deepEqual(cameraAttributes(cfg.attributes, undefined), {});
});

test("every seed label is in the vocabulary / ogni etichetta del seme è nel vocabolario", () => {
  for (const r of Object.values(cfg.rules)) {
    for (const label of [r.default, ...r.rules.map((x) => x.then)]) assert.ok(label in cfg.vocabulary, label);
    for (const a of r.rules.flatMap((x) => Object.keys(x.if))) assert.ok(a in cfg.attributes, a);
  }
});
