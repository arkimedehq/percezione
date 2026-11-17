import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { dirname, resolve } from "node:path";
import mqtt from "mqtt";
import { LeftObjects, OBJECT_PROMPTS, type Box, type WatchParams } from "./left-objects.ts";
import { applyRules, cameraAttributes, config, UNCERTAIN, WALKING } from "./config.ts";
import { createEmitter, JsonlLog } from "./emitter.ts";
import { describe, finalize, type Observation } from "./events.ts";
import { boxCenter, cropAroundBox, fetchFaceNames, fetchLatestFrame, parseEvent, watchCameraActivity } from "./frigate.ts";
import { FaceModels } from "./face-models.ts";
import { FrigateSync } from "./frigate-sync.ts";
import { startFrigateProxy } from "./frigate-proxy.ts";
import { Analyzers } from "./analyzers.ts";
import { EventStream } from "./event-stream.ts";
import { Api, recentEvents } from "./http.ts";
import { McpTokens } from "./mcp-tokens.ts";
import { UsageCollector } from "./usage.ts";
import { PostureTracker, resolvePosture, withPosture } from "./posture.ts";
import { Outdoor, type OutdoorParams } from "./outdoor.ts";
import { Perception } from "./perception.ts";
import { HaView } from "./ha.ts";
import { Outputs } from "./outputs.ts";
import { Restream, SourcePasswords } from "./restream.ts";
import { FrigateFaces } from "./people.ts";
import { TrackLog } from "./track-log.ts";
import { WHO_TOPIC, whoIsAt, whoRequest } from "./who.ts";
import { Sightings } from "./sightings.ts";
import { External, EXTERNAL_TOPIC, externalRequest } from "./external.ts";
import { bestFaces } from "./best-face.ts";
import { Buffers } from "./buffer.ts";
import { FaceImports } from "./face-import.ts";
import type { ActiveObject } from "./perception.ts";
import { migrateTimeline } from "./migrate.ts";
import { Publisher, TOPIC } from "./publish.ts";
import { WebhookSecrets } from "./webhooks.ts";
import { seedConfig, type FrigateCameraConfig } from "./seed.ts";
import { ConfigStore, groupMains, groupOf, lookOf, tuningOf, type Config } from "./settings.ts";
import { UiPassword } from "./secrets.ts";
import { VlmClient } from "./vlm.ts";

// Frigate's configuration gives the frame sizes and, on first start, cameras and zones; with Frigate down
// we still start from data/config.json (outputs, MCP and UI work, events arrive when it comes back)
const frigateCameras = await loadFrigateCameras();
// a new installation starts with no cameras: Frigate is just starting too, and empty (deploy/)
const store = new ConfigStore(config.configPath, () => seedConfig(frigateCameras ?? {}));
if (store.migrated) console.log(`${config.configPath}: rewritten with the English names (the old file is *.before-english)`);
const timeline = new JsonlLog(config.dataDir, "timeline.jsonl");
// schema v2 events (Italian fields) become v3 once; the old file stays as timeline.jsonl.before-v3
const converted = migrateTimeline(timeline.path, (e) => describe(e as Parameters<typeof describe>[0]));
if (converted) console.log(`timeline: ${converted} events converted to schema v3`);
// one token per agent or program, for /mcp and /events (src/mcp-tokens.ts)
const clientTokens = new McpTokens(resolve(config.dataDir, "mcp-clients.json"));
// the whole timeline (a few MB at most for now); recentEvents keeps only the current schema (v3)
const allEvents = () => recentEvents(timeline.path, 64_000_000);
const eventStream = new EventStream({ tokens: clientTokens, events: allEvents, allowed: () => store.current.outputs.mcp.snapshots });
const samplesLog = new JsonlLog(config.dataDir, "samples.jsonl");
const vlm = new VlmClient(config.ollamaUrl);

