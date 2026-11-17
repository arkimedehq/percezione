/**
 * Posture benchmark on the guided session's test set (npm run capture -- living_room 60 5 postura):
 * every frame with its box goes to the camera's analyzer, with the rest zones of data/config.json,
 * and is compared with the step's label. Only frames within the intervals of data/ground-truth.jsonl are used.
 *
 *   npm run bench:posture -- [box_age_max_s]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Analyzers } from "../src/analyzers.ts";
import { config } from "../src/config.ts";
import { resolvePosture } from "../src/posture.ts";
import { ConfigStore } from "../src/settings.ts";

interface Frame {
  label: string;
  camera: string;
  ts: string;
  box: [number, number, number, number] | null;
  box_age_ms: number | null;
  jpg: string;
}

const maxAgeS = Number(process.argv[2] ?? 120);
const store = new ConfigStore(config.configPath);
const analyzers = new Analyzers(store, config.ollamaUrl);

const truth = readFileSync(resolve(config.dataDir, "ground-truth.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { label: string; start: string; end: string; program?: string })
  .filter((t) => t.program === "postura");
const root = resolve(config.dataDir, "testset-postura");
const frames: Frame[] = readdirSync(root).flatMap((label) =>
  readdirSync(resolve(root, label))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ ...JSON.parse(readFileSync(resolve(root, label, f), "utf8")), jpg: resolve(root, label, f.replace(/\.json$/, ".jpg")) }) as Frame)
    .filter((f) => truth.some((t) => t.label === f.label && t.start <= f.ts && f.ts <= t.end)),
);

const confusion: Record<string, Record<string, number>> = {};
const rows: unknown[] = [];
let ok = 0;
let used = 0;
for (const f of frames) {
  const cam = store.current.cameras[f.camera];
  const obs = cam?.observe.posture;
  if (!cam || !obs) throw new Error(`camera ${f.camera} has no posture observation in data/config.json`);
  // without a box (or with a box too old: the person has moved) top-down makes no sense
  if (!f.box || (f.box_age_ms ?? Infinity) > maxAgeS * 1000) continue;
  used++;
  const r = await analyzers.infer(obs.analyzer, obs.model, readFileSync(f.jpg), { box: f.box });
  const raw = String(r.result?.label ?? "uncertain");
  const d = cam.detect!;
  const center: [number, number] = [(f.box[0] + f.box[2]) / 2 / d.width, (f.box[1] + f.box[3]) / 2 / d.height];
  const got = resolvePosture(raw, center, obs.rest_zones.flatMap((z) => (cam.zones[z] ? [cam.zones[z]!.points] : [])));
  (confusion[f.label] ??= {})[got] = (confusion[f.label]![got] ?? 0) + 1;
  if (got === f.label) ok++;
  rows.push({ ts: f.ts, label: f.label, got, raw, features: r.result?.features, ms: r.inference_ms });
}

console.log(`${used} frames with a box out of ${frames.length}; accuracy ${(ok / (used || 1)).toFixed(3)}`);
for (const [label, got] of Object.entries(confusion)) console.log(`  ${label.padEnd(10)} → ${JSON.stringify(got)}`);
const out = resolve(config.dataDir, `bench-posture-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ used, total: frames.length, accuracy: ok / (used || 1), confusion, rows }, null, 2));
console.log(`Details in ${out}`);
