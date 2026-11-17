import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { describeOp, fromFrigate, parseRaw, planImport, planPush, type Op, type RawConfig } from "../src/frigate-config.ts";
import { validate, type Config } from "../src/settings.ts";

const GO2RTC = "rtsp://192.0.2.134:8554";
// fixed copy of Frigate's YAML as it was before P2 (direct RTSP streams, real zones and masks)
const yamlText = readFileSync(resolve(import.meta.dirname, "fixtures", "frigate-config.yml"), "utf8");

/** How Frigate applies `config_data`: field-by-field merge, lists are replaced, null deletes. */
function apply(raw: RawConfig, op: Op): RawConfig {
  const out = structuredClone(raw) as RawConfig & Record<string, any>;
  if (op.kind === "remove") delete out.cameras[op.camera];
  else {
    const merge = (dst: Record<string, any>, src: Record<string, any>) => {
      for (const [k, v] of Object.entries(src)) {
        if (v === null) delete dst[k];
        else if (typeof v === "object" && !Array.isArray(v)) merge((dst[k] ??= {}), v);
        else dst[k] = v;
      }
    };
    if (op.kind === "faces") merge((out.face_recognition ??= {}) as Record<string, any>, op.data);
    else merge((out.cameras[op.camera] ??= {}) as Record<string, any>, op.data);
  }
  return out;
}

function cfg(input: unknown): Config {
  const v = validate(input);
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  return v.config;
}

const vlm = { model: "m", vocabulary: { other: "…" }, attributes: {} };
/** Configuration like P1's: cameras without stream and detect, zones only as a polygon. */
function p1Config(): Config {
  return cfg({
    version: 3,
    analyzers: { vlm },
    cameras: {
      attic: { place: "attic", kind: "indoor" },
      living_room: { place: "living_room", kind: "indoor" },
      front_left: { place: "outdoor", kind: "outdoor", zones: { entrance: [[0.287, 0.385], [0.384, 0.385], [0.536, 1], [0.361, 1]] } },
      front_right: { place: "outdoor", kind: "outdoor" },
    },
  });
}

test("Frigate's real YAML in our shape: credential placeholders, zones with their parameters, masks / il YAML vero di Frigate nella nostra forma: segnaposto delle credenziali, zone con i parametri, maschere", () => {
  const raw = parseRaw(JSON.stringify(yamlText)); // /api/config/raw answers with a JSON string
  assert.deepEqual(Object.keys(raw.cameras), ["attic", "front_right", "front_left", "living_room"]);
  const right = fromFrigate(raw.cameras.front_right!, GO2RTC);
  assert.deepEqual(right.stream, { rtsp: "rtsp://{FRIGATE_CAM2_USER}:{FRIGATE_CAM2_PASSWORD}@{FRIGATE_CAM2_HOST}:554/Streaming/Channels/101" });
  assert.deepEqual(right.detect, { width: 2688, height: 1520, fps: 5 });
  assert.deepEqual(right.snapshots, { enabled: true, retain_days: 7 });
  assert.deepEqual(right.zones.entrance, {
    points: [[0.523, 0.288], [0.597, 0.289], [0.559, 0.742], [0.431, 0.742]],
    objects: ["person"],
    inertia: 3,
    loitering_time: 0,
  });
  assert.deepEqual(Object.keys(right.masks), ["timestamp", "camera_name"]);
  assert.equal(fromFrigate(raw.cameras.living_room!).snapshots, undefined);
});

test("first start after P1: the import completes the configuration, then finds no more differences / primo avvio dopo P1: l'importazione completa la configurazione, poi non trova più differenze", () => {
  const raw = parseRaw(yamlText);
  const { next, changes } = planImport(p1Config(), raw, GO2RTC);
  assert.ok(changes.includes("front_left/zones"), "zone parameters taken from Frigate");
  assert.ok(changes.includes("living_room/ffmpeg") && changes.includes("living_room/detect"));
  const imported = cfg(next);
  assert.equal(imported.cameras.front_right!.zones.entrance!.inertia, 3);
  assert.deepEqual(planImport(imported, raw, GO2RTC).changes, []);
  assert.deepEqual(planPush(imported, imported, raw, GO2RTC).ops, []);
});

