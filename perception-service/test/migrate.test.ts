import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describe } from "../src/events.ts";
import { migrateConfig, migrateEvent, migrateTimeline } from "../src/migrate.ts";
import { validate } from "../src/settings.ts";

const legacyConfig = {
  version: 7,
  cameras: {
    garden: {
      place: "esterno",
      kind: "esterno",
      zones: { entrance: [[0, 0], [1, 0], [1, 1]] },
      observe: { presenza: {}, passaggi: { group: "street", merge_s: 15 }, avvicinamento: { zone: "entrance" } },
    },
    living_room: {
      place: "living_room",
      kind: "interno",
      observe: { attivita: { rules: [{ if: { visible: false }, then: "incerto" }], default: "altro" } },
    },
  },
  analyzers: { vlm: { model: "m", vocabulary: { altro: "…", incerto: "…", cammina: "…" }, attributes: { visible: "…" } } },
  rules: [
    { id: "night", name: "Night", when: { event: ["avvicinamento", "passaggio"], persona: "sconosciuto" }, then: [{ react: "notifica", to: "family", importance: "alta" }, { react: "memoria" }] },
    { id: "fall", name: "Fall", when: { event: "postura_changed", value: "a_terra" }, then: [{ react: "annuncio" }] },
  ],
};

test("an Italian configuration becomes English and valid / una configurazione italiana diventa inglese e valida", () => {
  const v = validate(legacyConfig);
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  const c = v.config;
  assert.equal(c.cameras.garden!.kind, "outdoor");
  assert.equal(c.cameras.garden!.place, "outdoor");
  assert.deepEqual(Object.keys(c.cameras.garden!.observe).sort(), ["approach", "passages", "presence"]);
  assert.equal(c.cameras.living_room!.observe.activity!.rules[0]!.then, "uncertain");
  assert.deepEqual(Object.keys(c.analyzers.vlm.vocabulary).sort(), ["altro", "uncertain", "walking"]);
  assert.deepEqual(c.rules[0]!.when, { event: ["approach", "passage"], person: "unknown" });
  assert.deepEqual(c.rules[0]!.then.map((t) => [t.react, t.importance]), [["notify", "high"], ["memory", undefined]]);
  assert.deepEqual(c.rules[1]!.when, { event: "posture_changed", value: "on_floor" });
  // idempotent: English passes through unchanged
  assert.deepEqual(migrateConfig(migrateConfig(legacyConfig)), migrateConfig(legacyConfig));
});

const legacyEvent = {
  event_id: "e1",
  schema_version: 2,
  ts: "2026-11-11T10:00:00Z",
  type: "abbandono",
  camera: "garden",
  place: "esterno",
  persona: { nome: "Alice", confidenza: 0.9, fonte: "volto" },
  valore: { da: null, a: "pacco" },
  zona: "entrance",
  oggetto: { score: 0.8, rise: 0.3, box: [1, 2, 3, 4], passaggi: 1, immagini: { prima: "b.jpg", dopo: "a.jpg" } },
  media: { frigate_ids: [] },
  testo: "Oggetto lasciato in entrance: pacco",
  reazioni: [{ react: "notifica", to: "family", rules: ["r"] }],
  importanza: "alta",
};

test("a v2 event becomes v3 with an English text / un evento v2 diventa v3 con il testo in inglese", () => {
  const e = migrateEvent(legacyEvent, (x) => describe(x as never)) as Record<string, unknown>;
  assert.deepEqual(e, {
    event_id: "e1",
    schema_version: 3,
    ts: "2026-11-11T10:00:00Z",
    type: "object_left",
    camera: "garden",
    place: "outdoor",
    person: { name: "Alice", confidence: 0.9, source: "face" },
    value: { from: null, to: "parcel" },
    zone: "entrance",
    object: { score: 0.8, rise: 0.3, box: [1, 2, 3, 4], passersby: 1, images: { before: "b.jpg", after: "a.jpg" } },
    media: { frigate_ids: [] },
    reactions: [{ react: "notify", to: "family", rules: ["r"] }],
    importance: "high",
    text: "Object left in entrance: parcel, after Alice passed by",
  });
  assert.equal(migrateEvent(e, () => "x"), e, "v3 passes through");
});

test("the timeline is converted once, the old file kept / la cronologia si converte una volta, il file vecchio resta", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "timeline.jsonl");
  const lines = [JSON.stringify({ schema_version: 1, type: "arrived" }), JSON.stringify(legacyEvent), "{cut"];
  writeFileSync(path, lines.join("\n") + "\n");
  const describeAny = (x: Record<string, unknown>) => describe(x as never);
  assert.equal(migrateTimeline(path, describeAny), 1);
  const out = readFileSync(path, "utf8").split("\n");
  assert.equal(out[0], lines[0], "v1 untouched");
  assert.equal(JSON.parse(out[1]!).type, "object_left");
  assert.equal(out[2], "{cut", "a cut line stays as it was");
  assert.equal(readFileSync(`${path}.before-v3`, "utf8"), lines.join("\n") + "\n");
  assert.equal(migrateTimeline(path, describeAny), 0, "nothing left to convert");
});