const client = mqtt.connect(config.mqtt.url, {
  username: config.mqtt.username,
  password: config.mqtt.password,
  clientId: `perception-${process.pid}`,
  will: { topic: TOPIC.status, payload: Buffer.from("offline"), qos: 1, retain: true },
});
// right after connect(): with an await in between (loadFrameSizes) the connection would arrive before the handler
// and the subscription to frigate/events would never start
client.on("connect", () => {
  console.log(`MQTT connected to ${config.mqtt.url}; configuration v${store.current.version}, model ${store.current.analyzers.vlm.model}`);
  client.subscribe("frigate/events");
  // who is at a camera, for Home Assistant and devices: {"camera": "…", "id": "…"} → perception/who/result
  client.subscribe(WHO_TOPIC.request);
  // something happened in front of a camera (a device said so: a ring, a call…): recorded as an event → perception/external/result
  client.subscribe(EXTERNAL_TOPIC.request);
});
const haEnabled = () => store.current.outputs.homeassistant.enabled;
const publisher = new Publisher(client, 15, timeline.path, haEnabled);
// deliveries through an outbox each: perception/events, HA rule events, webhooks (src/outputs.ts)
const webhookSecrets = new WebhookSecrets(resolve(config.dataDir, "webhook-secrets.json"));
// Percezione's own go2rtc (src/restream.ts): its config follows the sources, before Frigate is told about cameras
// camera of each Frigate track for a week: where a face to name was seen (src/track-log.ts)
const trackLog = new TrackLog(resolve(config.dataDir, "tracks.jsonl"));
const faces = new FrigateFaces(config.frigateUrl);
// what Frigate is tracking right now, as its WebSocket last said (camera_activity): who_is_at reads it
let activeObjects: ActiveObject[] = [];
// names recognized recently on each camera: the other cameras of a group add them to who_is_at (src/sightings.ts)
const sightings = new Sightings();
const whoAt = (target: string) =>
  whoIsAt(target, {
    config: () => store.current,
    active: () => activeObjects,
    attempts: () => faces.attempts(),
    trackCamera: (id) => trackLog.camera(id),
    sightings: (camera, zones, since) => sightings.recent(camera, zones, since),
  });
