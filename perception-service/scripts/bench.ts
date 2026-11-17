/**
 * Offline benchmark on the guided session's test set (scripts/capture.ts): same frames,
 * same yes/no questions and rules as the service (data/config.json), for each model both the crop around the box and the whole frame.
 * Only frames falling within the intervals of data/ground-truth.jsonl are used.
 *
 *   npm run bench -- qwen3-vl:2b-instruct qwen3-vl:4b-instruct
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyRules, cameraAttributes, config } from "../src/config.ts";
import { cropAroundBox } from "../src/frigate.ts";
import { ConfigStore, tuningOf } from "../src/settings.ts";
import { VlmClient } from "../src/vlm.ts";

interface Frame {
  label: string;
  camera: string;
  ts: string;
  box: [number, number, number, number] | null;
  jpg: string;
}

const models = process.argv.slice(2);
const settings = new ConfigStore(config.configPath).current;
if (models.length === 0) models.push(settings.analyzers.vlm.model);
const variants = ["crop", "full"] as const;

// labels of the first session, later merged into al_pc (the screen is not visible from the camera)
const MERGED: Record<string, string> = { lavora_al_pc: "al_pc", gioca_al_pc: "al_pc" };

const truth = readFileSync(resolve(config.dataDir, "ground-truth.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { label: string; start: string; end: string });
const inTruth = (f: Frame) => truth.some((t) => t.label === f.label && t.start <= f.ts && f.ts <= t.end);

const root = resolve(config.dataDir, "testset");
const frames: Frame[] = readdirSync(root).flatMap((label) =>
  readdirSync(resolve(root, label))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const meta = JSON.parse(readFileSync(resolve(root, label, f), "utf8"));
      return { ...meta, jpg: resolve(root, label, f.replace(/\.json$/, ".jpg")) } as Frame;
    })
    .filter(inTruth)
    .map((f) => ({ ...f, label: MERGED[f.label] ?? f.label })),
);

const { attributes } = settings.analyzers.vlm;
const activityOf = (camera: string) => {
  const a = settings.cameras[camera]?.observe.activity;
  if (!a) throw new Error(`Camera ${camera} has no activity observation in data/config.json`);
  return a;
};
const summary: Record<string, unknown>[] = [];
console.log(`${frames.length} frames: ${[...new Set(frames.map((f) => f.label))].join(", ")}`);

for (const model of models) {
  const vlm = new VlmClient(config.ollamaUrl);
  for (const variant of variants) {
    const confusion: Record<string, Record<string, number>> = {};
    const ms: number[] = [];
    let ok = 0;
    let valid = 0;
    for (const [i, f] of frames.entries()) {
      const img = await cropAroundBox(readFileSync(f.jpg), variant === "crop" ? f.box : null, tuningOf(settings).crop_margin, tuningOf(settings).crop_max_side);
      const r = await vlm.classify(model, img, cameraAttributes(attributes, activityOf(f.camera)));
      const got = r ? applyRules(r.attributes, activityOf(f.camera)) : "(invalid)";
      (confusion[f.label] ??= {})[got] = (confusion[f.label]![got] ?? 0) + 1;
      if (r) valid++;
      if (got === f.label) ok++;
      // the first call includes loading the model
      if (r && i > 0) ms.push(r.ms);
    }
    ms.sort((a, b) => a - b);
    const row = {
      model,
      variant,
      n: frames.length,
      accuracy: +(ok / frames.length).toFixed(3),
      valid: +(valid / frames.length).toFixed(3),
      ms_mean: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
      ms_p95: ms[Math.floor(ms.length * 0.95)],
      confusion,
    };
    summary.push(row);
    console.log(`\n${model} [${variant}] accuracy ${row.accuracy}, valid JSON ${row.valid}, ${row.ms_mean} ms mean (p95 ${row.ms_p95})`);
    for (const [label, got] of Object.entries(confusion)) console.log(`  ${label.padEnd(14)} → ${JSON.stringify(got)}`);
  }
}

const out = resolve(config.dataDir, `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\nResults in ${out}`);
