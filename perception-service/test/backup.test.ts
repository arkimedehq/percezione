import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { makeBackup, readBackup, restoreBackup } from "../src/backup.ts";
import { ConfigStore } from "../src/settings.ts";

const seed = () => ({
  version: 1,
  analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
  cameras: { front_door: { place: "entrance", kind: "outdoor" as const } },
});

/** Frigate's face library in memory: what list/image/create/upload see. */
function fakeFaces(people: Record<string, Record<string, string>>) {
  const uploads: { id: string; name: string; night: boolean | undefined; text: string }[] = [];
  return {
    people,
    uploads,
    list: async () => Object.entries(people).map(([id, faces]) => ({ id, faces: Object.keys(faces) })),
    image: async (id: string, file: string) => (people[id]?.[file] ? new Response(people[id]![file]) : new Response("", { status: 404 })),
    create: async (id: string) => void (people[id] ??= {}),
    upload: async (id: string, image: Blob, name = "photo.jpg", night?: boolean) => {
      const text = await image.text();
      uploads.push({ id, name, night, text });
      (people[id] ??= {})[(night ? "~ir/" : "") + name] = text;
      return !!night;
    },
  };
}

function dataDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "perception-backup-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("backup: configuration, people with day and night faces, tokens; the cameras' passwords only when asked / backup: configurazione, persone con volti di giorno e di notte, token; le password delle camere solo se richieste", async () => {
  const dir = dataDir({ "mcp-clients.json": "{\"tokens\":1}", "secrets/ui.json": "{\"scrypt\":1}", "source-passwords.json": "{\"door\":\"pw\"}", "timeline.jsonl": "{}\n" });
  const store = new ConfigStore(join(dir, "config.json"), seed);
  const faces = fakeFaces({ Alice: { "a1.webp": "day face", "~ir/a2.webp": "night face" } });

  const plain = readBackup(await makeBackup({ config: store.current, dataDir: dir, faces }, false));
  assert.deepEqual(Object.keys(plain.files).sort(), ["mcp-clients.json", "secrets/ui.json"]);
  assert.deepEqual(plain.config.cameras.front_door?.place, "entrance");
  assert.deepEqual(
    plain.people.map((p) => [p.id, p.faces.map((f) => [f.file, Buffer.from(f.data, "base64").toString()])]),
    [["Alice", [["a1.webp", "day face"], ["~ir/a2.webp", "night face"]]]],
  );
  const full = readBackup(await makeBackup({ config: store.current, dataDir: dir, faces }, true));
  assert.equal(full.files["source-passwords.json"], "{\"door\":\"pw\"}");
});

test("restore on an empty installation: everything comes back, night faces to the night folder / ripristino su un'installazione vuota: torna tutto, i volti notturni nella cartella notturna", async () => {
  const from = dataDir({ "mcp-clients.json": "{\"tokens\":1}", "source-passwords.json": "{\"door\":\"pw\"}" });
  const old = new ConfigStore(join(from, "config.json"), seed);
  const backup = readBackup(await makeBackup({ config: old.current, dataDir: from, faces: fakeFaces({ Alice: { "a1.webp": "day", "~ir/a2.webp": "night" } }) }, true));

  const to = dataDir({});
  const store = new ConfigStore(join(to, "config.json"), () => ({ ...seed(), cameras: {} }));
  const faces = fakeFaces({});
  const r = await restoreBackup(backup, { dataDir: to, save: (c) => store.save(c), faces });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config_version, 2);
  assert.ok(store.current.cameras.front_door);
  assert.deepEqual(r.files.sort(), ["mcp-clients.json", "source-passwords.json"]);
  assert.equal(readFileSync(join(to, "source-passwords.json"), "utf8"), "{\"door\":\"pw\"}");
  assert.deepEqual(faces.uploads.map((u) => [u.id, u.name, u.night, u.text]), [
    ["Alice", "a1.webp", false, "day"],
    ["Alice", "a2.webp", true, "night"],
  ]);
  assert.deepEqual(r.people, [{ id: "Alice", added: 2 }]);
});

test("restore: a person who already has faces is kept, a file outside the list is refused / ripristino: chi ha già volti resta com'è, un file fuori elenco è rifiutato", async () => {
  const to = dataDir({});
  const store = new ConfigStore(join(to, "config.json"), seed);
  const faces = fakeFaces({ Alice: { "new.webp": "taken today" } });
  const backup = readBackup(
    gzipSync(
      JSON.stringify({
        format: "percezione-backup",
        version: 1,
        created: "2026-11-12T00:00:00Z",
        config: store.current,
        files: { "../outside.json": "x", "config.json": "{}" },
        people: [{ id: "Alice", faces: [{ file: "old.webp", data: Buffer.from("old").toString("base64") }] }],
      }),
    ),
  );
  const r = await restoreBackup(backup, { dataDir: to, save: (c) => store.save(c), faces });
  assert.deepEqual(r.people, [{ id: "Alice", added: 0, kept: true }]);
  assert.equal(faces.uploads.length, 0);
  assert.equal(r.errors.length, 2);
  assert.ok(!existsSync(join(to, "..", "outside.json")));
  assert.throws(() => readBackup(Buffer.from("plain text")), /not a Percezione backup/);
  assert.throws(() => readBackup(gzipSync(JSON.stringify({ format: "percezione-backup", version: 9 }))), /version 9/);
});

test("restore on a Frigate just started: the first face waits for the face model, a bad face later does not / ripristino su un Frigate appena partito: il primo volto aspetta il modello, un volto cattivo dopo no", async () => {
  const to = dataDir({});
  const store = new ConfigStore(join(to, "config.json"), seed);
  const faces = fakeFaces({});
  let cold = 3;
  const upload = faces.upload;
  faces.upload = async (id, image, name, night) => {
    if (cold-- > 0 || name === "blurry.webp") throw new Error("No face was detected.");
    return upload(id, image, name, night);
  };
  const face = (file: string) => ({ file, data: Buffer.from(file).toString("base64") });
  const backup = { format: "percezione-backup" as const, version: 1 as const, created: "", config: store.current, files: {}, people: [{ id: "Alice", faces: [face("a.webp"), face("blurry.webp"), face("b.webp")] }] };
  const waits: number[] = [];
  const r = await restoreBackup(backup, { dataDir: to, save: (c) => store.save(c), faces, sleep: async (ms) => void waits.push(ms) });
  assert.equal(waits.length, 3, "three waits for the cold start, none for the blurry face");
  assert.deepEqual(r.people, [{ id: "Alice", added: 2 }]);
  assert.deepEqual(r.errors, ["Alice/blurry.webp: No face was detected."]);
});
