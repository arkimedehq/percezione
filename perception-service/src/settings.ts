import { copyFileSync, watch, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";

import { migrateConfig } from "./migrate.ts";

/**
 * Cameras, observations and rules: one source of truth in `data/config.json`. The frontend edits it, or it is
 * edited by hand: the service reloads it on the fly. Older Italian configurations are migrated on read
 * (src/migrate.ts).
 */

const Point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const Polygon = z.array(Point).min(3);
const Name = z.string().regex(/^[a-z0-9_]+$/, "lowercase letters, digits and _ only");

export const EVENT_TYPES = ["arrived", "left", "activity_changed", "posture_changed", "passage", "approach", "object_left", "external"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Posture labels: the analyzer's, plus `on_floor` (lying outside the rest zones). */
export const POSTURES = ["standing", "sitting", "lying", "on_floor"] as const;

/** What can be left in a zone: labels of the `object_left` event (src/left-objects.ts). */
export const OBJECTS = ["trash", "parcel", "bulky"] as const;

export const IMPORTANCE = ["low", "normal", "high"] as const;
export type Importance = (typeof IMPORTANCE)[number];

/** Who a rule is about: a name, or one of these. */
export const PERSON_FILTERS = ["anyone", "unknown", "known"] as const;

const ActivityRule = z.strictObject({ if: z.record(z.string(), z.boolean()), then: z.string() });

const Observe = z.strictObject({
  /** arrived / left and who is in a place: people recognized by their face only */
  presence: z.strictObject({}).optional(),
  /** activity from the VLM: yes/no questions → rules → label, debounced */
  activity: z
    .strictObject({
      analyzer: z.literal("vlm").default("vlm"),
      rules: z.array(ActivityRule),
      default: z.string(),
      interval_s: z.number().positive().default(20),
      stable_s: z.number().positive().default(120),
      /** fast zero-shot filter (CLIP): when at least min_score sure, its label is used without the VLM */
      fast: z
        .strictObject({ analyzer: z.string(), model: z.string(), min_score: z.number().min(0).max(1).default(0.6) })
        .optional(),
    })
    .optional(),
  /** anyone walking by, recognized or not; cameras of the same group make one passage */
  passages: z.strictObject({ group: Name.default("street"), merge_s: z.number().nonnegative().default(15) }).optional(),
  /** entering a zone: needs `passages` on the same camera */
  approach: z.strictObject({ zone: z.string() }).optional(),
  /** posture from the body's keypoints (pose_estimation analyzer), debounced */
  posture: z
    .strictObject({
      /** endpoint in analyzers.endpoints and a model it serves */
      analyzer: z.string(),
      model: z.string(),
      interval_s: z.number().positive().default(5),
      stable_s: z.number().positive().default(15),
      /** zones where lying is normal (sofa, bed); outside them it becomes `on_floor` */
      rest_zones: z.array(z.string()).default([]),
      /** the room has no sofa or bed: with no rest zones, lying is always `on_floor` */
      no_rest_place: z.boolean().default(false),
    })
    .optional(),
  /** objects left in the zone (trash, parcels, bulky items): a lasting change, classified by CLIP */
  left_object: z
    .strictObject({
      zone: z.string(),
      /** zero_shot_classification endpoint and model */
      analyzer: z.string(),
      model: z.string(),
      /** one comparison every check_s, while nobody is on the camera */
      check_s: z.number().positive().default(20),
      /** the change must stay the same for persist_s */
      persist_s: z.number().positive().default(90),
      min_score: z.number().min(0).max(1).default(0.5),
      /** minimum changed cells (24×24 grid over the zone rectangle) */
      min_cells: z.number().int().positive().default(2),
    })
    .optional(),
});

// credentials only as {FRIGATE_*} placeholders that Frigate resolves from its environment, never in the file
const RtspUrl = z
  .string()
  .regex(/^rtsps?:\/\//, "must start with rtsp://")
  .refine((u) => !/:\/\/[^@/]*:(?!\{FRIGATE_[A-Z0-9_]+\}@)[^@/]*@/.test(u), "plain-text password: use {FRIGATE_…}");

const InputArgs = { input_args: z.string().optional() };
/** Credentials live in the environment ({FRIGATE_…} placeholders) or in go2rtc, which Frigate reads without them. */
const Stream = z.union([
  z.strictObject({ go2rtc: z.string().regex(/^[A-Za-z0-9_-]+$/), ...InputArgs }),
  z.strictObject({ rtsp: RtspUrl, ...InputArgs }),
]);
export type Stream = z.infer<typeof Stream>;

/** A go2rtc stream name: the id of a source, and `<id>_sub` for its light stream. */
const SourceId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and - only");
// the user may be in the address, never the password: Percezione keeps it apart (src/restream.ts)
const SourceUrl = z
  .string()
  .regex(/^(rtsps?|https?):\/\//, "must start with rtsp://, rtsps://, http:// or https://")
  .refine((u) => !/:\/\/[^@/]*:[^@/]*@/.test(u), "no password in the address: it is set apart");
const Source = z.strictObject({
  /** main stream (detection, full screen) */
  url: SourceUrl,
  /** light stream for small previews */
  sub: SourceUrl.optional(),
  label: z.string().optional(),
});

// Frigate fields managed from here (src/frigate-config.ts): no defaults, because a default different from
// Frigate's would show up as a difference to import at every comparison.
const ZoneObject = z.strictObject({
  points: Polygon,
  objects: z.array(z.string()).optional(),
  inertia: z.number().int().positive().optional(),
  loitering_time: z.number().int().nonnegative().optional(),
});
export type Zone = z.infer<typeof ZoneObject>;
// the bare polygon too
const Zone = z.union([Polygon.transform((points): Zone => ({ points })), ZoneObject]);

const Camera = z.strictObject({
  label: z.string().optional(),
  /** false: Frigate stops reading and analyzing it (it stays configured); missing means on */
  enabled: z.boolean().optional(),
  stream: Stream.optional(),
  /**
   * Video decoding: "auto" (missing) uses the installation's hardware (Intel or NVIDIA GPU, or the CPU); "cpu" decodes
   * this camera on the CPU, for a stream the GPU cannot decode (e.g. some cameras on Intel VAAPI).
   */
  decode: z.enum(["auto", "cpu"]).optional(),
  detect: z
    .strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().int().positive() })
    .optional(),
  /** one picture per tracked object, on Frigate's disk (never on MQTT) */
  snapshots: z.strictObject({ enabled: z.boolean(), retain_days: z.number().nonnegative().optional() }).optional(),
  /** the place (a room, or e.g. "outdoor"): Home Assistant area, place for agents */
  place: z.string(),
  kind: z.enum(["indoor", "outdoor"]),
  /** face score Frigate must give before a name is taken on this camera (Frigate's threshold is global) */
  face_min_score: z.number().min(0).max(1).optional(),
  /** smallest face Frigate tries to recognize on this camera, px² (missing: Frigate's global, 750): smaller faces are
   *  far or blurred and use up Frigate's attempts for the track */
  face_min_area: z.number().int().positive().optional(),
  /**
   * A request on this camera (e.g. a ring) looks from `before_s` before it to `after_s` after, and each person gets
   * Frigate's best face. With `memory` on, the last `before_s` seconds of video are kept in RAM (src/buffer.ts): each
   * person gets also the whole frame of that instant.
   */
  look: z
    .strictObject({ memory: z.boolean().optional(), before_s: z.number().min(0).max(60).optional(), after_s: z.number().min(1).max(60).optional() })
    .optional(),
  zones: z.record(z.string(), Zone).default({}),
  /** motion masks */
  masks: z.record(z.string(), Polygon).default({}),
  observe: Observe.default({}),
});

/**
 * Cameras that look at the same place from different points (docs/external-events.md), e.g. a camera at an
 * entrance and one on the path to it: "who is there" uses all of them. People are counted on the main camera;
 * the others add the names they recognized in their zones in the last `window_s`. A request on the group (e.g. a ring)
 * looks with the main camera's `look`, on all its cameras.
 */
const Group = z.strictObject({
  label: z.string().optional(),
  main: z.string(),
  /** the other cameras, with the zones that count (none: the whole picture) */
  members: z.record(z.string(), z.strictObject({ zones: z.array(z.string()).default([]) })).default({}),
  window_s: z.number().positive().default(60),
});
export type Group = z.infer<typeof Group>;

const PersonFilter = z.union([z.string(), z.array(z.string())]);
const When = z.strictObject({
  event: z.union([z.enum(EVENT_TYPES), z.array(z.enum(EVENT_TYPES)).min(1)]).optional(),
  cameras: z.array(z.string()).optional(),
  places: z.array(z.string()).optional(),
  /** a name, or "unknown", "known", "anyone" */
  person: PersonFilter.optional(),
  /** activity_changed / posture_changed: the new value; left: the last activity; object_left: the object; external: the kind */
  value: z.union([z.string(), z.array(z.string())]).optional(),
  zone: z.string().optional(),
  /** local time range, also across midnight: "23:00-06:00" */
  hours: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, "format HH:MM-HH:MM")
    .optional(),
  /** minimum duration of the event (passage) */
  for_s: z.number().nonnegative().optional(),
});

const Common = { importance: z.enum(IMPORTANCE).optional() };
export const Reaction = z.discriminatedUnion("react", [
  z.strictObject({
    react: z.literal("notify"),
    to: z.string(),
    snapshot: z.boolean().optional(),
    urgent: z.boolean().optional(),
    ...Common,
  }),
  z.strictObject({ react: z.literal("memory"), ...Common }),
  z.strictObject({ react: z.literal("ha"), ...Common }),
  z.strictObject({ react: z.literal("webhook"), to: z.string(), ...Common }),
  z.strictObject({ react: z.literal("announce"), to: z.string().optional(), ...Common }),
]);
export type Reaction = z.infer<typeof Reaction>;

export const RuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]+$/, "lowercase letters, digits, - and _ only"),
  name: z.string(),
  enabled: z.boolean().default(true),
  when: When.default({}),
  then: z.array(Reaction).min(1),
});
export type Rule = z.infer<typeof RuleSchema>;

