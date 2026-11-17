import { randomUUID } from "node:crypto";
import { ActivityStateMachine, type ActivityParams, type Sample } from "./activity.ts";
import type { Observation, Person as PersonInfo } from "./events.ts";
import type { FrigateEvent } from "./frigate.ts";

export type Box = [number, number, number, number];

/** Active object as Frigate's WebSocket reports it (`camera_activity`): no box. */
export interface ActiveObject {
  id: string;
  camera: string;
  label: string;
  sub_label: string | [string, number] | null;
}

interface Track {
  id: string;
  camera: string;
  name: string | null;
  inherited: boolean;
  /** face score with which Frigate assigned the name */
  score: number | null;
  box: Box | null;
  lastSeen: number;
}

interface EndedTrack {
  name: string;
  camera: string;
  box: Box | null;
  endedAt: number;
}

interface Person {
  name: string;
  room: string;
  person: PersonInfo;
  lastTrackId: string;
  trackIds: Set<string>;
  sm: ActivityStateMachine;
  leftTimer?: ReturnType<typeof setTimeout>;
}

export interface PerceptionDeps {
  now(): number;
  emit(o: Observation): void;
  onArrived?(name: string): void;
  /** cameras with the presence observation (read on every event: changes live); default all */
  observes?(camera: string): boolean;
  /** activity debounce window per camera; default `stableMs` */
  stableMsFor?(camera: string): number | undefined;
  /** minimum face score for a new name on this camera; default none */
  minFaceScore?(camera: string): number | undefined;
}

export interface PerceptionParams extends ActivityParams {
  absenceMs: number;
  trackStaleMs: number;
  /** minimum IoU between the box of a closed track and that of a new unnamed track to inherit its name */
  inheritIou: number;
}

/** A face score is enough when the camera has no minimum, or when it is known and reaches it. */
export function passes(score: number | null, min: number | undefined): boolean {
  return min === undefined || (score !== null && score >= min);
}

/**
 * Identity and presence from frigate/events.
 * - The name comes from `sub_label` and stays bound to the track until `end`, even without a face.
 * - When a person's last track ends an absence timer starts: a new track with the
 *   same name within `absenceMs` is a return (no event), otherwise `left` is emitted.
 * - Frigate sometimes splits the track of a still person: the new track starts without a name
 *   (face in profile). If it overlaps the box of a named track just closed on the same
 *   camera, it inherits its name, until Frigate assigns a different `sub_label`.
 */
export class Perception {
  private tracks = new Map<string, Track>();
  private persons = new Map<string, Person>();
  private ended: EndedTrack[] = [];

  constructor(
    private readonly p: PerceptionParams,
    private readonly deps: PerceptionDeps,
  ) {}

  handleEvent(ev: FrigateEvent): void {
    const o = ev.after;
    if (o.label !== "person" || o.false_positive) return;
    if (ev.type !== "end" && !this.observes(o.camera)) return;

    if (ev.type === "end") {
      this.endTrack(o.id);
      return;
    }

    const t = this.upsertTrack(o.id, o.camera);
    t.box = o.box;
    this.applyName(t, o.sub_label?.[0] ?? null, o.sub_label?.[1] ?? null, o.frame_time * 1000);
    if (!t.name) this.tryInherit(t);
  }

  /**
   * Current state from `camera_activity` of Frigate's WebSocket: at startup it rebuilds the tracks
   * already in progress (Frigate does not republish the events of a still person) and keeps tracks alive.
   */
  syncActive(objects: ActiveObject[]): void {
    for (const o of objects) {
      if (o.label !== "person" || !this.observes(o.camera)) continue;
      const t = this.upsertTrack(o.id, o.camera);
      const [name, score] = Array.isArray(o.sub_label) ? o.sub_label : [o.sub_label, null];
      this.applyName(t, name, score, this.deps.now());
    }
  }