// a request may name a camera or a group (src/settings.ts groupOf)
const whoTargets = () => [...Object.keys(store.current.cameras), ...Object.keys(store.current.groups)];
const sourcePasswords = new SourcePasswords(resolve(config.dataDir, "source-passwords.json"));
const restream = new Restream({ dir: config.go2rtcConfigDir, ...config.go2rtc, log: console.log });
async function applyRestream(cfg: Config): Promise<void> {
  sourcePasswords.keepOnly(Object.keys(cfg.sources));
  await restream.apply(cfg, sourcePasswords).catch((err: Error) => console.error(`go2rtc: ${err.message}`));
}
await applyRestream(store.current);
// short memory in RAM of the cameras, read from go2rtc with Percezione's own login (src/buffer.ts)
const go2rtcLogin = { user: config.go2rtc.user ?? "", password: config.go2rtc.password ?? "" };
const buffers = new Buffers(
  config.bufferDir,
  (camera) => {
    const stream = store.current.cameras[camera]?.stream;
    if (!stream || !("go2rtc" in stream) || !config.go2rtcRtspUrl) return null;
    const base = config.go2rtcRtspUrl
      .replace("{FRIGATE_GO2RTC_USER}", encodeURIComponent(go2rtcLogin.user))
      .replace("{FRIGATE_GO2RTC_PASSWORD}", encodeURIComponent(go2rtcLogin.password));
    return `${base.replace(/\/$/, "")}/${stream.go2rtc}`;
  },
  { secret: go2rtcLogin.password ? encodeURIComponent(go2rtcLogin.password) : undefined },
);
/** camera → seconds to keep: the cameras on with the short memory on, for their `before_s` or, in a group, its main camera's when longer */
function syncBuffers(cfg: Config): void {
  const want: Record<string, number> = {};
  for (const [name, c] of Object.entries(cfg.cameras)) if (c.enabled !== false && lookOf(c).memory) want[name] = lookOf(c).before_s;
  for (const g of Object.values(cfg.groups))
    for (const c of Object.keys(g.members)) if (c in want) want[c] = Math.max(want[c]!, lookOf(cfg.cameras[g.main]).before_s);
  buffers.sync(want);
}
syncBuffers(store.current);
const outputs = new Outputs({
  dir: resolve(config.dataDir, "outbox"),
  config: () => store.current,
  secrets: webhookSecrets,
  mqtt: ({ topic, payload }) =>
    new Promise((resolve, reject) => {
      if (!client.connected) return reject(new Error("MQTT broker not connected"));
      const timer = setTimeout(() => reject(new Error("no acknowledgement from the broker in 10 s")), 10_000);
      client.publish(topic, payload, { qos: 1 }, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    }),
});
// the current posture of a person: the posture tracker is made further down, after the analyzers
let postureNow: (name: string) => string | null = () => null;
// HA as a view: presence per place and the rules' event entity (src/ha.ts)
const haView = new HaView(client, {
  config: () => store.current,
  presence: () => ({
    present: perception.present().map((p) => ({ name: p.name, camera: p.room, activity: p.activity, posture: postureNow(p.name) })),
    unnamed: perception.unnamed(),
  }),
  picture: async (file) => {
    const img = external.picture(file);
    return img && sharp(img).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  },
  // read only on a (re)connection or when the photos are switched: the latest external event of each kind
  externals: () => [...new Map(allEvents().filter((e) => e.type === "external" && e.value?.to).map((e) => [e.value!.to!, e])).values()],
});
client.on("connect", () => {
  outputs.retryNow();
  haView.connected();
});
const publishEvent = createEmitter(timeline, (e) => {
  outputs.route(e);
  publisher.publish(e);
  haView.refresh();
  void haView.external(e);
  eventStream.push(e);
  api?.broadcast({ type: "event", event: e });
});
// frontend: created further down, after the store and the sync with Frigate
let api: Api | undefined;
// rules apply with the configuration in force at the time of the event
const emit = (o: Observation) => publishEvent(finalize(o, store.current));
const observe = (camera: string) => store.current.cameras[camera]?.observe;
const minFaceScore = (camera: string) => store.current.cameras[camera]?.face_min_score;

// read on every use: a change from the UI applies at once
const tuning = () => tuningOf(store.current);
const perception = new Perception(
  {
    stableMs: 120_000, // default only: the real window is the camera's
    get minConf() {
      return tuning().min_conf;
    },
    get minSamples() {
      return tuning().min_samples;
    },
    get enterRatio() {
      return tuning().enter_ratio;
    },
    get absenceMs() {
      return tuning().absence_s * 1000;
    },
    get trackStaleMs() {
      return tuning().track_stale_s * 1000;
    },
    get inheritIou() {
      return tuning().inherit_iou;
    },
  },
  {
    now: Date.now,
    emit,
    onArrived: (name) => void sample(name),
    observes: (camera) => observe(camera)?.presence !== undefined,
    stableMsFor: (camera) => (observe(camera)?.activity?.stable_s ?? 0) * 1000 || undefined,
    minFaceScore,
  },
);

// one passage observer per camera group; on every change they are updated without losing passages in progress
const outdoors = new Map<string, Outdoor>();
function syncOutdoor(cfg: Config): void {
  const groups = new Map<string, OutdoorParams>();
  for (const [camera, c] of Object.entries(cfg.cameras)) {
    const pass = c.observe.passages;
    if (!pass) continue;
    const g = groups.get(pass.group) ?? {
      cameras: new Set<string>(),
      zones: new Map<string, string>(),
      trackStaleMs: tuningOf(cfg).track_stale_s * 1000,
      mergeGapMs: 0,
    };
    g.cameras.add(camera);
    if (c.observe.approach) g.zones.set(camera, c.observe.approach.zone);
    g.mergeGapMs = Math.max(g.mergeGapMs, pass.merge_s * 1000);
    groups.set(pass.group, g);
  }
  for (const [name, params] of groups) {
    const o = outdoors.get(name);
    if (o) o.configure(params);
    else outdoors.set(name, new Outdoor(params, { now: Date.now, emit, minFaceScore }));
  }
  for (const name of outdoors.keys()) if (!groups.has(name)) outdoors.delete(name);
}
syncOutdoor(store.current);
// analyzers: internal VLM and external runners (v1 contract), health and capabilities for the frontend
const analyzers = new Analyzers(store, config.ollamaUrl);
await analyzers.start(30_000);

const postures = new PostureTracker(
  {
    stableMs: 15_000,
    minConf: 0,
    get minSamples() {
      return tuning().min_samples;
    },
    get enterRatio() {
      return tuning().enter_ratio;
    },
  },
  { now: Date.now, emit },
);
postureNow = (name) => postures.current(name);
const lastPosture = new Map<string, number>();

// objects left in watched zones: before/after photos in data/left-objects (served to the frontend)
// external events (a device says something happened: a ring, a call…): a picture of the moment and who is there (src/external.ts)
// each person's best face (Frigate's attempts) and its frame from the short memory (src/buffer.ts)
const attemptImage = async (file: string) => {
  const res = await faces.image("train", file);
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
};
const external = new External({
  dir: resolve(config.dataDir, "external"),
  who: (camera) => whoAt(camera),
  frame: (camera) => fetchLatestFrame(config.frigateUrl, camera, detectSize(camera)),
  emit,
  answer: (r) => client.publish(EXTERNAL_TOPIC.result, JSON.stringify(r), { qos: 1 }),
  // a camera, or a group with the times of its main camera
  look: (camera) => {
    const g = groupOf(store.current, camera)?.group;
    const cameras: Record<string, string[]> = { [camera]: [], ...Object.fromEntries(Object.entries(g?.members ?? {}).map(([c, m]) => [c, m.zones])) };
    const { before_s, after_s } = lookOf(store.current.cameras[camera]);
    return { cameras, before_s, after_s };
  },
  hold: (cameras, from, to) => buffers.hold(cameras, from, to),
  shots: (cameras, from, to) =>
    bestFaces(cameras, from, to, {
      attempts: () => faces.attempts(),
      track: (id) => sightings.track(id),
      size: async (file) => {
        const img = await attemptImage(file);
        const m = img && (await sharp(img).metadata());
        return m?.width && m.height ? { width: m.width, height: m.height } : null;
      },
    }),
  still: (camera, ts) => buffers.frame(camera, ts),
  face: async (file) => {
    const img = await attemptImage(file);
    return img && sharp(img).jpeg({ quality: 90 }).toBuffer();
  },
  // is the face in the frame too: a frame from behind is not the person's picture
  faceIn: (jpeg) => faces.recognize(jpeg),
});
external.prune();
setInterval(() => external.prune(), 3_600_000);
const mediaDir = resolve(config.dataDir, "left-objects");
mkdirSync(mediaDir, { recursive: true });
const leftObjects = new LeftObjects({
  now: Date.now,
  frame: (camera) => fetchLatestFrame(config.frigateUrl, camera, detectSize(camera)),
  classify: async (camera, frame, [x1, y1, x2, y2]) => {
    const obs = observe(camera)?.left_object;
    if (!obs) throw new Error("left_object observation removed");
    // CLIP needs some context: at least 160 px around the center
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const half = Math.max(x2 - x1, y2 - y1, 160) / 2;
    const box: Box = [cx - half, cy - half, cx + half, cy + half];
    const r = await analyzers.infer(obs.analyzer, obs.model, frame, { box, prompts: OBJECT_PROMPTS });
    const top = (r.result?.top ?? []) as { label: string; score: number }[];
    return Object.fromEntries(top.map((t) => [t.label, t.score]));
  },
  save: async (name, jpeg) => {
    writeFileSync(resolve(mediaDir, name), jpeg);
    return name;
  },
  emit,
  log: (m) => console.log(m),
});
function syncLeftObjects(cfg: Config): void {
  const params: WatchParams[] = [];
  for (const [camera, c] of Object.entries(cfg.cameras)) {
    const a = c.observe.left_object;
    const zone = a && c.zones[a.zone];
    if (!a || !zone) continue;
    params.push({
      camera,
      zone: a.zone,
      polygon: zone.points,
      checkMs: a.check_s * 1000,
      persistMs: a.persist_s * 1000,
      minScore: a.min_score,
      minCells: a.min_cells,
    });
  }
  leftObjects.configure(params);
}
syncLeftObjects(store.current);
const posing = new Set<string>();

// cameras, zones, masks, detect and snapshots also go to Frigate, live
const frigateSync = new FrigateSync(config.frigateUrl, store, config.go2rtcRtspUrl, {
  info: (message) => {
    console.log(message);
    api?.broadcast({ type: "sync", level: "info", message });
  },
  error: (message) => {
    console.error(message);
    api?.broadcast({ type: "sync", level: "error", message });
  },
});
/** the last change on its way to go2rtc and Frigate: a restore waits for it before restarting */
let applied: Promise<void> = Promise.resolve();
store.onChange((next, prev) => {
  outputs.reconcile();
  haView.refresh();
  syncOutdoor(next);
  syncLeftObjects(next);
  console.log(`configuration v${prev.version} → v${next.version} applied`);
  api?.broadcast({ type: "config", version: next.version });
  void analyzers.refresh();
  // a camera may use a source that go2rtc gets only now: go2rtc first, then Frigate
  applied = applyRestream(next).then(() => frigateSync.onChange(next, prev));
  syncBuffers(next);
});
store.watch();
haView.start();
// the first round completes the configuration with what is only in Frigate (stream, detect, zone parameters)
await frigateSync.start(() => tuning().frigate_import_s * 1000);
// on a new installation Frigate starts before its face models are downloaded, and then drops every face (src/face-models.ts)
new FaceModels({ configDir: config.frigateConfigDir, frigateUrl: config.frigateUrl, log: (m) => console.log(m) }).start();

// Detect stream diagonal per camera, to recognize movement ("walking")
const frameDiag = new Map<string, number>();
const diagOf = (camera: string) => {
  const d = store.current.cameras[camera]?.detect;
  return d ? Math.hypot(d.width, d.height) : frameDiag.get(camera);
};
const lastCenter = new Map<string, [number, number]>();
const busy = new Set<string>();
const lastSampled = new Map<string, number>();
for (const [cam, c] of Object.entries(frigateCameras ?? {})) frameDiag.set(cam, Math.hypot(c.detect.width, c.detect.height));

/** Detect size of a camera: the size of a live frame (see fetchLatestFrame). */
/** Any HTTP answer within 3 s: a 401 from go2rtc's login still means it is up. */
async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).status < 500;
  } catch {
    return false;
  }
}

