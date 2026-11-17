import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { bestFaces, type Shot } from "../src/best-face.ts";
import { CameraBuffer } from "../src/buffer.ts";
import { External, type ExternalResult } from "../src/external.ts";
import type { Observation } from "../src/events.ts";
import { parseAttempt, type Attempt } from "../src/people.ts";
import type { WhoAt } from "../src/who.ts";

const T = 1_794_555_000; // seconds
const attempt = (track: string, at: number, name: string, score: number): Attempt => parseAttempt(`${T - 100}.5-${track}-${T + at}.25-${name}-${score}.webp`)!;

test("best face: per track the biggest and surest, only in the window and in the zones / volto migliore: per traccia il più grande e sicuro, solo nella finestra e nelle zone", async () => {
  const attempts = [
    attempt("aaa111", -8, "unknown", 0.1), // small, far
    attempt("aaa111", -3, "alice", 0.92), // big and sure: the one
    attempt("aaa111", 1, "unknown", 0), // big but blurred
    attempt("bbb222", -2, "unknown", 0.4), // the yard, outside the path
    attempt("ccc333", -2, "bob", 0.9), // the yard, on the path
    attempt("ddd444", -60, "carol", 0.95), // before the window
    attempt("eee555", -1, "dave", 0.95), // a camera not in the group
  ];
  const tracks: Record<string, { camera: string; zones: string[]; name: string | null; confidence: number }> = {
    aaa111: { camera: "front_door", zones: [], name: "Alice", confidence: 0.9 },
    bbb222: { camera: "yard", zones: ["lawn"], name: null, confidence: 0 },
    ccc333: { camera: "yard", zones: ["path"], name: "Bob", confidence: 0.88 },
    ddd444: { camera: "front_door", zones: [], name: "Carol", confidence: 0.9 },
    eee555: { camera: "garage", zones: [], name: "Dave", confidence: 0.9 },
  };
  const sizes: Record<string, number> = { [attempts[0]!.file]: 30, [attempts[1]!.file]: 90, [attempts[2]!.file]: 100, [attempts[4]!.file]: 60 };
  const shots = await bestFaces({ front_door: [], yard: ["path"] }, (T - 10) * 1000, (T + 4) * 1000, {
    attempts: async () => attempts,
    track: (id) => tracks[id.split("-")[1]!], // Frigate's track ids: <start>-<random>
    size: async (file) => (sizes[file] ? { width: sizes[file]!, height: sizes[file]! } : null),
  });
  assert.deepEqual(
    shots.map((s) => [s.track.split("-")[1], s.name, s.attempt.file === attempts[1]!.file || s.attempt.file === attempts[4]!.file]),
    [
      ["aaa111", "Alice", true],
      ["ccc333", "Bob", true],
    ],
  );
});

/** A ffmpeg that never writes: the test writes the pieces itself. */
const idle = () => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => true }) as unknown as ChildProcess;

test("short memory: keeps the last seconds, a held range survives, an instant finds its piece / memoria breve: tiene gli ultimi secondi, un intervallo trattenuto resta, un istante trova il suo pezzo", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "buffer-")), "front_door");
  const b = new CameraBuffer("front_door", "rtsp://x", dir, 10, { spawn: idle });
  b.start();
  const now = T * 1000;
  // pieces of 2 s: each written until the next one opens; the last one still open
  for (let i = 0; i < 12; i++) {
    const end = (T - 24 + 2 * (i + 1)) * 1000;
    const f = join(dir, `${T - 24 + 2 * i}.ts`);
    writeFileSync(f, "x");
    utimesSync(f, end / 1000, end / 1000);
  }
  b.pieces(now - 30_000); // seen before: the first piece starts then
  const release = b.hold(now - 21_000, now - 19_000);
  b.prune(now);
  const kept = readdirSync(dir).map((f) => Number(basename(f, ".ts")) - T).sort((a, z) => a - z);
  // the held piece (−22…−20 s… and its neighbour reaching it) and the last ~10 s
  assert.deepEqual(kept, [-22, -20, -12, -10, -8, -6, -4, -2]);
  const at = b.locate(now - 7_000, now)!;
  assert.equal(basename(at.file), `${T - 8}.ts`);
  assert.equal(at.offset, 1);
  release();
  b.prune(now);
  assert.deepEqual(readdirSync(dir).length, 6);
  b.stop();
  assert.equal(existsSync(dir), false);
});