test("pushing a change and re-importing: no residual difference (no empty versions) / invio di una modifica e reimportazione: nessuna differenza residua (niente versioni a vuoto)", () => {
  let raw = parseRaw(yamlText);
  const prev = cfg(planImport(p1Config(), raw, GO2RTC).next);
  const next = structuredClone(prev);
  const right = next.cameras.front_right!;
  right.zones.entrance = { points: [[0.5, 0.3], [0.6, 0.3], [0.56, 0.75]] }; // without inertia: it must be removed in Frigate too
  right.zones.gate = { points: [[0, 0], [0.1, 0], [0.1, 0.1]], objects: ["person"] };
  delete right.masks.camera_name;
  right.detect!.fps = 3;
  next.version++;

  const { ops, errors } = planPush(prev, next, raw, GO2RTC);
  assert.deepEqual(errors, []);
  assert.deepEqual(ops.map((o) => (o.kind === "section" ? o.section : o.kind)), ["detect", "zones", "motion"]);
  const zones = (ops[1] as Extract<Op, { kind: "section" }>).data.zones as Record<string, any>;
  assert.deepEqual(zones.entrance, { coordinates: "0.5,0.3,0.6,0.3,0.56,0.75", objects: null, inertia: null, loitering_time: null });
  assert.equal((ops[2] as Extract<Op, { kind: "section" }>).data.motion && JSON.stringify((ops[2] as any).data.motion.mask.camera_name), "null");

  for (const op of ops) raw = apply(raw, op);
  assert.deepEqual(planImport(next, raw, GO2RTC).changes, []);
});

test("turning a camera off and on: only the enabled section, nothing to import back / spegnere e riaccendere una camera: solo la sezione enabled, niente da reimportare", () => {
  let raw = parseRaw(yamlText);
  const on = cfg(planImport(p1Config(), raw, GO2RTC).next);
  const off = structuredClone(on);
  off.cameras.attic!.enabled = false;
  off.version++;

  const down = planPush(on, off, raw, GO2RTC).ops;
  assert.deepEqual(down.map((o) => [o.kind === "faces" ? "" : o.camera, o.kind === "section" ? o.section : o.kind, o.kind === "section" ? o.data : null]), [["attic", "enabled", { enabled: false }]]);
  for (const op of down) raw = apply(raw, op);
  assert.deepEqual(planImport(off, raw, GO2RTC).changes, []);

  const back = structuredClone(off);
  delete back.cameras.attic!.enabled; // missing means on, as in Frigate
  const up = planPush(off, back, raw, GO2RTC).ops;
  assert.deepEqual(up.map((o) => (o.kind === "section" ? o.data : null)), [{ enabled: true }]);
  for (const op of up) raw = apply(raw, op);
  assert.deepEqual(planImport(back, raw, GO2RTC).changes, []);
});

test("new camera with go2rtc: full add; removed camera: remove / camera nuova con go2rtc: aggiunta completa; camera tolta: remove", () => {
  const raw = parseRaw(yamlText);
  const prev = cfg(planImport(p1Config(), raw, GO2RTC).next);
  const next = structuredClone(prev) as Config & Record<string, any>;
  next.cameras.garage = cfg({
    version: 0,
    analyzers: { vlm },
    cameras: { garage: { place: "garage", kind: "indoor", stream: { go2rtc: "garage" }, detect: { width: 1280, height: 720, fps: 5 } } },
  }).cameras.garage!;
  delete next.cameras.attic;

  const { ops } = planPush(prev, next, raw, GO2RTC);
  assert.deepEqual(ops.map((o) => `${o.kind === "faces" ? "" : o.camera}/${o.kind}`), ["garage/add", "attic/remove"]);
  const add = ops[0] as Extract<Op, { kind: "add" }>;
  assert.deepEqual(add.data.ffmpeg, { inputs: [{ path: "rtsp://192.0.2.134:8554/garage", input_args: "preset-rtsp-restream", roles: ["detect"] }] });
  assert.deepEqual(add.data.mqtt, { enabled: false });
  assert.deepEqual(add.data.detect, { enabled: true, width: 1280, height: 720, fps: 5 });

  let after = raw;
  for (const op of ops) after = apply(after, op);
  const back = planImport(next, after, GO2RTC);
  assert.deepEqual(back.changes, []);
  assert.deepEqual(fromFrigate(after.cameras.garage!, GO2RTC).stream, { go2rtc: "garage" });
});

