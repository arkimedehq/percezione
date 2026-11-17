import { randomUUID } from "node:crypto";
import { ActivityStateMachine, type ActivityParams } from "./activity.ts";
import type { Observation, Person } from "./events.ts";

type Point = [number, number];

/** The VLM question about lying down (config/activities.json) that a measured posture answers better. */
export const LYING_ATTRIBUTE = "lying_down";

/**
 * The VLM's yes/no answers, with "lying down" taken from the measured posture when there is one: the pose model
 * sees the body's angles, the VLM sometimes says "lying" of someone sitting back on the sofa. Only a certain posture
 * counts (not "uncertain" or none), and only when the camera asks that question.
 */
export function withPosture(attrs: Record<string, boolean>, posture: string | null): Record<string, boolean> {
  if (!(LYING_ATTRIBUTE in attrs) || !posture || !["standing", "sitting", "lying", "on_floor"].includes(posture)) return attrs;
  return { ...attrs, [LYING_ATTRIBUTE]: posture === "lying" || posture === "on_floor" };
}

export interface PostureDeps {
  now(): number;
  emit(o: Observation): void;
}

/**
 * Posture of the people present, from the samples of the pose_estimation analyzer (`posture` observation).
 * Same debounce as activities: a change is emitted only once the new posture is stable.
 * "lying" outside the camera's rest zones (sofa, bed) becomes "on_floor"; with no rest zones configured it stays
 * "lying" (the sofa may not be drawn yet), unless the room is marked as having no sofa or bed (`noRestPlace`):
 * there lying is always "on_floor".
 */
export class PostureTracker {
  private persons = new Map<string, { sm: ActivityStateMachine; camera: string; trackId: string; lastSeen: number }>();

  /**
   * `graceMs`: how long a posture survives an absence. Frigate often splits one stay into several tracks, or the
   * person drops out of `present()` for a moment; restarting from scratch re-announced "→ sitting" six times in
   * 15 minutes without anyone standing up.
   */
  constructor(
    private readonly p: ActivityParams,
    private readonly deps: PostureDeps,
    private readonly graceMs = 5 * 60_000,
  ) {}

  push(who: { name: string; camera: string; person: Person; trackId: string }, label: string, stableMs: number): void {
    let st = this.persons.get(who.name);
    if (!st) {
      st = { sm: new ActivityStateMachine(this.p), camera: who.camera, trackId: who.trackId, lastSeen: 0 };
      this.persons.set(who.name, st);
    }
    // a new room starts the posture from scratch
    if (st.camera !== who.camera) {
      st.sm.reset();
      st.camera = who.camera;
    }
    st.trackId = who.trackId;
    st.lastSeen = this.deps.now();
    const tr = st.sm.push({ label, conf: 1, ts: this.deps.now() }, stableMs);
    if (!tr) return;
    this.deps.emit({
      event_id: randomUUID(),
      ts: new Date(this.deps.now()).toISOString(),
      type: "posture_changed",
      camera: who.camera,
      person: who.person,
      value: { from: tr.from, to: tr.to },
      latency_ms: this.deps.now() - tr.firstSampleTs,
      media: { frigate_ids: [who.trackId] },
    });
  }

  /** Forgets whoever has been away for longer than `graceMs`: on return the posture starts from scratch. */
  prune(present: Set<string>): void {
    const now = this.deps.now();
    for (const [name, st] of this.persons) {
      if (present.has(name)) st.lastSeen = now;
      else if (now - st.lastSeen > this.graceMs) this.persons.delete(name);
    }
  }

  current(name: string): string | null {
    return this.persons.get(name)?.sm.current ?? null;
  }
}

/** The final label: "lying" outside every rest zone is "on_floor". `center` is the box's center, 0–1. */
export function resolvePosture(label: string, center: Point, restZones: Point[][], noRestPlace = false): string {
  if (label !== "lying") return label;
  if (restZones.length === 0) return noRestPlace ? "on_floor" : label;
  return restZones.some((z) => inside(center, z)) ? "lying" : "on_floor";
}

/** Point in polygon (ray casting). */
export function inside([x, y]: Point, poly: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
