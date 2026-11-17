import { randomUUID } from "node:crypto";
import type { Observation } from "./events.ts";
import type { FrigateEvent } from "./frigate.ts";
import { passes } from "./perception.ts";

interface OutdoorTrack {
  camera: string;
  startMs: number;
  lastSeen: number;
  group: Group;
}

/** A passage: the tracks of the same person on the outdoor cameras (at most one per camera). */
interface Group {
  tracks: Map<string, string>; // Frigate track id → camera
  live: number;
  name: string | null;
  score: number | null;
  startMs: number;
  endMs: number;
  approached: boolean;
}

export interface OutdoorDeps {
  now(): number;
  emit(o: Observation): void;
  /** minimum face score for a name on this camera; default none */
  minFaceScore?(camera: string): number | undefined;
}

export interface OutdoorParams {
  /** the group's cameras: here anyone is followed, even without a name */
  cameras: Set<string>;
  /** camera → Frigate zone in front of the entrance (only cameras with the approach observation) */
  zones: Map<string, string>;
  trackStaleMs: number;
  /** a track on another outdoor camera starting within this time from the group's end is the same person */
  mergeGapMs: number;
}

/**
 * Who passes by outdoors or comes close, recognized or not (a group of outdoor cameras: one instance per group).
 * - The cameras of a group frame the same stretch, e.g. from opposite sides: a track that starts on one camera while
 *   the person is still visible on the other, or within `mergeGapMs` from leaving it, is the same passage.
 *   Two people together on the same camera stay separate (one track per camera per group); two people
 *   on different cameras at the same moment are merged instead.
 * - `approach`: as soon as a track of the group enters the camera's approach zone (once per group);
 * - `passage`: `mergeGapMs` after the end of the group's last track, with cameras, total duration and whether
 *   the person came close.
 * `person` is the name if Frigate recognized it on any camera of the group, otherwise null.
 * The service stores no images: the picture is Frigate's snapshot for `media.frigate_ids` (on for the outdoor cameras, 7 days).
 */
export class Outdoor {
  private tracks = new Map<string, OutdoorTrack>();
  private groups = new Set<Group>();

  constructor(
    private p: OutdoorParams,
    private readonly deps: OutdoorDeps,
  ) {}

  /** New params, live: passages in progress go on. */
  configure(p: OutdoorParams): void {
    this.p = p;
  }

  handleEvent(ev: FrigateEvent): void {
    const o = ev.after;
    if (o.label !== "person" || o.false_positive || !this.p.cameras.has(o.camera)) return;

    let t = this.tracks.get(o.id);
    if (!t) {
      const startMs = o.start_time * 1000;
      const group = this.groupFor(o.camera, startMs);
      group.tracks.set(o.id, o.camera);
      group.live++;
      group.startMs = Math.min(group.startMs, startMs);
      t = { camera: o.camera, startMs, lastSeen: 0, group };
      this.tracks.set(o.id, t);
    }
    t.lastSeen = this.deps.now();
    if (o.sub_label && passes(o.sub_label[1], this.deps.minFaceScore?.(o.camera))) {
      t.group.name = o.sub_label[0];
      t.group.score = o.sub_label[1];
    }

    const zone = this.p.zones.get(o.camera);
    const zones = [...(o.current_zones ?? []), ...(o.entered_zones ?? [])];
    if (zone && !t.group.approached && zones.includes(zone)) {
      t.group.approached = true;
      this.emit("approach", t.group, { camera: t.camera, media: { frigate_ids: [o.id] }, zone });
    }

    if (ev.type === "end") this.close(o.id, o.end_time ? o.end_time * 1000 : this.deps.now());
  }

  /** Tracks without `end` (message lost) closed after `trackStaleMs`; finished passages emitted. */
  sweepStale(): void {
    const now = this.deps.now();
    for (const [id, t] of [...this.tracks]) if (t.lastSeen < now - this.p.trackStaleMs) this.close(id, t.lastSeen);
    for (const g of [...this.groups]) {
      if (g.live > 0 || now - g.endMs < this.p.mergeGapMs) continue;
      this.groups.delete(g);
      const cameras = [...new Set(g.tracks.values())];
      this.emit("passage", g, {
        camera: cameras[0]!,
        cameras,
        media: { frigate_ids: [...g.tracks.keys()] },
        duration_s: Math.max(0, Math.round((g.endMs - g.startMs) / 1000)),
        approached: g.approached,
      });
    }
  }

  /** The most recent open group without a track on this camera, otherwise a new one. */
  private groupFor(camera: string, startMs: number): Group {
    const open = [...this.groups]
      .filter((g) => (g.live > 0 || startMs - g.endMs <= this.p.mergeGapMs) && ![...g.tracks.values()].includes(camera))
      .sort((a, b) => b.endMs - a.endMs)[0];
    if (open) return open;
    const g: Group = { tracks: new Map(), live: 0, name: null, score: null, startMs, endMs: startMs, approached: false };
    this.groups.add(g);
    return g;
  }

  private close(id: string, endMs: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    this.tracks.delete(id);
    t.group.live--;
    t.group.endMs = Math.max(t.group.endMs, endMs);
  }

  private emit(type: "passage" | "approach", g: Group, extra: Pick<Observation, "camera" | "media"> & Partial<Observation>): void {
    this.deps.emit({
      event_id: randomUUID(),
      ts: new Date(this.deps.now()).toISOString(),
      type,
      person: g.name ? { name: g.name, confidence: g.score, source: "face" } : null,
      ...extra,
    });
  }
}