const Vlm = z.strictObject({
  model: z.string(),
  /** activity labels with their description (for the UI and for whoever receives the events) */
  vocabulary: z.record(z.string(), z.string()),
  /** yes/no questions asked to the VLM: name → description */
  attributes: z.record(z.string(), z.string()),
});

const ConfigBase = z.strictObject({
  version: z.number().int().nonnegative(),
  cameras: z.record(Name, Camera),
  analyzers: z.strictObject({
    vlm: Vlm,
    /** external analyzers with contract v1 (docs/analyzers.md), by name */
    endpoints: z.record(Name, z.strictObject({ url: z.url() })).default({}),
  }),
  rules: z.array(RuleSchema).default([]),
  /** groups of cameras, by id (an id is never a camera's name: requests take either) */
  groups: z.record(Name, Group).default({}),
  /**
   * Frigate's face recognition (global, written into its config like the cameras, src/frigate-sync.ts): the score for
   * a name, the score under which a face is unknown, how many recent attempts it keeps (in RAM, "to name").
   */
  faces: z
    .strictObject({
      recognition_threshold: z.number().min(0).max(1).optional(),
      unknown_score: z.number().min(0).max(1).optional(),
      save_attempts: z.number().int().min(0).max(10_000).optional(),
    })
    .optional(),
  /** fine tuning of presence, activity and the link with Frigate (TUNING: the defaults) */
  tuning: z
    .strictObject({
      /** a person gone this long is `left`; a new track with the same name within it is a return */
      absence_s: z.number().int().min(5).max(3600).optional(),
      /** a track gone from both MQTT and Frigate's WebSocket for this long is closed */
      track_stale_s: z.number().int().min(10).max(3600).optional(),
      /** overlap of the boxes for a new unnamed track to inherit the name of one just closed */
      inherit_iou: z.number().min(0).max(1).optional(),
      /** an activity sample counts above this confidence */
      min_conf: z.number().min(0).max(1).optional(),
      /** samples needed before an activity can become current */
      min_samples: z.number().int().min(1).max(50).optional(),
      /** share of the window's samples an activity needs to become current */
      enter_ratio: z.number().min(0.5).max(1).optional(),
      /** shift of the box between two samples, as a share of the frame diagonal, that is walking */
      walk_threshold: z.number().min(0.01).max(1).optional(),
      /** margin around the person in the picture for the VLM, as a share of the box */
      crop_margin: z.number().min(0).max(3).optional(),
      /** longest side of the picture for the VLM, px */
      crop_max_side: z.number().int().min(128).max(2048).optional(),
      /** how often changes made in Frigate's UI come back here */
      frigate_import_s: z.number().int().min(5).max(3600).optional(),
      /** how often Frigate is asked who is in view */
      activity_poll_s: z.number().int().min(1).max(300).optional(),
    })
    .optional(),
  /** video sources of Percezione's own go2rtc (src/restream.ts), by stream id */
  sources: z.record(SourceId, Source).default({}),
  /** sharing go2rtc's streams with other apps on the network */
  restream: z
    .strictObject({
      share: z.boolean().default(false),
      /** this machine's address as other devices reach it (WebRTC needs it) */
      address: z.string().optional(),
    })
    .default({ share: false }),
  outputs: z
    .strictObject({
      /** signed webhooks (src/webhooks.ts), by name: they get the events of the rules with a `webhook` reaction to them */
      webhooks: z.record(Name, z.strictObject({ url: z.url(), enabled: z.boolean().default(true) })).default({}),
      /** Home Assistant as a view (src/ha.ts): entities by MQTT discovery; perception/events stays on regardless */
      homeassistant: z
        .strictObject({
          enabled: z.boolean().default(true),
          /** "Last <kind>" (image entities): the photo of the last external event of each kind; off by default, it is a picture of people */
          external_photos: z.boolean().default(false),
        })
        // a new object each time: a shared default would carry one configuration's change into the next
        .default(() => ({ enabled: true, external_photos: false })),
      /** read-only MCP server for agents (src/mcp.ts) */
      mcp: z
        .strictObject({
          /** cameras whose current image an agent may see; none by default */
          snapshots: z.array(z.string()).default([]),
        })
        .default({ snapshots: [] }),
    })
    .default(() => ({ webhooks: {}, homeassistant: { enabled: true, external_photos: false }, mcp: { snapshots: [] } })),
});

