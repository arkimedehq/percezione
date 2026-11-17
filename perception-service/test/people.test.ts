import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import sharp from "sharp";
import { activeObjects, parseEvent } from "../src/frigate.ts";
import { FrigateFaces, groupAttempts, isInfrared, parseAttempt, personId } from "../src/people.ts";

/** A small JPEG: grey as a camera's infrared at night, or in colour. */
const picture = (night: boolean) =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: night ? { r: 120, g: 120, b: 120 } : { r: 200, g: 150, b: 90 } } }).jpeg().toBuffer();

/** A Frigate with a face library in memory, answering like 0.18 does. */
async function fakeFrigate(t: { after(fn: () => void): void }) {
  const lib: Record<string, string[]> = { Alice: ["Alice_1.webp", "Alice_2.webp"], Bob: ["Bob_1.webp"], train: ["x-1.0-unknown-0.5.webp"] };
  const calls: string[] = [];
  /** attempt images served under /clips/faces/train/ */
  const images: Record<string, Buffer> = {};
  const read = (req: IncomingMessage) => new Promise<string>((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url ?? "");
    const body = await read(req);
    calls.push(`${req.method} ${url}`);
    const send = (status: number, data: unknown) => (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(data)));
    let m: RegExpMatchArray | null;
    if (url.startsWith("/api/faces?") || url === "/api/faces") return send(200, lib);
    if ((m = url.match(/^\/clips\/faces\/[^/]+\/(.+)$/)) && images[m[1]!]) return (res.writeHead(200, { "Content-Type": "image/jpeg" }), res.end(images[m[1]!]));
    if ((m = url.match(/^\/api\/faces\/([^/]+)\/create$/))) return ((lib[m[1]!] ??= []), send(200, { success: false, message: "Successfully created face folder." }));
    if ((m = url.match(/^\/api\/faces\/([^/]+)\/delete$/))) {
      const ids = (JSON.parse(body) as { ids: string[] }).ids;
      lib[m[1]!] = (lib[m[1]!] ?? []).filter((f) => !ids.includes(f));
      if (!lib[m[1]!]!.length) delete lib[m[1]!];
      return send(200, { success: true });
    }
    if ((m = url.match(/^\/api\/faces\/([^/]+)\/reclassify$/))) {
      const { id, new_name } = JSON.parse(body) as { id: string; new_name: string };
      lib[m[1]!] = lib[m[1]!]!.filter((f) => f !== id);
      (lib[new_name] ??= []).push(id);
      return send(200, { success: true });
    }
    if ((m = url.match(/^\/api\/faces\/train\/([^/]+)\/classify$/))) {
      const { training_file } = JSON.parse(body) as { training_file: string };
      lib.train = lib.train!.filter((f) => f !== training_file);
      (lib[m[1]!] ??= []).push(`${m[1]}-new.webp`);
      return send(200, { success: true });
    }
    if ((m = url.match(/^\/api\/faces\/([^/]+)\/rename$/))) {
      const { new_name } = JSON.parse(body) as { new_name: string };
      lib[new_name] = lib[m[1]!]!;
      delete lib[m[1]!];
      return send(200, { success: true });
    }
    if ((m = url.match(/^\/api\/faces\/([^/]+)\/register$/))) {
      if (!body.includes('name="file"')) return send(422, { detail: "file missing" });
      if (body.includes("no-face")) return send(400, { success: false, message: "No face was detected." });
      if (body.includes("no-face")) return send(400, { success: false, message: "No face was detected." });
      (lib[m[1]!] ??= []).push(`${m[1]}_new.webp`);
      return send(200, { success: true });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { faces: new FrigateFaces(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), lib, calls, images };
}

test("names Frigate accepts as a person / i nomi che Frigate accetta per una persona", () => {
  assert.equal(personId(" Zoë  Rossi "), "Zoë_Rossi");
  assert.equal(personId("O'Brien-2"), "O'Brien-2");
  assert.equal(personId("train"), null, "train is Frigate's attempts folder");
  assert.equal(personId("Unknown"), null, "Frigate's label for no name");
  assert.equal(personId("a/b"), null);
  assert.equal(personId(""), null);
  assert.equal(personId("x".repeat(51)), null);
});

test("the library without the attempts, newest faces first / la libreria senza i tentativi, volti più recenti prima", async (t) => {
  const { faces } = await fakeFrigate(t);
  assert.deepEqual(await faces.list(), [
    { id: "Alice", faces: ["Alice_2.webp", "Alice_1.webp"] },
    { id: "Bob", faces: ["Bob_1.webp"] },
  ]);
});

test("merge: every face moves and the old folder disappears / unione: tutti i volti si spostano e la vecchia cartella sparisce", async (t) => {
  const { faces, lib } = await fakeFrigate(t);
  assert.equal(await faces.merge("Bob", "Alice"), 1);
  assert.deepEqual(lib.Alice, ["Alice_1.webp", "Alice_2.webp", "Bob_1.webp"]);
  assert.equal(lib.Bob, undefined);
  // into someone new: created first
  assert.equal(await faces.merge("Alice", "Carol"), 3);
  assert.deepEqual(Object.keys(lib).sort(), ["Carol", "train"]);
});

test("upload, remove, rename / caricamento, rimozione, rinomina", async (t) => {
  const { faces, lib } = await fakeFrigate(t);
  await faces.upload("Bob", new Blob(["jpeg"]), "a.jpg");
  assert.deepEqual(lib.Bob, ["Bob_1.webp", "Bob_new.webp"]);
  await assert.rejects(faces.upload("Bob", new Blob(["no-face"])), /No face was detected/);
  await faces.remove("Bob");
  assert.equal(lib.Bob, undefined);
  await faces.rename("Alice", "Alice_Smith");
  assert.ok(lib.Alice_Smith && !lib.Alice);
});

test("attempts by passage: Frigate's file names, best guess, already recognized / tentativi per passaggio: nomi dei file di Frigate, ipotesi migliore, già riconosciuti", () => {
  assert.deepEqual(parseAttempt("1794418015.261448-dx3ijd-1794418030.413742-unknown-0.webp"), {
    file: "1794418015.261448-dx3ijd-1794418030.413742-unknown-0.webp",
    event: "1794418015.261448-dx3ijd",
    ts: 1794418030.413742,
    name: null,
    score: 0,
  });
  assert.equal(parseAttempt("1794418015.42-ab1-1794418073.86-Alice_Smith-0.93.webp")?.name, "Alice_Smith");
  assert.equal(parseAttempt("Alice_1.webp"), null);
  const files = [
    "1.1-aaa-10.0-unknown-0.4.webp",
    "1.1-aaa-11.0-Bob-0.62.webp",
    "2.2-bbb-20.0-Alice-0.95.webp",
    "2.2-bbb-21.0-Alice-0.91.webp",
    "3.3-ccc-5.0-unknown-0.1.webp",
  ];
  const groups = groupAttempts(files.map((f) => parseAttempt(f)!), (e) => (e === "1.1-aaa" ? { camera: "front_door", place: "entrance" } : undefined));
  assert.deepEqual(groups.map((g) => [g.event, g.recognized, g.best?.name ?? null, g.attempts.length]), [
    ["2.2-bbb", true, "Alice", 2],
    ["1.1-aaa", false, "Bob", 2],
    ["3.3-ccc", false, null, 1],
  ]);
  assert.equal(groups[1]!.camera, "front_door");
  assert.equal(groups[1]!.attempts[0]!.file, "1.1-aaa-11.0-Bob-0.62.webp", "best score first");
  assert.equal(groups[1]!.ts, new Date(11_000).toISOString());
});

test("naming attempts makes them faces, discarding removes them / nominare i tentativi li rende volti, scartarli li toglie", async (t) => {
  const { faces, lib } = await fakeFrigate(t);
  lib.train = ["1.1-aaa-10.0-unknown-0.4.webp", "1.1-aaa-11.0-unknown-0.5.webp", "2.2-bbb-20.0-unknown-0.2.webp"];
  assert.equal((await faces.attempts()).length, 3);
  await faces.assign(["1.1-aaa-10.0-unknown-0.4.webp", "1.1-aaa-11.0-unknown-0.5.webp"], "Dave");
  assert.deepEqual(lib.Dave, ["Dave-new.webp", "Dave-new.webp"]);
  await faces.discard(["2.2-bbb-20.0-unknown-0.2.webp"]);
  assert.equal(lib.train?.length ?? 0, 0);
});

test("the camera of each track, kept a week across restarts / la camera di ogni traccia, tenuta una settimana anche dopo un riavvio", async (t) => {
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { TrackLog } = await import("../src/track-log.ts");
  const dir = mkdtempSync(join(tmpdir(), "tracks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tracks.jsonl");
  const now = 1_800_000_000_000;
  const log = new TrackLog(path, 7 * 86_400_000, now);
  log.saw("1.1-old", "attic", now / 1000 - 8 * 86_400);
  log.saw("2.2-new", "front_door", now / 1000 - 3600);
  log.saw("2.2-new", "front_door", now / 1000 - 3600);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2, "written once per track");
  const again = new TrackLog(path, 7 * 86_400_000, now);
  assert.equal(again.camera("2.2-new"), "front_door");
  assert.equal(again.camera("1.1-old"), undefined, "older than a week");
});

test("night faces: their own folder, one person everywhere / volti notturni: una cartella a parte, una persona sola ovunque", async (t) => {
  assert.equal(await isInfrared(await picture(true)), true);
  assert.equal(await isInfrared(await picture(false)), false);
  assert.equal(personId("Alice~ir"), null, "the suffix cannot be a person's name");

  const { faces, lib, images } = await fakeFrigate(t);
  lib["Alice~ir"] = ["Alice~ir_1.webp"];
  assert.deepEqual(await faces.list(), [
    { id: "Alice", faces: ["Alice_2.webp", "Alice_1.webp", "~ir/Alice~ir_1.webp"] },
    { id: "Bob", faces: ["Bob_1.webp"] },
  ]);
  // an infrared photo goes to the night folder, a colour one to the day folder
  assert.equal(await faces.upload("Bob", new Blob([await picture(true)]), "night.jpg"), true);
  assert.equal(await faces.upload("Bob", new Blob([await picture(false)]), "day.jpg"), false);
  assert.deepEqual([lib.Bob, lib["Bob~ir"]], [["Bob_1.webp", "Bob_new.webp"], ["Bob~ir_new.webp"]]);
  // naming attempts from the cameras: the infrared one is a night face
  lib.train = ["1.1-aaa-10.0-unknown-0.4.webp", "1.1-aaa-11.0-Alice~ir-0.6.webp"];
  images["1.1-aaa-10.0-unknown-0.4.webp"] = await picture(false);
  images["1.1-aaa-11.0-Alice~ir-0.6.webp"] = await picture(true);
  assert.equal((await faces.attempts())[1]!.name, "Alice", "a guess of the night folder is the person");
  assert.equal(await faces.assign(lib.train, "Dave"), 1);
  assert.deepEqual([lib.Dave, lib["Dave~ir"]], [["Dave-new.webp"], ["Dave~ir-new.webp"]]);
  // a night face to someone else lands in their night folder; rename and remove take both folders
  await faces.move("Alice", "~ir/Alice~ir_1.webp", "Bob");
  assert.deepEqual([lib["Alice~ir"]?.length ?? 0, lib["Bob~ir"]], [0, ["Bob~ir_new.webp", "Alice~ir_1.webp"]]);
  await faces.rename("Bob", "Robert");
  assert.deepEqual([lib.Bob, lib["Bob~ir"], lib.Robert?.length, lib["Robert~ir"]?.length], [undefined, undefined, 2, 2]);
  await faces.merge("Dave", "Robert");
  assert.deepEqual([lib.Dave, lib["Dave~ir"], lib.Robert?.length, lib["Robert~ir"]?.length], [undefined, undefined, 3, 3]);
  await faces.remove("Robert");
  assert.deepEqual((await faces.list()).map((p) => p.id), ["Alice"]);
});

test("names from Frigate: a night folder's match is the person / i nomi da Frigate: chi corrisponde nella cartella notturna è la persona", () => {
  const ev = parseEvent(Buffer.from(JSON.stringify({ type: "update", after: { id: "1.1-aaa", camera: "front_door", label: "person", sub_label: ["Alice~ir", 0.88] } })));
  assert.deepEqual(ev?.after.sub_label, ["Alice", 0.88]);
  const objs = activeObjects(JSON.stringify({ front_door: { objects: [{ id: "1.1-aaa", label: "person-verified", sub_label: "Alice~ir" }] } }));
  assert.equal(objs[0]!.sub_label, "Alice");
});