test("a ring on a group: before and after held, a photo and a face per person, the unknown one too / uno squillo su un gruppo: prima e dopo trattenuti, una foto e un volto per persona, anche per lo sconosciuto", async () => {
  const now = new Date(T * 1000);
  const view: WhoAt = { camera: "front_door", place: "entrance", time: now.toISOString(), people: [{ name: "Alice", confidence: 0.9 }], unrecognized: 1, unknown_faces: [] };
  const shot = (track: string, camera: string, name: string | null, at: number): Shot => ({ track, camera, name, confidence: name ? 0.9 : null, attempt: attempt(track, at, name ?? "unknown", 0.5), area: 900 });
  const holds: [string[], number, number][] = [];
  let released = 0;
  let looks = 0;
  const stills: [string, number][] = [];
  const answers: ExternalResult[] = [];
  const dir = mkdtempSync(join(tmpdir(), "external-"));
  const x = new External({
    dir,
    who: async () => (looks++, view),
    frame: async () => Buffer.from("ring"),
    emit: () => undefined,
    answer: (r) => answers.push(r),
    now: () => now,
    sleep: async () => undefined,
    look: () => ({ cameras: { front_door: [], yard: ["path"] }, before_s: 10, after_s: 4 }),
    hold: (cameras, from, to) => (holds.push([cameras, from, to]), () => void released++),
    shots: async (_c, from, to) => (assert.deepEqual([from, to], [now.getTime() - 10_000, now.getTime()]), [shot("aaa111", "front_door", "Alice", -3), shot("bbb222", "front_door", null, 1), shot("ccc333", "yard", null, -5)]),
    still: async (camera, ts) => (stills.push([camera, ts]), Buffer.from(`frame ${camera}`)),
    face: async (file) => Buffer.from(`face ${file}`),
  });
  const o: Observation = await x.handle({ id: "r1", kind: "ring", camera: "front_door" });
  assert.deepEqual(holds, [[["front_door", "yard"], now.getTime() - 10_000, now.getTime() + 5_000]]);
  assert.equal(released, 1);
  assert.equal(looks, 1 + 4); // the first answer, then one look a second for after_s
  // each person's frame at the instant of their best face
  assert.deepEqual(stills, [["front_door", (T - 3 + 0.25) * 1000], ["front_door", (T + 1 + 0.25) * 1000], ["yard", (T - 5 + 0.25) * 1000]]);
  assert.equal(o.person?.photo, `${o.event_id}-1.jpg`);
  assert.equal(o.person?.face, `${o.event_id}-1-face.jpg`);
  assert.equal(o.image, o.person?.photo);
  // the one without a name on the yard may be anyone passing by: only the main camera's
  assert.deepEqual(o.unknown_people, [{ camera: "front_door", photo: `${o.event_id}-2.jpg`, face: `${o.event_id}-2-face.jpg` }]);
  assert.equal(readFileSync(join(dir, o.image!)).toString(), "frame front_door");
  // the frame of the moment is not written when a face's frame is there
  assert.equal(existsSync(join(dir, `${o.event_id}.jpg`)), false);
  assert.equal(answers.at(-1)?.final, true);
});