export const ConfigSchema = ConfigBase.superRefine((cfg, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const { vocabulary, attributes } = cfg.analyzers.vlm;

  cfg.outputs.mcp.snapshots.forEach((c, i) => {
    if (!(c in cfg.cameras)) issue(["outputs", "mcp", "snapshots", i], `camera "${c}" is not defined`);
  });

  for (const [name, cam] of Object.entries(cfg.cameras)) {
    const { activity, approach, passages, posture, left_object } = cam.observe;
    if (activity) {
      const path = ["cameras", name, "observe", "activity"];
      activity.rules.forEach((r, i) => {
        if (!(r.then in vocabulary)) issue([...path, "rules", i, "then"], `activity "${r.then}" is not in the vocabulary`);
        for (const a of Object.keys(r.if)) {
          if (!(a in attributes)) issue([...path, "rules", i, "if", a], `question "${a}" is not defined`);
        }
      });
      if (!(activity.default in vocabulary)) issue([...path, "default"], `activity "${activity.default}" is not in the vocabulary`);
      if (activity.fast && !(activity.fast.analyzer in cfg.analyzers.endpoints)) {
        issue([...path, "fast", "analyzer"], `analyzer "${activity.fast.analyzer}" is not defined`);
      }
    }
    if (posture) {
      const path = ["cameras", name, "observe", "posture"];
      if (!(posture.analyzer in cfg.analyzers.endpoints)) issue([...path, "analyzer"], `analyzer "${posture.analyzer}" is not defined`);
      for (const z of posture.rest_zones) if (!(z in cam.zones)) issue([...path, "rest_zones"], `zone "${z}" is not defined on the camera`);
    }
    if (left_object) {
      const path = ["cameras", name, "observe", "left_object"];
      if (!(left_object.zone in cam.zones)) issue([...path, "zone"], `zone "${left_object.zone}" is not defined on the camera`);
      if (!(left_object.analyzer in cfg.analyzers.endpoints)) issue([...path, "analyzer"], `analyzer "${left_object.analyzer}" is not defined`);
    }
    if (approach) {
      const path = ["cameras", name, "observe", "approach"];
      if (!(approach.zone in cam.zones)) issue([...path, "zone"], `zone "${approach.zone}" is not defined on the camera`);
      if (!passages) issue(path, "needs the passages observation too");
    }
  }

  const mains = new Map<string, string>();
  for (const [id, g] of Object.entries(cfg.groups)) {
    const path = ["groups", id];
    if (id in cfg.cameras) issue(path, `"${id}" is already a camera's name`);
    if (!(g.main in cfg.cameras)) issue([...path, "main"], `camera "${g.main}" does not exist`);
    else if (mains.has(g.main)) issue([...path, "main"], `camera "${g.main}" is already the main camera of group "${mains.get(g.main)}"`);
    else mains.set(g.main, id);
    for (const [c, m] of Object.entries(g.members)) {
      const cam = cfg.cameras[c];
      if (!cam) issue([...path, "members", c], `camera "${c}" does not exist`);
      else if (c === g.main) issue([...path, "members", c], "the main camera is not a member too");
      else for (const z of m.zones) if (!(z in cam.zones)) issue([...path, "members", c, "zones"], `zone "${z}" is not defined on the camera`);
    }
  }

  const streams = new Set(Object.entries(cfg.sources).flatMap(([id, x]) => (x.sub ? [id, `${id}_sub`] : [id])));
  if (streams.size) {
    // with sources of its own, a camera's go2rtc stream must be one of them
    for (const [name, cam] of Object.entries(cfg.cameras)) {
      if (cam.stream && "go2rtc" in cam.stream && !streams.has(cam.stream.go2rtc)) {
        issue(["cameras", name, "stream", "go2rtc"], `stream "${cam.stream.go2rtc}" is not among the sources`);
      }
    }
  }
  if (cfg.restream.share && !cfg.restream.address) issue(["restream", "address"], "sharing needs this machine's address");

  const ids = new Set<string>();
  const places = new Set(Object.values(cfg.cameras).map((c) => c.place));
  const zones = new Set(Object.values(cfg.cameras).flatMap((c) => Object.keys(c.zones)));
  cfg.rules.forEach((r, i) => {
    const path = ["rules", i];
    if (ids.has(r.id)) issue([...path, "id"], `duplicate id "${r.id}"`);
    ids.add(r.id);
    for (const c of r.when.cameras ?? []) if (!(c in cfg.cameras)) issue([...path, "when", "cameras"], `camera "${c}" does not exist`);
    for (const p of r.when.places ?? []) if (!places.has(p)) issue([...path, "when", "places"], `place "${p}" has no cameras`);
    if (r.when.zone && !zones.has(r.when.zone)) issue([...path, "when", "zone"], `zone "${r.when.zone}" does not exist`);
    for (const v of [r.when.value ?? []].flat()) {
      if (!(v in vocabulary) && ![...POSTURES, ...OBJECTS].includes(v as never)) issue([...path, "when", "value"], `activity "${v}" is not in the vocabulary`);
    }
    r.then.forEach((x, j) => {
      if (x.react === "webhook" && !(x.to in cfg.outputs.webhooks)) issue([...path, "then", j, "to"], `webhook "${x.to}" is not defined in outputs`);
    });
  });
});