  private upsertTrack(id: string, camera: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { id, camera, name: null, inherited: false, score: null, box: null, lastSeen: 0 };
      this.tracks.set(id, t);
    }
    t.camera = camera;
    t.lastSeen = this.deps.now();
    return t;
  }

  private observes(camera: string): boolean {
    return this.deps.observes?.(camera) ?? true;
  }

  private applyName(t: Track, name: string | null, score: number | null, frameTimeMs: number): void {
    if (!name) return;
    if (name === t.name) {
      if (score !== null) t.score = score;
      return;
    }
    if (!passes(score, this.deps.minFaceScore?.(t.camera))) return;
    if (t.name) this.unbind(t);
    t.name = name;
    t.inherited = false;
    t.score = score;
    this.bind(t, frameTimeMs);
  }

  private tryInherit(t: Track): void {
    if (!t.box) return;
    const now = this.deps.now();
    this.ended = this.ended.filter((e) => now - e.endedAt <= this.p.absenceMs);
    const candidates = this.ended.filter(
      (e) =>
        e.camera === t.camera &&
        e.box !== null &&
        iou(e.box, t.box!) >= this.p.inheritIou &&
        // the person must not already have another live track
        (this.persons.get(e.name)?.trackIds.size ?? 0) === 0,
    );
    const names = new Set(candidates.map((c) => c.name));
    if (names.size !== 1) return;
    const name = [...names][0]!;
    this.ended = this.ended.filter((e) => e.name !== name);
    t.name = name;
    t.inherited = true;
    t.score = null;
    this.bind(t, now);
  }

  /** People present with at least one live track: these are the ones to sample. */
  present(): Array<{ name: string; room: string; box: Box | null; person: PersonInfo; trackId: string; activity: string | null }> {
    const out = [];
    for (const person of this.persons.values()) {
      const live = [...person.trackIds].map((id) => this.tracks.get(id)).filter((t) => t !== undefined);
      const latest = live.sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (latest) {
        out.push({ name: person.name, room: latest.camera, box: latest.box, person: person.person, trackId: latest.id, activity: person.sm.current });
      }
    }
    return out;
  }

  /** Live tracks without a name, per camera: people in view that face recognition has not named (yet). */
  unnamed(): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of this.tracks.values()) if (!t.name) out.set(t.camera, (out.get(t.camera) ?? 0) + 1);
    return out;
  }

  addSample(name: string, sample: Sample): void {
    const person = this.persons.get(name);
    if (!person || person.trackIds.size === 0) return;
    const tr = person.sm.push(sample, this.deps.stableMsFor?.(person.room));
    if (!tr) return;
    this.emit("activity_changed", person, {
      value: { from: tr.from, to: tr.to },
      latency_ms: this.deps.now() - tr.firstSampleTs,
    });
  }

  /** Closes tracks no longer seen via MQTT or WebSocket (e.g. `end` lost). */
  sweepStale(): void {
    const limit = this.deps.now() - this.p.trackStaleMs;
    for (const t of [...this.tracks.values()]) if (t.lastSeen < limit) this.endTrack(t.id);
  }

  private bind(t: Track, frameTimeMs: number): void {
    const name = t.name!;
    let person = this.persons.get(name);
    if (person?.leftTimer) {
      clearTimeout(person.leftTimer);
      person.leftTimer = undefined;
    }
    const arriving = !person;
    const info: PersonInfo = { name, confidence: t.score, source: t.inherited ? "inherited" : "face" };
    if (!person) {
      person = { name, room: t.camera, person: info, lastTrackId: t.id, trackIds: new Set(), sm: new ActivityStateMachine(this.p) };
      this.persons.set(name, person);
    }
    person.trackIds.add(t.id);
    person.room = t.camera;
    person.lastTrackId = t.id;
    if (!t.inherited) person.person = info;
    if (arriving) {
      this.emit("arrived", person, { latency_ms: Math.round(this.deps.now() - frameTimeMs) });
      this.deps.onArrived?.(name);
    }
  }

  private unbind(t: Track): void {
    const person = t.name ? this.persons.get(t.name) : undefined;
    if (!person) return;
    person.trackIds.delete(t.id);
    if (person.trackIds.size === 0) this.scheduleLeft(person);
  }

  private endTrack(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    this.tracks.delete(id);
    if (t.name) this.ended.push({ name: t.name, camera: t.camera, box: t.box, endedAt: this.deps.now() });
    this.unbind(t);
    // the new track may have started before the old one ended
    for (const other of this.tracks.values()) if (!other.name) this.tryInherit(other);
  }

  private scheduleLeft(person: Person): void {
    person.leftTimer = setTimeout(() => {
      this.persons.delete(person.name);
      this.emit("left", person, { activity: person.sm.current });
    }, this.p.absenceMs);
  }

  private emit(type: Observation["type"], person: Person, extra: Partial<Observation>): void {
    this.deps.emit({
      event_id: randomUUID(),
      ts: new Date(this.deps.now()).toISOString(),
      type,
      camera: person.room,
      person: person.person,
      media: { frigate_ids: [person.lastTrackId] },
      ...extra,
    });
  }
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r: Box) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter || 1);
}
