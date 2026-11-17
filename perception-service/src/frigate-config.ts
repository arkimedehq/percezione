import { parse } from "yaml";
import type { CameraConfig, Config, Stream, Zone } from "./settings.ts";

/**
 * Mapping between the cameras of `data/config.json` and those of Frigate's YAML.
 * Only on/off, stream, detect, zones, motion masks, snapshots and the smallest face are managed per camera, and three
 * global face recognition settings: the rest of the YAML (detector, record, review…) stays Frigate's. Comparison always happens in our canonical form, so a change just sent
 * does not come back as a difference to import.
 */

export const SECTIONS = ["enabled", "ffmpeg", "detect", "zones", "motion", "snapshots", "face_recognition"] as const;
export type Section = (typeof SECTIONS)[number];

export const DEFAULT_INPUT_ARGS = "preset-rtsp-restream";

type Coords = string | string[] | number[];

/** Camera as it is in Frigate's YAML (only the fields we manage). */
export interface RawCamera {
  enabled?: boolean;
  ffmpeg?: { inputs?: { path: string; input_args?: string; roles?: string[] }[]; hwaccel_args?: string | string[] };
  detect?: { enabled?: boolean; width?: number; height?: number; fps?: number };
  zones?: Record<string, { coordinates: Coords; objects?: string | string[]; inertia?: number; loitering_time?: number }> | null;
  motion?: { mask?: Record<string, { coordinates: Coords }> | string | string[] | null };
  snapshots?: { enabled?: boolean; retain?: { default?: number } };
  face_recognition?: { enabled?: boolean; min_area?: number };
}

export interface RawConfig {
  cameras: Record<string, RawCamera>;
  face_recognition?: Record<string, unknown>;
}

/** Frigate's global face recognition settings managed from Percezione's UI (src/settings.ts `faces`). */
export const FACE_FIELDS = ["recognition_threshold", "unknown_score", "save_attempts"] as const;
export type Faces = Partial<Record<(typeof FACE_FIELDS)[number], number>>;

export function facesOf(raw: RawConfig): Faces {
  const f = raw.face_recognition ?? {};
  return Object.fromEntries(FACE_FIELDS.filter((k) => typeof f[k] === "number").map((k) => [k, f[k] as number]));
}

export const sameFaces = (a: Faces | undefined, b: Faces | undefined) => stable(a ?? {}) === stable(b ?? {});

/** `GET /api/config/raw` answers with the YAML as a JSON string. */
export function parseRaw(body: string): RawConfig {
  const text = body.startsWith('"') ? (JSON.parse(body) as string) : body;
  const cfg = (parse(text) ?? {}) as Partial<RawConfig>;
  return { cameras: cfg.cameras ?? {}, ...(cfg.face_recognition ? { face_recognition: cfg.face_recognition } : {}) };
}

type Point = [number, number];

/** The part of a camera that also lives in Frigate. */
export interface Managed {
  /** missing means on, as in Frigate */
  enabled?: boolean;
  stream?: Stream;
  /** this camera decoded on the CPU (Frigate: an empty hwaccel_args on the camera) */
  decode?: "cpu";
  /** `off` only comes from Frigate: detection off there (its default), which we always want on */
  detect?: { width: number; height: number; fps: number; off?: true };
  snapshots?: { enabled: boolean; retain_days?: number };
  /** smallest face Frigate tries to recognize, px² (missing: Frigate's global) */
  face_min_area?: number;
  zones: Record<string, Zone>;
  masks: Record<string, Point[]>;
}

export function managedOf(c: CameraConfig): Managed {
  return { enabled: c.enabled, stream: c.stream, decode: c.decode === "cpu" ? "cpu" : undefined, detect: c.detect, snapshots: c.snapshots, face_min_area: c.face_min_area, zones: c.zones, masks: c.masks };
}