test("a ring where Frigate reports nobody in view: the faces it named still count / uno squillo in cui Frigate non segnala nessuno: i volti a cui ha dato un nome contano", async () => {
  const now = new Date(T * 1000);
  const nobody: WhoAt = { camera: "front_door", place: "entrance", time: now.toISOString(), people: [], unrecognized: 0, unknown_faces: [] };
  const shot = (track: string, camera: string, name: string | null): Shot => ({ track, camera, name, confidence: name ? 0.97 : null, attempt: attempt(track, -1, name ?? "unknown", 0.9), area: 900 });
  const answers: ExternalResult[] = [];
  const x = new External({
    dir: mkdtempSync(join(tmpdir(), "external-")),
    who: async () => nobody,
    frame: async () => Buffer.from("ring"),
    emit: () => undefined,
    answer: (r) => answers.push(r),
    now: () => now,
    sleep: async () => undefined,
    look: () => ({ cameras: { front_door: [], yard: ["path"] }, before_s: 10, after_s: 4 }),
    shots: async () => [shot("aaa111", "front_door", "Alice"), shot("bbb222", "yard", "Bob"), shot("ccc333", "front_door", null)],
    still: async (camera) => Buffer.from(`frame ${camera}`),
    face: async (file) => Buffer.from(`face ${file}`),
  });
  const o = await x.handle({ id: "r2", kind: "ring", camera: "front_door" });
  assert.deepEqual(o.people?.map((p) => [p.name, p.confidence, p.seen_by, p.photo]), [
    ["Alice", 0.97, undefined, `${o.event_id}-1.jpg`],
    ["Bob", 0.97, "yard", `${o.event_id}-2.jpg`],
  ]);
  assert.equal(o.unrecognized, 1);
  // the panel: at once nobody, then, after the faces, the same people as the event
  assert.deepEqual(
    answers.map((a) => [a.final, a.people.map((p) => [p.name, p.seen_by]), a.unrecognized]),
    [
      [false, [], 0],
      [true, [["Alice", undefined], ["Bob", "yard"]], 1],
    ],
  );
  assert.equal(answers.at(-1)?.people[1]?.seen_at, new Date((T - 1 + 0.25) * 1000).toISOString());
  // the panel gets the pictures too, the unknown one at the door with them
  assert.deepEqual(answers.at(-1)?.people.map((p) => [p.photo, p.face]), [
    [`${o.event_id}-1.jpg`, `${o.event_id}-1-face.jpg`],
    [`${o.event_id}-2.jpg`, `${o.event_id}-2-face.jpg`],
  ]);
  assert.deepEqual(answers.at(-1)?.unknown_people, [{ camera: "front_door", photo: `${o.event_id}-3.jpg`, face: `${o.event_id}-3-face.jpg` }]);
});

test("who with pictures: each person's best face of the last seconds, files written, nothing held after / chi c'è con le foto: il volto migliore degli ultimi secondi di ognuno, file scritti, nulla trattenuto dopo", async () => {
  const now = new Date(T * 1000);
  const view: WhoAt = { camera: "front_door", place: "entrance", time: now.toISOString(), people: [{ name: "Alice", confidence: 0.9 }], unrecognized: 1, unknown_faces: [] };
  const dir = mkdtempSync(join(tmpdir(), "external-"));
  let held = 0;
  let windowAsked: number[] = [];
  const x = new External({
    dir,
    who: async () => view,
    frame: async () => null,
    emit: () => undefined,
    answer: () => undefined,
    now: () => now,
    look: () => ({ cameras: { front_door: [] }, before_s: 10, after_s: 4 }),
    hold: () => (held++, () => void held--),
    shots: async (_c, from, to) => ((windowAsked = [from, to]), [
      { track: "aaa111", camera: "front_door", name: "Alice", confidence: 0.9, attempt: attempt("aaa111", -2, "alice", 0.9), area: 900 },
      { track: "bbb222", camera: "front_door", name: null, confidence: null, attempt: attempt("bbb222", -1, "unknown", 0.2), area: 400 },
    ]),
    still: async () => Buffer.from("frame"),
    face: async () => Buffer.from("face"),
  });
  const w = await x.whoWithPictures("front_door");
  assert.deepEqual(windowAsked, [now.getTime() - 10_000, now.getTime()]);
  assert.equal(held, 0);
  const alice = w.people[0]!;
  assert.equal(alice.name, "Alice");
  assert.ok(alice.photo && alice.face && existsSync(join(dir, alice.photo)) && existsSync(join(dir, alice.face)));
  assert.equal(w.unknown_people?.length, 1);
  assert.equal(w.unrecognized, 1);
});