export type Config = z.infer<typeof ConfigSchema>;
export type CameraConfig = Config["cameras"][string];

/** Each group's main camera, by group id. */
export function groupMains(cfg: Config): Record<string, string> {
  return Object.fromEntries(Object.entries(cfg.groups).map(([id, g]) => [id, g.main]));
}

export const TUNING = {
  absence_s: 60,
  track_stale_s: 90,
  inherit_iou: 0.3,
  min_conf: 0.6,
  min_samples: 3,
  enter_ratio: 0.66,
  walk_threshold: 0.08,
  crop_margin: 0.5,
  crop_max_side: 512,
  frigate_import_s: 30,
  activity_poll_s: 15,
};
export const tuningOf = (cfg: Config): typeof TUNING => ({ ...TUNING, ...Object.fromEntries(Object.entries(cfg.tuning ?? {}).filter(([, v]) => v !== undefined)) });

export const LOOK = { memory: false, before_s: 10, after_s: 4 };
export const lookOf = (c: CameraConfig | undefined) => ({
  memory: c?.look?.memory ?? LOOK.memory,
  before_s: c?.look?.before_s ?? LOOK.before_s,
  after_s: c?.look?.after_s ?? LOOK.after_s,
});

/** The group a request is about: a group's id, or a camera that is the main camera of a group. */
export function groupOf(cfg: Config, target: string): { id: string; group: Group } | undefined {
  if (target in cfg.groups) return { id: target, group: cfg.groups[target]! };
  const id = Object.keys(cfg.groups).find((g) => cfg.groups[g]!.main === target);
  return id ? { id, group: cfg.groups[id]! } : undefined;
}