/** Frigate's YAML in our form. `go2rtcBase` (e.g. rtsp://192.0.2.134:8554) recognizes go2rtc streams. */
export function fromFrigate(raw: RawCamera, go2rtcBase?: string): Managed {
  const input = raw.ffmpeg?.inputs?.find((i) => i.roles?.includes("detect")) ?? raw.ffmpeg?.inputs?.[0];
  const m: Managed = { zones: {}, masks: {} };
  if (raw.enabled !== undefined) m.enabled = raw.enabled;
  const hw = raw.ffmpeg?.hwaccel_args;
  if (hw !== undefined && [hw].flat().join("").trim() === "") m.decode = "cpu";
  if (input) {
    const path = String(input.path).trim();
    const args = input.input_args && input.input_args !== DEFAULT_INPUT_ARGS ? { input_args: input.input_args } : {};
    const prefix = go2rtcBase ? `${go2rtcBase.replace(/\/$/, "")}/` : undefined;
    m.stream = prefix && path.startsWith(prefix) ? { go2rtc: path.slice(prefix.length), ...args } : { rtsp: path, ...args };
  }
  const d = raw.detect;
  if (d?.width && d.height && d.fps) m.detect = { width: d.width, height: d.height, fps: d.fps, ...(d.enabled ? {} : { off: true as const }) };
  if (raw.snapshots?.enabled !== undefined) {
    m.snapshots = { enabled: raw.snapshots.enabled };
    if (raw.snapshots.retain?.default !== undefined) m.snapshots.retain_days = raw.snapshots.retain.default;
  }
  if (typeof raw.face_recognition?.min_area === "number") m.face_min_area = raw.face_recognition.min_area;
  for (const [name, z] of Object.entries(raw.zones ?? {})) {
    const zone: Zone = { points: points(z.coordinates) };
    if (z.objects !== undefined) zone.objects = [z.objects].flat();
    if (z.inertia !== undefined) zone.inertia = z.inertia;
    if (z.loitering_time !== undefined) zone.loitering_time = z.loitering_time;
    m.zones[name] = zone;
  }
  const mask = raw.motion?.mask;
  if (typeof mask === "string" || Array.isArray(mask)) {
    [mask].flat().forEach((c, i) => (m.masks[`mask_${i + 1}`] = points(c)));
  } else if (mask) {
    for (const [name, v] of Object.entries(mask)) m.masks[name] = points(v.coordinates);
  }
  return m;
}

/** Frigate relative coordinates ("x1,y1,x2,y2,…") → points. */
export function points(c: Coords): Point[] {
  const nums = (Array.isArray(c) ? c.join(",") : String(c)).split(",").map(Number);
  const out: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([round(nums[i]!), round(nums[i + 1]!)]);
  return out;
}

const coords = (p: Point[]) => p.map(([x, y]) => `${round(x)},${round(y)}`).join(",");
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Canonical form of a section: two values equal for Frigate give the same string. */
function canon(m: Managed, s: Section): string | undefined {
  switch (s) {
    case "enabled":
      return String(m.enabled ?? true);
    case "ffmpeg":
      if (!m.stream) return undefined;
      return stable({ ...m.stream, input_args: m.stream.input_args ?? DEFAULT_INPUT_ARGS, decode: m.decode });
    case "detect":
      return m.detect && stable(m.detect);
    case "snapshots":
      return m.snapshots && stable(m.snapshots);
    case "face_recognition":
      // always defined: clearing it gives the camera Frigate's global back
      return String(m.face_min_area ?? "");
    case "zones":
      return stable(Object.fromEntries(Object.entries(m.zones).map(([n, z]) => [n, { ...z, points: coords(z.points) }])));
    case "motion":
      return stable(Object.fromEntries(Object.entries(m.masks).map(([n, p]) => [n, coords(p)])));
  }
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort()) : x,
  );
}

export function sameSection(a: Managed, b: Managed, s: Section): boolean {
  return canon(a, s) === canon(b, s);
}

export function streamPath(s: Stream, go2rtcBase?: string): string {
  if ("rtsp" in s) return s.rtsp;
  if (!go2rtcBase) throw new Error(`go2rtc stream "${s.go2rtc}" but GO2RTC_RTSP_URL is not set`);
  return `${go2rtcBase.replace(/\/$/, "")}/${s.go2rtc}`;
}