function detectSize(camera: string): { width: number; height: number } | undefined {
  const d = store.current.cameras[camera]?.detect ?? frigateCameras?.[camera]?.detect;
  return d ? { width: d.width, height: d.height } : undefined;
}

/** The cameras in Frigate's configuration, or undefined when Frigate is down. */
async function loadFrigateCameras(): Promise<Record<string, FrigateCameraConfig> | undefined> {
  try {
    const res = await fetch(`${config.frigateUrl}/api/config`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { cameras: Record<string, FrigateCameraConfig> }).cameras;
  } catch (err) {
    console.warn(`Frigate unreachable (${config.frigateUrl}/api/config: ${(err as Error).message}): starting from data/config.json`);
    return undefined;
  }
}

/** One posture sample: the person cropped from Frigate's box → the pose_estimation analyzer. */
async function samplePosture(name: string): Promise<void> {
  const target = perception.present().find((p) => p.name === name);
  const cam = target && store.current.cameras[target.room];
  const obs = cam?.observe.posture;
  if (!target || !cam || !obs || !target.box || posing.has(name)) return;
  posing.add(name);
  lastPosture.set(name, Date.now());
  try {
    const frame = await fetchLatestFrame(config.frigateUrl, target.room, detectSize(target.room));
    const r = await analyzers.infer(obs.analyzer, obs.model, frame, { box: target.box });
    const raw = String(r.result?.label ?? UNCERTAIN);
    const [x1, y1, x2, y2] = target.box;
    const d = cam.detect ?? frigateCameras?.[target.room]?.detect;
    const center: [number, number] = d ? [(x1 + x2) / 2 / d.width, (y1 + y2) / 2 / d.height] : [0.5, 0.5];
    const rest = obs.rest_zones.flatMap((z) => (cam.zones[z] ? [cam.zones[z]!.points] : []));
    const label = resolvePosture(raw, center, rest, obs.no_rest_place);
    samplesLog.append({
      ts: new Date().toISOString(),
      person: name,
      camera: target.room,
      posture: label,
      raw,
      features: r.result?.features ?? null,
      ms: r.inference_ms ?? null,
      source: "pose",
    });
    postures.push({ name, camera: target.room, person: target.person, trackId: target.trackId }, label, obs.stable_s * 1000);
  } catch (err) {
    console.warn(`posture failed for ${name}: ${(err as Error).message}`);
  } finally {
    posing.delete(name);
  }
}