export type Validation = { ok: true; config: Config } | { ok: false; errors: string[] };

export function validate(input: unknown): Validation {
  const r = ConfigSchema.safeParse(migrateConfig(input));
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export type ChangeListener = (next: Config, prev: Config) => void;

/**
 * The current configuration, saved to a file and reloaded on the fly.
 * - Every applied version goes to `config-history/` (for the UI's diff and undo).
 * - A hand edit of the file is validated: when invalid, the previous version stays in force.
 * - The version number always grows: a hand edit without a bump gets one from the service.
 */
export class ConfigStore {
  private cfg: Config;
  private lastWritten = "";
  private listeners: ChangeListener[] = [];
  private watcher?: ReturnType<typeof watch>;
  private readonly historyDir: string;

  constructor(
    readonly path: string,
    seed?: () => unknown,
  ) {
    this.historyDir = resolve(dirname(path), "config-history");
    mkdirSync(this.historyDir, { recursive: true });
    if (!existsSync(path)) {
      if (!seed) throw new Error(`Missing configuration: ${path}`);
      const v = validate(seed());
      if (!v.ok) throw new Error(`Invalid initial configuration:\n${v.errors.join("\n")}`);
      this.cfg = v.config;
      this.write(v.config);
      return;
    }
    const raw = readFileSync(path, "utf8");
    const v = validateRaw(raw);
    if (!v.ok) throw new Error(`${path} is invalid:\n${v.errors.join("\n")}`);
    this.cfg = v.config;
    this.lastWritten = raw;
    // a file with the old Italian names is rewritten once in English, the old one kept aside
    if (isLegacy(raw)) {
      copyFileSync(path, `${path}.before-english`);
      this.write(v.config);
      this.migrated = true;
    }
  }

  /** The file was rewritten from the old Italian names at startup. */
  readonly migrated: boolean = false;

  get current(): Config {
    return this.cfg;
  }

  /** Saved versions, newest first. */
  history(): { file: string; version: number; ts: string }[] {
    return readdirSync(this.historyDir)
      .flatMap((file) => {
        const m = /^v(\d+)-(.+)\.json$/.exec(file);
        // the name has - instead of : (2026-11-07T14-16-43.354Z)
        return m ? [{ file, version: Number(m[1]), ts: m[2]!.replace(/T(\d\d)-(\d\d)-/, "T$1:$2:") }] : [];
      })
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  historyFile(file: string): unknown {
    if (!/^v\d+-[\w.-]+\.json$/.test(file)) throw new Error("invalid version name");
    return JSON.parse(readFileSync(resolve(this.historyDir, file), "utf8"));
  }

  onChange(l: ChangeListener): void {
    this.listeners.push(l);
  }

  /** Validates and applies a new configuration (from the frontend); the store assigns the version. */
  save(input: unknown): Validation {
    const v = validate({ ...(input as object), version: this.cfg.version + 1 });
    if (v.ok) this.apply(v.config);
    return v;
  }

  /** Reloads the file on every outside change (editor, git checkout). */
  watch(onError: (errors: string[]) => void = (e) => console.error(`config.json not applied:\n  ${e.join("\n  ")}`)): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // the folder is watched: editors often save with a rename, which drops a watch on the file
    this.watcher = watch(dirname(this.path), (_ev, file) => {
      if (file !== basename(this.path)) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.reload(onError), 150);
    });
  }

  close(): void {
    this.watcher?.close();
  }

  reload(onError: (errors: string[]) => void): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, "utf8");
    if (raw === this.lastWritten) return;
    const v = validateRaw(raw);
    if (!v.ok) {
      onError(v.errors);
      return;
    }
    const version = Math.max(v.config.version, this.cfg.version + 1);
    this.apply({ ...v.config, version });
  }

  private apply(next: Config): void {
    const prev = this.cfg;
    this.write(next);
    this.cfg = next;
    for (const l of this.listeners) l(next, prev);
  }

  private write(cfg: Config): void {
    const raw = JSON.stringify(cfg, null, 2) + "\n";
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, raw);
    renameSync(tmp, this.path);
    this.lastWritten = raw;
    const stamp = new Date().toISOString().replaceAll(":", "-");
    writeFileSync(resolve(this.historyDir, `v${cfg.version}-${stamp}.json`), raw);
  }
}

function isLegacy(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(migrateConfig(parsed)) !== JSON.stringify(parsed);
  } catch {
    return false;
  }
}

function validateRaw(raw: string): Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${(err as Error).message}`] };
  }
  return validate(parsed);
}