test("new camera without stream or detect: error, nothing is sent / camera nuova senza stream o detect: errore, non si invia nulla", () => {
  const raw = parseRaw(yamlText);
  const prev = cfg(planImport(p1Config(), raw, GO2RTC).next);
  const next = structuredClone(prev);
  next.cameras.garage = { place: "garage", kind: "indoor", zones: {}, masks: {}, observe: {} };
  assert.match(planPush(prev, next, raw).errors.join(), /garage: adding it to Frigate needs stream and detect/);
  next.cameras.garage.stream = { go2rtc: "garage" };
  next.cameras.garage.detect = { width: 1, height: 1, fps: 1 };
  assert.match(planPush(prev, next, raw, undefined).errors.join(), /GO2RTC_RTSP_URL is not set/);
});

test("changes from the Frigate UI: tweaked zone and new camera imported; our change to something else does not overwrite them / modifiche dalla UI di Frigate: zona ritoccata e camera nuova importate; una nostra modifica ad altro non le sovrascrive", () => {
  let raw = parseRaw(yamlText);
  const ours = cfg(planImport(p1Config(), raw, GO2RTC).next);
  raw = apply(raw, { kind: "section", camera: "front_left", section: "zones", data: { zones: { entrance: { coordinates: "0.3,0.4,0.4,0.4,0.5,1,0.35,1" } } } });

  // meanwhile we change the detect of the same camera: only detect is sent, Frigate's zone stays
  const next = structuredClone(ours);
  next.cameras.front_left!.detect!.fps = 4;
  const { ops } = planPush(ours, next, raw, GO2RTC);
  assert.deepEqual(ops.map((o) => (o.kind === "section" ? o.section : o.kind)), ["detect"]);
  for (const op of ops) raw = apply(raw, op);

  raw = apply(raw, { kind: "add", camera: "courtyard", data: { ffmpeg: { inputs: [{ path: `${GO2RTC}/courtyard`, roles: ["detect"] }] }, detect: { width: 640, height: 480, fps: 5 } } });
  const { next: imported, changes } = planImport(next, raw, GO2RTC);
  assert.deepEqual(changes, ["front_left/zones", "courtyard: new camera"]);
  const v = cfg(imported);
  assert.deepEqual(v.cameras.front_left!.zones.entrance!.points[0], [0.3, 0.4]);
  assert.deepEqual(v.cameras.courtyard!.stream, { go2rtc: "courtyard" });
});

test("detection off in Frigate (its default): not imported, turned on by the next push / detect spenta in Frigate (il suo default): non importata, accesa dalla push successiva", () => {
  const raw: RawConfig = {
    cameras: { door: { ffmpeg: { inputs: [{ path: `${GO2RTC}/door`, roles: ["detect"] }] }, detect: { width: 1920, height: 1080, fps: 5 } } },
  };
  const prev = cfg(planImport(cfg({ version: 0, analyzers: { vlm }, cameras: {} }), raw, GO2RTC).next);
  assert.deepEqual(prev.cameras.door!.detect, { width: 1920, height: 1080, fps: 5 });
  assert.deepEqual(planImport(prev, raw, GO2RTC).changes, []);

  const next = structuredClone(prev);
  next.cameras.door!.place = "entrance"; // a change of ours about something else
  const { ops } = planPush(prev, next, raw, GO2RTC);
  assert.deepEqual(ops.map(describeOp), ["door/detect"]);
  const after = apply(raw, ops[0]!);
  assert.equal(after.cameras.door!.detect!.enabled, true);
  assert.deepEqual(planPush(prev, next, after, GO2RTC).ops, []);
});