async function sample(name: string): Promise<void> {
  const target = perception.present().find((p) => p.name === name);
  const activity = target && observe(target.room)?.activity;
  if (!target || !activity || busy.has(name)) return;
  busy.add(name);
  const ts = Date.now();
  lastSampled.set(name, ts);
  try {
    const center = target.box ? boxCenter(target.box) : undefined;
    const prev = lastCenter.get(name);
    if (center) lastCenter.set(name, center);
    const diag = diagOf(target.room);
    if (center && prev && diag && Math.hypot(center[0] - prev[0], center[1] - prev[1]) / diag > tuning().walk_threshold) {
      samplesLog.append({ ts: new Date(ts).toISOString(), person: name, camera: target.room, activity: WALKING, source: "box" });
      perception.addSample(name, { label: WALKING, conf: 1, ts });
      return;
    }

    const { vlm: analyzer } = store.current.analyzers;
    const frame = await fetchLatestFrame(config.frigateUrl, target.room, detectSize(target.room));
    // fast filter: CLIP on the wide crop; when sure and the label is in the vocabulary, no VLM
    if (activity.fast && target.box) {
      try {
        const r = await analyzers.infer(activity.fast.analyzer, activity.fast.model, frame, { box: target.box });
        const label = String(r.result?.label ?? "");
        const score = Number(r.result?.score ?? 0);
        const confident = score >= activity.fast.min_score && label in analyzer.vocabulary;
        samplesLog.append({
          ts: new Date(ts).toISOString(),
          person: name,
          camera: target.room,
          activity: confident ? label : null,
          proposed: label,
          score,
          ms: r.inference_ms ?? null,
          source: "fast",
        });
        if (confident) {
          console.log(`  · ${name}: ${label} (fast ${score.toFixed(2)}, ${r.inference_ms} ms)`);
          perception.addSample(name, { label, conf: 1, ts });
          return;
        }
      } catch (err) {
        console.warn(`fast filter failed for ${name}: ${(err as Error).message}`);
      }
    }
    const crop = await cropAroundBox(frame, target.box, tuning().crop_margin, tuning().crop_max_side);
    const r = await vlm.classify(analyzer.model, crop, cameraAttributes(analyzer.attributes, activity));
    // where the pose model measures the posture, it answers "lying down" instead of the VLM
    const label = r ? applyRules(withPosture(r.attributes, postures.current(name)), activity) : null;
    samplesLog.append({
      ts: new Date(ts).toISOString(),
      person: name,
      camera: target.room,
      activity: label,
      attributes: r?.attributes ?? null,
      vlm_ms: r?.ms ?? null,
      valid: r !== null,
      source: "vlm",
    });
    if (!r || !label) {
      console.warn(`sample discarded for ${name}`);
      return;
    }
    console.log(`  · ${name}: ${label} (${r.ms} ms)`);
    // yes/no answers have no confidence: the debounce only counts votes
    perception.addSample(name, { label, conf: 1, ts });
  } catch (err) {
    console.warn(`sampling failed for ${name}: ${(err as Error).message}`);
  } finally {
    busy.delete(name);
  }
}