test("a person's frame is one where their face is seen: from behind it is not chosen first / la foto di una persona è un fotogramma dove si vede il volto: di spalle non viene scelta per prima", async () => {
  const now = new Date(T * 1000);
  const view: WhoAt = { camera: "front_door", place: "entrance", time: now.toISOString(), people: [], unrecognized: 0, unknown_faces: [] };
  const asked: [string, number][] = [];
  const x = new External({
    dir: mkdtempSync(join(tmpdir(), "external-")),
    who: async () => view,
    frame: async () => null,
    emit: () => undefined,
    answer: () => undefined,
    now: () => now,
    sleep: async () => undefined,
    look: () => ({ cameras: { front_door: [], yard: ["path"] }, before_s: 10, after_s: 4 }),
    shots: async () => [
      // the yard's face is the best one, but its frames show her from behind until 1.5 s earlier
      { track: "aaa111", camera: "yard", name: "Alice", confidence: 0.9, attempt: attempt("aaa111", -3, "alice", 0.9), area: 900 },
      { track: "bbb222", camera: "front_door", name: "Bob", confidence: 0.9, attempt: attempt("bbb222", -1, "bob", 0.9), area: 400 },
    ],
    still: async (camera, ts) => (asked.push([camera, ts]), Buffer.from(`${camera}@${ts}`)),
    face: async () => Buffer.from("face"),
    faceIn: async (jpeg) => {
      const [camera, ts] = jpeg.toString().split("@");
      if (camera === "front_door") return { name: "Bob", score: 0.9 };
      return Number(ts) === (T - 3 + 0.25 - 1.5) * 1000 ? { name: "Alice", score: 0.88 } : null;
    },
  });
  const o = await x.handle({ id: "r3", kind: "ring", camera: "front_door" });
  const alice = o.people!.find((p) => p.name === "Alice")!;
  // her frame is the one with her face, 1.5 s before the attempt: the nearest ones were tried first
  assert.equal(readFileSync(join((x as unknown as { d: { dir: string } }).d.dir, alice.photo!)).toString(), `yard@${(T - 3 + 0.25 - 1.5) * 1000}`);
  assert.deepEqual(
    asked.filter(([c]) => c === "yard").map(([, ts]) => (ts - (T - 3 + 0.25) * 1000) / 1000),
    [0, -0.5, 0.5, -1, 1, -1.5],
  );
});

test("nobody's face seen in a frame: the event's picture is still the best face's frame / nessun volto visto nei fotogrammi: la foto dell'evento resta quella del volto migliore", async () => {
  const now = new Date(T * 1000);
  const view: WhoAt = { camera: "front_door", place: "entrance", time: now.toISOString(), people: [], unrecognized: 0, unknown_faces: [] };
  const x = new External({
    dir: mkdtempSync(join(tmpdir(), "external-")),
    who: async () => view,
    frame: async () => null,
    emit: () => undefined,
    answer: () => undefined,
    now: () => now,
    sleep: async () => undefined,
    look: () => ({ cameras: { front_door: [] }, before_s: 10, after_s: 4 }),
    shots: async () => [{ track: "aaa111", camera: "front_door", name: "Alice", confidence: 0.9, attempt: attempt("aaa111", -3, "alice", 0.9), area: 900 }],
    still: async (camera, ts) => Buffer.from(`${camera}@${ts}`),
    face: async () => Buffer.from("face"),
    faceIn: async () => null,
  });
  const o = await x.handle({ id: "r4", kind: "ring", camera: "front_door" });
  assert.equal(o.image, `${o.event_id}-1.jpg`);
  assert.equal(readFileSync(join((x as unknown as { d: { dir: string } }).d.dir, o.image!)).toString(), `front_door@${(T - 3 + 0.25) * 1000}`);
});
