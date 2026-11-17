import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { compare, LeftObjects, pickObject, zonePrint, type Box } from "../src/left-objects.ts";
import { describe as describeEvent, type Observation } from "../src/events.ts";
import type { FrigateEvent } from "../src/frigate.ts";
import { validate } from "../src/settings.ts";

const W = 640;
const H = 360;
// sidewalk: the bottom half of the frame
const zone: [number, number][] = [[0, 0.5], [1, 0.5], [1, 1], [0, 1]];

/** Grey frame with brightness `light`, optionally with a dark "bag" in the zone. */
function frame(light: number, bag?: { x: number; y: number; size: number }): Promise<Buffer> {
  const img = sharp({ create: { width: W, height: H, channels: 3, background: { r: light, g: light, b: light } } });
  if (!bag) return img.jpeg().toBuffer();
  const square = { input: { create: { width: bag.size, height: bag.size, channels: 3 as const, background: { r: 20, g: 20, b: 25 } } }, left: bag.x, top: bag.y };
  return img.composite([square]).jpeg().toBuffer();
}

test("print: uniform lighting is not a change, an object is / impronta: la luce uniforme non è un cambiamento, un oggetto sì", async () => {
  const base = await zonePrint(await frame(150), zone);
  assert.equal(compare(base, await zonePrint(await frame(185), zone)).changed.length, 0);
  const d = compare(base, await zonePrint(await frame(150, { x: 300, y: 250, size: 50 }), zone));
  assert.ok(d.changed.length >= 2, `changed cells: ${d.changed.length}`);
  assert.ok(d.fraction < 0.05);
  // outside the zone does not count
  assert.equal(compare(base, await zonePrint(await frame(150, { x: 300, y: 40, size: 50 }), zone)).changed.length, 0);
});

// CLIP probabilities for the "before" and "after" crops
type Scores = Record<string, number>;
const BAG: [Scores, Scores] = [{ trash: 0.1, parcel: 0.3, nothing: 0.6 }, { trash: 0.8, parcel: 0.1, nothing: 0.1 }];

function setup(scene: { current: Promise<Buffer> }, [before, after]: [Scores, Scores] = BAG) {
  let now = 1_000_000;
  const events: Observation[] = [];
  const classified: Box[] = [];
  const saved: string[] = [];
  const lo = new LeftObjects({
    now: () => now,
    frame: () => scene.current,
    // classify is called for the before crop first, then the after crop
    classify: async (_c, _f, box) => (classified.push(box), classified.length % 2 ? before : after),
    save: async (name) => (saved.push(name), name),
    emit: (e) => events.push(e),
  });
  lo.configure([{ camera: "front_left", zone: "sidewalk", polygon: zone, checkMs: 20_000, persistMs: 60_000, minScore: 0.5, minCells: 2 }]);
  const advance = async (ms: number) => {
    for (let t = 0; t < ms; t += 5_000) {
      now += 5_000;
      await lo.tick();
    }
  };
  const person = (type: FrigateEvent["type"], name: string | null = null) =>
    lo.handleEvent({
      type,
      after: {
        id: "p1",
        camera: "front_left",
        label: "person",
        sub_label: name ? [name, 0.91] : null,
        frame_time: now / 1000,
        start_time: now / 1000,
        end_time: type === "end" ? now / 1000 : null,
        stationary: false,
        false_positive: false,
        box: [0, 0, 10, 10],
      },
    });
  return { events, classified, saved, advance, person, lo };
}

test("a bag left by a passer-by: one event, with the person and the photos / sacco lasciato da chi passa: un solo evento, con persona e foto", async () => {
  const scene = { current: frame(150) };
  const s = setup(scene);
  await s.advance(60_000); // reference of the empty zone
  s.person("new", "Alice");
  scene.current = frame(150, { x: 300, y: 250, size: 50 });
  await s.advance(10_000);
  assert.equal(s.lo.quiet("front_left"), false, "with a person just seen the zone is not compared");
  s.person("end", "Alice");
  await s.advance(40_000);
  assert.equal(s.classified.length, 0, "not yet: the change must persist");
  await s.advance(90_000);
  assert.equal(s.events.length, 1);
  const e = s.events[0]!;
  assert.equal(e.type, "object_left");
  assert.deepEqual(e.value, { from: null, to: "trash" });
  assert.equal(e.person?.name, "Alice");
  assert.deepEqual(e.media.frigate_ids, ["p1"]);
  assert.equal(s.saved.length, 2);
  const [x1, y1, x2, y2] = s.classified[0]!;
  assert.ok(x1 <= 300 && x2 >= 350 && y1 <= 250 && y2 >= 300, `box ${s.classified[0]}`);
  assert.equal(describeEvent(e, "outdoor"), "Object left in sidewalk: trash, after Alice passed by");
  // the bag is the new reference: no second event
  await s.advance(300_000);
  assert.equal(s.events.length, 1);
});

test("changes that are not objects: lighting, a moving scene, CLIP saying nothing / cambiamenti che non sono oggetti: luce, scena che si muove, CLIP dice niente", async () => {
  const scene = { current: frame(150) };
  const s = setup(scene, [{ nothing: 0.9 }, { nothing: 0.9 }]);
  await s.advance(60_000);
  scene.current = frame(90); // cloud
  await s.advance(200_000);
  assert.equal(s.classified.length, 0);
  // something that moves at every check (leaves, a turning shadow) never settles
  for (const x of [100, 200, 300, 400, 500]) {
    scene.current = frame(90, { x, y: 250, size: 50 });
    await s.advance(20_000);
  }
  assert.equal(s.classified.length, 0);
  // still: it gets classified, but "nothing" is not an event
  await s.advance(120_000);
  assert.equal(s.classified.length, 2);
  assert.equal(s.events.length, 0);
});

test("only the rise from before to after counts / conta solo quanto sale da prima a dopo", () => {
  // a wall that CLIP calls a parcel both before and after: no object
  assert.equal(pickObject({ parcel: 0.7, nothing: 0.2 }, { parcel: 0.72, nothing: 0.2 }).rise < 0.25, true);
  assert.deepEqual(pickObject({ parcel: 0.4, trash: 0.1 }, { parcel: 0.2, trash: 0.7 }), { label: "trash", score: 0.7, rise: 0.6 });
  assert.equal(pickObject({ nothing: 0.2 }, { nothing: 0.9 }).label, "nothing");
});

test("schema: existing zone and analyzer; rules on objects / schema: zona e analizzatore esistenti; regole sugli oggetti", () => {
  const cfg = (left_object: Record<string, unknown>) => ({
    version: 1,
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} }, endpoints: { onnx: { url: "http://127.0.0.1:8100" } } },
    cameras: { front_left: { place: "outdoor", kind: "outdoor", zones: { sidewalk: zone }, observe: { left_object } } },
    rules: [{ id: "trash", name: "Trash", when: { event: "object_left", value: ["trash", "bulky"] }, then: [{ react: "notify", to: "alice", snapshot: true }] }],
  });
  const ok = validate(cfg({ zone: "sidewalk", analyzer: "onnx", model: "clip" }));
  assert.ok(ok.ok, ok.ok ? "" : ok.errors.join());
  assert.equal(ok.ok && ok.config.cameras.front_left!.observe.left_object!.persist_s, 90);
  const bad = validate(cfg({ zone: "bins", analyzer: "gpu", model: "clip" }));
  assert.ok(!bad.ok);
  assert.match(bad.errors.join(), /zone "bins" is not defined/);
  assert.match(bad.errors.join(), /analyzer "gpu" is not defined/);
});