{
  api = new Api({
    store,
    sync: frigateSync,
    analyzers,
    frigateUrl: config.frigateUrl,
    go2rtc: { ...config.go2rtc, rtspBase: config.go2rtcRtspUrl },
    timelinePath: timeline.path,
    mediaDir,
    sessionsPath: resolve(config.dataDir, "ui-sessions.json"),
    hosts: config.ui.hosts,
    frigateUiPort: config.ui.frigatePort || undefined,
    usage: new UsageCollector({
      frigateUrl: config.frigateUrl,
      root: dirname(config.dataDir),
      dataDir: config.dataDir,
      storageDir: resolve(dirname(config.dataDir), "frigate", "storage"),
    }),
    dataDir: config.dataDir,
    settled: async () => {
      await applied;
      await frigateSync.idle();
    },
    restart: () => {
      console.log("restore done: restarting to read tokens, secrets and passwords again");
      shutdown();
    },
    // UI_PASSWORD, or the one chosen in the UI at first start
    password: new UiPassword(resolve(config.secretsDir, "ui.json"), config.ui.password),
    distDir: config.ui.distDir,
    health: async () => ({
      mqtt: client.connected,
      frigate: await answers(`${config.frigateUrl}/api/version`),
      ...(config.go2rtc.apiUrl ? { go2rtc: await answers(`${config.go2rtc.apiUrl}/api`) } : {}),
    }),
    mcp: {
      config: () => store.current,
      tokens: clientTokens,
      events: allEvents,
      presence: () => ({
        present: perception.present().map((p) => ({
          name: p.name,
          camera: p.room,
          activity: p.activity,
          posture: postures.current(p.name),
          confidence: p.person.confidence,
          source: p.person.source,
        })),
        unnamed: perception.unnamed(),
      }),
      people: () => fetchFaceNames(config.frigateUrl),
      frame: (camera) => fetchLatestFrame(config.frigateUrl, camera, detectSize(camera)),
      whoIsAt: (camera, photos) => (photos ? external.whoWithPictures(camera) : whoAt(camera)),
      picture: (file) => external.picture(file),
    },
    events: eventStream,
    outputs,
    webhookSecrets,
    faces,
    faceImports: new FaceImports(resolve(config.dataDir, "people-imports.json")),
    whoIsAt: (camera, photos) => (photos ? external.whoWithPictures(camera) : whoAt(camera)),
    external: { handler: external, dir: resolve(config.dataDir, "external") },
    trackCamera: (id) => trackLog.camera(id),
    restream: { restream, passwords: sourcePasswords, apply: () => applyRestream(store.current), login: { user: config.go2rtc.user, password: config.go2rtc.password } },
    // "Try now" from the frontend: the whole frame, no box, no effect on the states
    tryActivity: async (camera, activity) => {
      const { model, attributes } = store.current.analyzers.vlm;
      const frame = await fetchLatestFrame(config.frigateUrl, camera);
      const img = await cropAroundBox(frame, null, tuning().crop_margin, tuning().crop_max_side);
      const r = await vlm.classify(model, img, cameraAttributes(attributes, activity));
      return r ? { attributes: r.attributes, label: applyRules(r.attributes, activity), ms: r.ms, model } : { error: "invalid VLM answer" };
    },
  });
  await api.listen(config.ui.port, config.ui.host);
  console.log(`frontend at http://${config.ui.host}:${config.ui.port}`);
  if (config.ui.frigatePort) {
    const ui = api;
    await startFrigateProxy({ frigateUrl: config.frigateUrl, authed: (req) => ui.authed(req), uiPort: config.ui.port, hosts: config.ui.hosts }, config.ui.frigatePort, config.ui.host);
    console.log(`Frigate behind the login at http://${config.ui.host}:${config.ui.frigatePort}`);
  }
}

