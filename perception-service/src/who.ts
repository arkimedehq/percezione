import { SURE, type Attempt } from "./people.ts";
import type { ActiveObject } from "./perception.ts";
import { groupOf, type Config } from "./settings.ts";
import type { Sighting } from "./sightings.ts";

/**
 * Who is at one camera right now (docs/people.md, S2c): the people Frigate is tracking there, by name when it
 * recognized them, how many without a name, and the faces it could not name in the last minutes. The same answer
 * goes to agents (MCP), the frontend (API) and Home Assistant (MQTT), without images unless asked (S8d).
 * Asked about a group (or its main camera), people are counted on the main camera and the other cameras add the names
 * they recognized in their zones in the last `window_s` (`seen_by`): someone with their back to the main camera may
 * have faced another camera of the group on the way.
 */
export interface WhoAt {
  /** the camera people are counted on: the main camera of a group */
  camera: string;
  /** asked about a group: its id and all its cameras */
  group?: { id: string; label: string; cameras: string[] };
  place: string;
  /** ISO, when the answer was made */
  time: string;
  people: WhoPerson[];
  /** people in view with no name (yet) */
  unrecognized: number;
  /** faces seen on the camera recently that face recognition could not name, newest first */
  unknown_faces: { file: string; time: string; guess: string | null; score: number }[];
  /** asked with pictures (S8d): the people without a name on the main camera, each with their best face */
  unknown_people?: ({ camera: string } & Pictures)[];
}

/** Pictures of a person (S8d), files of the external events' folder: the frame of their best face and the face. */
export interface Pictures {
  photo?: string;
  face?: string;
}

export interface WhoPerson {
  name: string;
  confidence: number | null;
  /** not on the main camera now: recognized by this other camera of the group, at seen_at (ISO) */
  seen_by?: string;
  seen_at?: string;
  /** asked with pictures */
  photo?: string;
  face?: string;
}

/** How far back a face counts as "now". */
export const RECENT_FACES_MS = 120_000;

export interface WhoDeps {
  config(): Config;
  /** Frigate's objects in view, as last reported (camera_activity) */
  active(): ActiveObject[];
  /** Frigate's recent recognition attempts */
  attempts(): Promise<Attempt[]>;
  /** the camera of a Frigate track (src/track-log.ts) */
  trackCamera(id: string): string | undefined;
  /** names recognized recently on a camera (src/sightings.ts) */
  sightings?(camera: string, zones: string[], since: number): Sighting[];
  now?: () => Date;
}

/** Who is at a camera or a group (by its id, or its main camera). */
export async function whoIsAt(target: string, d: WhoDeps): Promise<WhoAt> {
  const cfg = d.config();
  const now = d.now?.() ?? new Date();
  const g = groupOf(cfg, target);
  const camera = g ? g.group.main : target;
  const cameras = g ? [camera, ...Object.keys(g.group.members)] : [camera];
  const people = new Map<string, number | null>();
  let unrecognized = 0;
  const here = d.active().filter((o) => o.camera === camera && o.label === "person");
  for (const o of here) {
    const [name, score] = Array.isArray(o.sub_label) ? o.sub_label : [o.sub_label, null];
    const prev = people.get(name ?? "");
    if (name) people.set(name, score === null ? (prev ?? null) : Math.max(prev ?? 0, score));
    else unrecognized++;
  }
  const named: WhoPerson[] = [...people].map(([name, confidence]) => ({ name, confidence }));
  if (g && d.sightings) {
    const since = now.getTime() - g.group.window_s * 1000;
    const others = Object.entries(g.group.members)
      .flatMap(([c, m]) => d.sightings!(c, m.zones, since))
      .filter((x) => !people.has(x.name))
      .sort((a, b) => b.at - a.at);
    for (const x of others) {
      if (named.some((p) => p.name === x.name)) continue;
      named.push({ name: x.name, confidence: x.confidence, seen_by: x.camera, seen_at: new Date(x.at).toISOString() });
    }
  }
  const tracks = new Set(d.active().filter((o) => cameras.includes(o.camera) && o.label === "person").map((o) => o.id));
  const since = now.getTime() - RECENT_FACES_MS;
  // attempts of tracks on these cameras (still in view, or logged), recent, not already a recognition
  const faces = (await d.attempts().catch(() => []))
    .filter((a) => a.ts * 1000 >= since && (tracks.has(a.event) || cameras.includes(d.trackCamera(a.event) ?? "")) && !(a.name && a.score >= SURE))
    .sort((a, b) => b.ts - a.ts)
    .map((a) => ({ file: a.file, time: new Date(a.ts * 1000).toISOString(), guess: a.name, score: a.score }));
  return {
    camera,
    ...(g ? { group: { id: g.id, label: g.group.label ?? g.id, cameras } } : {}),
    place: cfg.cameras[camera]?.place ?? camera,
    time: now.toISOString(),
    people: named,
    unrecognized,
    unknown_faces: faces,
  };
}

export const WHO_TOPIC = { request: "perception/who/request", result: "perception/who/result" };

/**
 * An MQTT request: {"camera": "…", "id": "…"} (the id comes back with the answer), or just the camera's name; a group's
 * id goes in "camera" too. `cameras` lists both. `"photos": true` adds each person's best face (S8d).
 */
export function whoRequest(payload: string, cameras: string[]): { camera: string; id: string | null; photos: boolean } | { id: string | null; error: string } {
  let camera = payload.trim();
  let id: string | null = null;
  let photos = false;
  try {
    const p = JSON.parse(payload) as { camera?: unknown; id?: unknown; photos?: unknown };
    if (typeof p === "object" && p) {
      camera = typeof p.camera === "string" ? p.camera : "";
      id = typeof p.id === "string" ? p.id : null;
      photos = p.photos === true;
    }
  } catch {
    // a bare camera name
  }
  return cameras.includes(camera) ? { camera, id, photos } : { id, error: `unknown camera "${camera}"` };
}
