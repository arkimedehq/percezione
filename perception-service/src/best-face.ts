import type { Attempt } from "./people.ts";

/**
 * The best face of each person around a request (docs/external-events.md). Frigate tries every face it
 * finds and saves each attempt (clips/faces/train); the name of a track is its vote. Here, per track on the cameras of
 * a group (in their zones), the attempt where the face is biggest and surest: its instant gives the frame to show.
 */
export interface Shot {
  /** Frigate's track: one person */
  track: string;
  camera: string;
  /** the track's name (Frigate's vote); null: not recognized */
  name: string | null;
  confidence: number | null;
  attempt: Attempt;
  /** face size, px² */
  area: number;
}

export interface ShotDeps {
  /** Frigate's recent recognition attempts */
  attempts(): Promise<Attempt[]>;
  /** a track as last seen (src/sightings.ts) */
  track(id: string): { camera: string; zones: string[]; name: string | null; confidence: number } | undefined;
  /** the size of an attempt's picture */
  size(file: string): Promise<{ width: number; height: number } | null>;
}

/** Frigate weighs faces by area; the score lowers blurred ones, without dropping a face it could not name. */
export const quality = (s: Pick<Shot, "area" | "attempt">) => s.area * (0.25 + s.attempt.score);

/** One shot per track with attempts in [from, to] (ms), best first. `cameras`: camera → zones (none: anywhere). */
export async function bestFaces(cameras: Record<string, string[]>, from: number, to: number, d: ShotDeps): Promise<Shot[]> {
  const byTrack = new Map<string, Attempt[]>();
  for (const a of await d.attempts().catch(() => [])) {
    const t = d.track(a.event);
    const zones = t && cameras[t.camera];
    if (!zones || a.ts * 1000 < from || a.ts * 1000 > to) continue;
    if (zones.length && !zones.some((z) => t.zones.includes(z))) continue;
    byTrack.set(a.event, [...(byTrack.get(a.event) ?? []), a]);
  }
  const shots: Shot[] = [];
  for (const [track, attempts] of byTrack) {
    const t = d.track(track)!;
    let best: Shot | null = null;
    for (const attempt of attempts) {
      const size = await d.size(attempt.file).catch(() => null);
      if (!size) continue;
      const shot: Shot = { track, camera: t.camera, name: t.name, confidence: t.name ? t.confidence : null, attempt, area: size.width * size.height };
      if (!best || quality(shot) > quality(best)) best = shot;
    }
    if (best) shots.push(best);
  }
  return shots.sort((a, b) => quality(b) - quality(a));
}