test("decoding on the CPU for one camera: sent to Frigate, imported from its UI, given back / decodifica sulla CPU per una camera: mandata a Frigate, importata dalla sua UI, restituita", () => {
  let raw: RawConfig = {
    cameras: { door: { ffmpeg: { inputs: [{ path: `${GO2RTC}/door`, roles: ["detect"] }] }, detect: { enabled: true, width: 1920, height: 1080, fps: 5 } } },
  };
  const prev = cfg(planImport(cfg({ version: 0, analyzers: { vlm }, cameras: {} }), raw, GO2RTC).next);
  assert.equal(prev.cameras.door!.decode, undefined, "the installation's hardware by default");

  const cpu = structuredClone(prev);
  cpu.cameras.door!.decode = "cpu";
  const { ops } = planPush(prev, cpu, raw, GO2RTC);
  assert.deepEqual(ops.map(describeOp), ["door/ffmpeg"]);
  assert.equal(((ops[0] as Extract<Op, { kind: "section" }>).data.ffmpeg as Record<string, unknown>).hwaccel_args, " ");
  raw = apply(raw, ops[0]!);
  assert.deepEqual(planImport(cpu, raw, GO2RTC).changes, [], "Frigate and the configuration agree");
  assert.equal(planImport(prev, raw, GO2RTC).next.cameras.door!.decode, "cpu", "set in Frigate's UI: imported");

  const back = structuredClone(cpu);
  back.cameras.door!.decode = "auto";
  const undo = planPush(cpu, back, raw, GO2RTC).ops;
  assert.equal(((undo[0] as Extract<Op, { kind: "section" }>).data.ffmpeg as Record<string, unknown>).hwaccel_args, null, "the global setting again");
  raw = apply(raw, undo[0]!);
  assert.equal(raw.cameras.door!.ffmpeg!.hwaccel_args, undefined);
  assert.deepEqual(planPush(prev, back, raw, GO2RTC).ops, []);
});

test("faces: global settings and the smallest face go to Frigate and come back / volti: impostazioni globali e volto minimo vanno a Frigate e tornano", () => {
  let raw = parseRaw(yamlText);
  const prev = planImport(p1Config(), raw, GO2RTC).next;
  const cam = Object.keys(prev.cameras)[0]!;
  const next = structuredClone(prev);
  next.faces = { ...next.faces, save_attempts: 1000, unknown_score: undefined };
  next.cameras[cam]!.face_min_area = 3000;
  next.version++;
  const { ops } = planPush(prev, next, raw, GO2RTC);
  assert.deepEqual(
    ops.map((o) => (o.kind === "faces" ? ["faces", o.data] : [o.kind === "section" ? o.section : o.kind, "data" in o ? o.data : null])),
    [
      ["face_recognition", { face_recognition: { min_area: 3000 } }],
      ["faces", { save_attempts: 1000 }],
    ],
  );
  for (const op of ops) raw = apply(raw, op);
  assert.deepEqual(planImport(next, raw, GO2RTC).changes, []);
  // cleared in the UI: Frigate's global again
  const back = structuredClone(next);
  delete back.cameras[cam]!.face_min_area;
  back.version++;
  for (const op of planPush(next, back, raw, GO2RTC).ops) raw = apply(raw, op);
  assert.equal(raw.cameras[cam]!.face_recognition?.min_area, undefined);
  // changed in Frigate's UI: imported
  raw.face_recognition = { ...raw.face_recognition, recognition_threshold: 0.8 };
  const imported = planImport(back, raw, GO2RTC);
  assert.deepEqual(imported.changes, ["face_recognition"]);
  assert.equal(imported.next.faces?.recognition_threshold, 0.8);
});
