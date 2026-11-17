import type { FrigateEvent } from "./frigate.ts";

/** A name recognized on a camera: where, in which zones, how sure, when last seen. */
export interface Sighting {
  name: string;
  confidence: number;
  camera: string;
  /** ms */
  at: number;
}

interface Track {
  camera: string;
  name: string | null;
  confidence: number;
  zones: Set<string>;
  at: number;
}

/**
 * Recent people tracks with their name and the zones they entered, from frigate/events: the other cameras of a group
 * (src/who.ts) say who they saw on the way to the main camera, also after the track ended. Kept a few minutes.
 */
export class Sightings {
  private tracks = new Map<string, Track>();

  constructor(private readonly keepMs = 600_000) {}

  handleEvent(ev: FrigateEvent, now = Date.now()): void {
    const o = ev.after;
    if (o.label !== "person" || o.false_positive) return;
    const t = this.tracks.get(o.id) ?? { camera: o.camera, name: null, confidence: 0, zones: new Set<string>(), at: now };
    if (o.sub_label) [t.name, t.confidence] = o.sub_label;
    for (const z of [...(o.current_zones ?? []), ...(o.entered_zones ?? [])]) t.zones.add(z);
    t.at = now;
    this.tracks.set(o.id, t);
    for (const [id, x] of this.tracks) if (now - x.at > this.keepMs) this.tracks.delete(id);
  }

  /** A track as last seen: its camera, the zones it entered, its name (null: none yet). */
  track(id: string): { camera: string; zones: string[]; name: string | null; confidence: number } | undefined {
    const t = this.tracks.get(id);
    return t && { camera: t.camera, zones: [...t.zones], name: t.name, confidence: t.confidence };
  }

  /** Names seen on the camera since `since` (ms), in one of the zones (none: anywhere); the best score each. */
  recent(camera: string, zones: string[], since: number): Sighting[] {
    const best = new Map<string, Sighting>();
    for (const t of this.tracks.values()) {
      if (t.camera !== camera || !t.name || t.at < since) continue;
      if (zones.length && !zones.some((z) => t.zones.has(z))) continue;
      const prev = best.get(t.name);
      if (!prev || t.confidence > prev.confidence) best.set(t.name, { name: t.name, confidence: t.confidence, camera, at: Math.max(t.at, prev?.at ?? 0) });
      else prev.at = Math.max(prev.at, t.at);
    }
    return [...best.values()];
  }
}