const ZONE_FIELDS = ["objects", "inertia", "loitering_time"] as const;

/**
 * A section's `config_data` for `PUT /api/config/set`. Frigate merges the fields into the YAML: whatever must go
 * (zone, mask or zone field) is sent as null.
 */
export function sectionData(s: Section, want: Managed, have: Managed | undefined, go2rtcBase?: string): Record<string, unknown> {
  switch (s) {
    case "enabled":
      return { enabled: want.enabled ?? true };
    case "ffmpeg":
      return {
        ffmpeg: {
          inputs: [{ path: streamPath(want.stream!, go2rtcBase), input_args: want.stream!.input_args ?? DEFAULT_INPUT_ARGS, roles: ["detect"] }],
          // a blank value (Frigate takes "" as unset) turns hardware decoding off for this camera; null gives it back
          // the global setting, sent only when the camera had its own
          ...(want.decode === "cpu" ? { hwaccel_args: " " } : have?.decode ? { hwaccel_args: null } : {}),
        },
      };
    case "detect": {
      // Frigate leaves detection off unless it is written: a camera without it streams but never sees anyone
      const { off: _off, ...size } = want.detect!;
      return { detect: { enabled: true, ...size } };
    }
    case "snapshots":
      return {
        snapshots: {
          enabled: want.snapshots!.enabled,
          ...(want.snapshots!.retain_days !== undefined ? { retain: { default: want.snapshots!.retain_days } } : {}),
        },
      };
    case "face_recognition":
      return { face_recognition: { min_area: want.face_min_area ?? null } };
    case "zones": {
      const zones: Record<string, unknown> = {};
      for (const name of new Set([...Object.keys(want.zones), ...Object.keys(have?.zones ?? {})])) {
        const w = want.zones[name];
        const h = have?.zones[name];
        if (!w) {
          zones[name] = null;
          continue;
        }
        const z: Record<string, unknown> = { coordinates: coords(w.points) };
        for (const f of ZONE_FIELDS) {
          if (w[f] !== undefined) z[f] = w[f];
          else if (h?.[f] !== undefined) z[f] = null;
        }
        zones[name] = z;
      }
      return { zones };
    }
    case "motion": {
      const mask: Record<string, unknown> = {};
      for (const name of new Set([...Object.keys(want.masks), ...Object.keys(have?.masks ?? {})])) {
        const w = want.masks[name];
        if (!w) mask[name] = null;
        // the friendly name is given only to new masks: the one chosen in Frigate's UI stays
        else mask[name] = have?.masks[name] ? { coordinates: coords(w) } : { friendly_name: name, coordinates: coords(w) };
      }
      return { motion: { mask } };
    }
  }
}

/** Full camera for adding: stream and detect are required. */
export function cameraData(want: Managed, go2rtcBase?: string): Record<string, unknown> {
  if (!want.stream || !want.detect) throw new Error("adding it to Frigate needs stream and detect");
  const data: Record<string, unknown> = {
    ...sectionData("ffmpeg", want, undefined, go2rtcBase),
    ...sectionData("detect", want, undefined),
    // no images on the broker: metadata only
    mqtt: { enabled: false },
  };
  if (want.enabled === false) data.enabled = false;
  if (Object.keys(want.zones).length) Object.assign(data, sectionData("zones", want, undefined));
  if (Object.keys(want.masks).length) Object.assign(data, sectionData("motion", want, undefined));
  if (want.snapshots) Object.assign(data, sectionData("snapshots", want, undefined));
  if (want.face_min_area !== undefined) Object.assign(data, sectionData("face_recognition", want, undefined));
  return data;
}

export type Op =
  | { kind: "add"; camera: string; data: Record<string, unknown> }
  | { kind: "remove"; camera: string }
  | { kind: "section"; camera: string; section: Section; data: Record<string, unknown> }
  /** global face recognition settings: the changed fields, null to remove */
  | { kind: "faces"; data: Record<string, number | null> };

export function describeOp(op: Op): string {
  return op.kind === "faces" ? "face_recognition" : op.kind === "section" ? `${op.camera}/${op.section}` : `${op.camera}/${op.kind}`;
}