watchCameraActivity(config.frigateUrl, () => tuning().activity_poll_s * 1000, (objects) => {
  activeObjects = objects;
  perception.syncActive(objects);
  leftObjects.syncActive(objects);
});

client.on("error", (err) => console.error(`MQTT: ${err.message}`));
client.on("message", (topic, payload) => {
  if (topic === WHO_TOPIC.request) return void answerWho(payload);
  if (topic === EXTERNAL_TOPIC.request) return void recordExternal(payload.toString());
  const ev = parseEvent(payload);
  if (!ev) return;
  if (ev.after.label === "person") trackLog.saw(ev.after.id, ev.after.camera, ev.after.start_time);
  sightings.handleEvent(ev);
  perception.handleEvent(ev);
  for (const o of outdoors.values()) o.handleEvent(ev);
  leftObjects.handleEvent(ev);
});

// every second: stale tracks, finished passages, and a VLM sample for whoever passed their camera's interval
setInterval(() => {
  perception.sweepStale();
  for (const o of outdoors.values()) o.sweepStale();
  const now = Date.now();
  const present = perception.present();
  for (const p of present) {
    const interval = observe(p.room)?.activity?.interval_s;
    if (interval && now - (lastSampled.get(p.name) ?? 0) >= interval * 1000) void sample(p.name);
    const pose = observe(p.room)?.posture?.interval_s;
    if (pose && now - (lastPosture.get(p.name) ?? 0) >= pose * 1000) void samplePosture(p.name);
  }
  postures.prune(new Set(present.map((p) => p.name)));
  void leftObjects.tick();
}, 1_000);

async function recordExternal(payload: string): Promise<void> {
  const req = externalRequest(payload, Object.keys(store.current.cameras), groupMains(store.current));
  if ("error" in req) return void client.publish(EXTERNAL_TOPIC.result, JSON.stringify(req), { qos: 1 });
  await external.handle(req).catch((err: Error) => console.error(`external event: ${err.message}`));
}

async function answerWho(payload: Buffer): Promise<void> {
  const req = whoRequest(payload.toString(), whoTargets());
  const reply = "error" in req ? req : { id: req.id, ...(await (req.photos ? external.whoWithPictures(req.camera) : whoAt(req.camera))) };
  client.publish(WHO_TOPIC.result, JSON.stringify(reply), { qos: 1 });
}

// Ctrl-C, docker stop, and the restart after a restore
function shutdown(): void {
  store.close();
  frigateSync.stop();
  analyzers.stop();
  buffers.stop();
  api?.close();
  client.publish(TOPIC.status, "offline", { qos: 1, retain: true });
  client.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
