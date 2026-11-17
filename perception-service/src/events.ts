import type { Config, EventType, Importance } from "./settings.ts";
import { evaluateRules, type AppliedReaction } from "./rules.ts";

/** Event schema v3 (docs/events.md): English fields and text; the frontend translates from the fields. */
export const SCHEMA_VERSION = 3;

export type { EventType };

export interface Person {
  name: string;
  /** Frigate's face score; null when unknown (e.g. a track rebuilt without a score) */
  confidence: number | null;
  /** "inherited": the name comes from a track that just ended in the same position, not from the face */
  source: "face" | "inherited";
  /** external: not at the main camera, recognized on the way by this other camera of the group */
  seen_by?: string;
  /** external on a group: the frame where the face was seen best, and the face (/api/external/<file>) */
  photo?: string;
  face?: string;
}

/** What an observer produces. `finalize` adds place, text, reactions and importance. */
export interface Observation {
  event_id: string;
  ts: string;
  type: EventType;
  camera: string;
  /** passage: every camera of the group the person was seen on; external: the cameras of the request's group */
  cameras?: string[];
  /** null: not recognized */
  person: Person | null;
  /** activity_changed, posture_changed; object_left: the object; external: the kind (from is null) */
  value?: { from: string | null; to: string };
  /** left: the last activity */
  activity?: string | null;
  /** approach: the Frigate zone the person entered; object_left: the watched zone */
  zone?: string;
  /** passage: total duration and whether the person entered the entrance zone */
  duration_s?: number;
  approached?: boolean;
  /** object_left: CLIP score and its rise from the "before" crop, box in the frame, how many people passed by,
   *  before/after pictures (label in value.to) */
  object?: { score: number; rise: number; box: [number, number, number, number]; passersby: number; images: { before: string; after: string } };
  /** arrived: Frigate frame → emission; activity_changed: first agreeing sample → emission */
  latency_ms?: number;
  /** external: everyone recognized (person is the first) and how many more were in view without a name */
  people?: Person[];
  unrecognized?: number;
  /** external on a group: the pictures of the people in view on the main camera without a name */
  unknown_people?: { camera: string; photo?: string; face?: string }[];
  /** external (the kind is in value.to): the caller's request id, the device and its name */
  external?: { request_id: string | null; source?: string; label?: string };
  /** external: the best face's frame, or the moment of the request, kept by the service (/api/external/<image>) */
  image?: string;
  /** related Frigate events (snapshots and clips in Frigate) */
  media: { frigate_ids: string[] };
}

export interface PerceptionEvent extends Observation {
  schema_version: typeof SCHEMA_VERSION;
  place: string;
  /** a ready English sentence, without gender (we do not know who it is) */
  text: string;
  reactions: AppliedReaction[];
  importance: Importance;
}

/** Messages pushed to the frontend over the /api/ws WebSocket. */
export type Broadcast =
  | { type: "event"; event: PerceptionEvent }
  | { type: "config"; version: number }
  | { type: "sync"; level: "info" | "error"; message: string };

const label = (s: string | null | undefined) => (s ?? "—").replaceAll("_", " ");

type Describable = Pick<Observation, "type" | "camera" | "cameras" | "zone" | "duration_s" | "approached" | "activity" | "people" | "unrecognized" | "external"> & {
  person?: { name: string } | null;
  value?: { from: string | null; to: string };
  object?: { passersby: number };
  place?: string;
};

export function describe(o: Describable, place = o.place ?? o.camera): string {
  const who = o.person?.name ?? "Unknown person";
  switch (o.type) {
    case "arrived":
      return `${who} arrived in ${label(place)}`;
    case "left":
      return `${who} left ${label(place)}`;
    case "activity_changed":
    case "posture_changed":
      return `${who} in ${label(place)}: ${label(o.value?.to)}`;
    case "approach":
      return `${who} at the entrance`;
    case "object_left": {
      const after = o.person ? `, after ${who} passed by` : o.object?.passersby ? ", after an unknown person passed by" : "";
      return `Object left in ${label(o.zone)}: ${label(o.value?.to)}${after}`;
    }
    case "external": {
      const what = o.external?.label ?? label(o.value?.to);
      const people: { name: string; seen_by?: string }[] = o.people ?? (o.person ? [o.person] : []);
      const names = people.map((p) => (p.seen_by ? `${p.name} (seen by ${label(p.seen_by)})` : p.name));
      const unknown = o.unrecognized ?? 0;
      if (unknown) names.push(unknown === 1 ? "an unknown person" : `${unknown} unknown people`);
      const who = names.length ? names.join(", ").replace(/, ([^,]*)$/, " and $1") : "nobody in view";
      return `${what} at ${label(place)}: ${who}`;
    }
    case "passage": {
      const cameras = (o.cameras ?? [o.camera]).map(label).join(" and ");
      return `${who} passed by (${cameras}, ${o.duration_s ?? 0} s${o.approached ? ", came close" : ""})`;
    }
  }
}

/** Completes an observation with the configuration in force right now. */
export function finalize(o: Observation, cfg: Config, now = new Date(o.ts)): PerceptionEvent {
  const place = cfg.cameras[o.camera]?.place ?? o.camera;
  const base = { ...o, schema_version: SCHEMA_VERSION as typeof SCHEMA_VERSION, place, text: describe(o, place) };
  return { ...base, ...evaluateRules(base, cfg.rules, now) };
}