/**
 * What to send to Frigate after a config change `prev` → `next`. Only sections changed by us and still
 * different from Frigate are sent: a change made in Frigate's UI and not imported yet is not
 * overwritten by a change of ours about something else.
 */
export function planPush(prev: Config, next: Config, frigate: RawConfig, go2rtcBase?: string): { ops: Op[]; errors: string[] } {
  const ops: Op[] = [];
  const errors: string[] = [];
  for (const [name, cam] of Object.entries(next.cameras)) {
    const want = managedOf(cam);
    const before = prev.cameras[name] && managedOf(prev.cameras[name]);
    const raw = frigate.cameras[name];
    if (!raw) {
      if (before) continue; // removed from Frigate: the import picks it up
      try {
        ops.push({ kind: "add", camera: name, data: cameraData(want, go2rtcBase) });
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
      }
      continue;
    }
    const have = fromFrigate(raw, go2rtcBase);
    for (const s of SECTIONS) {
      // detection off in Frigate is never a choice of ours: any push turns it back on
      if (before && sameSection(before, want, s) && !(s === "detect" && have.detect?.off)) continue;
      if (sameSection(want, have, s) || canon(want, s) === undefined) continue;
      try {
        ops.push({ kind: "section", camera: name, section: s, data: sectionData(s, want, have, go2rtcBase) });
      } catch (err) {
        errors.push(`${name}/${s}: ${(err as Error).message}`);
      }
    }
  }
  for (const name of Object.keys(prev.cameras)) {
    if (!(name in next.cameras) && name in frigate.cameras) ops.push({ kind: "remove", camera: name });
  }
  const have = facesOf(frigate);
  if (!sameFaces(prev.faces, next.faces) && !sameFaces(next.faces, have)) {
    const want = next.faces ?? {};
    ops.push({ kind: "faces", data: Object.fromEntries(FACE_FIELDS.filter((k) => want[k] !== have[k]).map((k) => [k, want[k] ?? null])) });
  }
  return { ops, errors };
}

/**
 * Changes made in Frigate's UI to bring back into the configuration (decision B, until the P3 frontend).
 * Stream, detect and snapshots missing in Frigate do not delete ours; zones and masks do. Detection off in Frigate is
 * not imported: the next push turns it on.
 */
export function planImport(cfg: Config, frigate: RawConfig, go2rtcBase?: string): { next: Config; changes: string[] } {
  const next = structuredClone(cfg);
  const changes: string[] = [];
  for (const [name, raw] of Object.entries(frigate.cameras)) {
    const have = fromFrigate(raw, go2rtcBase);
    if (have.detect) delete have.detect.off;
    const cam = next.cameras[name];
    if (!cam) {
      next.cameras[name] = { place: name, kind: "indoor", observe: {}, ...have };
      changes.push(`${name}: new camera`);
      continue;
    }
    const ours = managedOf(cam);
    for (const s of SECTIONS) {
      if (canon(have, s) === undefined || sameSection(ours, have, s)) continue;
      changes.push(`${name}/${s}`);
      if (s === "enabled") cam.enabled = have.enabled;
      else if (s === "ffmpeg") {
        cam.stream = have.stream;
        if (have.decode) cam.decode = have.decode;
        else delete cam.decode;
      }
      else if (s === "detect") cam.detect = have.detect;
      else if (s === "snapshots") cam.snapshots = have.snapshots;
      else if (s === "face_recognition") {
        if (have.face_min_area !== undefined) cam.face_min_area = have.face_min_area;
        else delete cam.face_min_area;
      }
      else if (s === "zones") cam.zones = have.zones;
      else cam.masks = have.masks;
    }
  }
  for (const name of Object.keys(cfg.cameras)) {
    if (!(name in frigate.cameras)) {
      delete next.cameras[name];
      changes.push(`${name}: removed from Frigate`);
    }
  }
  const faces = facesOf(frigate);
  if (!sameFaces(cfg.faces, faces)) {
    next.faces = faces;
    changes.push("face_recognition");
  }
  return { next, changes };
}
