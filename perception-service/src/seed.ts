import { loadActivitiesSeed, WALKING } from "./config.ts";

/** The part of Frigate's `GET /api/config` used for the first `data/config.json`. */
export interface FrigateCameraConfig {
  detect: { width: number; height: number };
  zones?: Record<string, { coordinates: string | string[] | number[] }>;
  motion?: { mask?: Record<string, { coordinates: string | string[] | number[] }> | string | string[] | null };
}

/**
 * The first configuration, from what Frigate already has: its cameras and zones, the activity rules of
 * `config/activities.json`. Used once; everything changes later from the UI.
 */
export function seedConfig(frigate: Record<string, FrigateCameraConfig>) {
  const activities = loadActivitiesSeed();
  // every camera starts indoor: outdoor ones, their passages and their rules are set from the UI
  const cameras = Object.fromEntries(
    Object.entries(frigate).map(([name, f]) => [
      name,
      {
        place: name,
        kind: "indoor",
        zones: Object.fromEntries(Object.entries(f.zones ?? {}).map(([z, v]) => [z, polygon(v.coordinates, f.detect)])),
        masks: masks(f),
        observe: {
          presence: {},
          activity: { analyzer: "vlm", ...activities.rules.indoor, interval_s: 20, stable_s: 120 },
        },
      },
    ]),
  );
  return {
    version: 1,
    cameras,
    analyzers: {
      vlm: {
        model: "qwen3-vl:4b-instruct",
        // `walking` does not come from the VLM but from the box moving (src/index.ts)
        vocabulary: { ...activities.vocabulary, [WALKING]: "moving across the frame (from the motion, without the VLM)" },
        attributes: activities.attributes,
      },
    },
    rules: [],
    outputs: { webhooks: {} },
  };
}

/** Frigate coordinates ("x1,y1,x2,y2,…", relative or in pixels) → a polygon in relative coordinates. */
export function polygon(c: string | string[] | number[], size: { width: number; height: number }): [number, number][] {
  const nums = (Array.isArray(c) ? c.join(",") : c).split(",").map(Number);
  const relative = nums.every((n) => n <= 1);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const [x, y] = [nums[i]!, nums[i + 1]!];
    out.push(relative ? [x, y] : [round(x / size.width), round(y / size.height)]);
  }
  return out;
}

function masks(f: FrigateCameraConfig): Record<string, [number, number][]> {
  const m = f.motion?.mask;
  if (!m) return {};
  if (typeof m === "string" || Array.isArray(m)) return Object.fromEntries([m].flat().map((c, i) => [`mask_${i + 1}`, polygon(c, f.detect)]));
  return Object.fromEntries(Object.entries(m).map(([name, v]) => [name, polygon(v.coordinates, f.detect)]));
}

const round = (n: number) => Math.round(n * 1000) / 1000;
