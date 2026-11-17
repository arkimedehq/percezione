import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FaceModels, modelsReadyAt } from "../src/face-models.ts";

function models(dir: string, files: string[], at: number) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f), "x");
    utimesSync(join(dir, f), at / 1000, at / 1000);
  }
}

test("the face models are ready when all there and no longer being written / i modelli dei volti sono pronti quando ci sono tutti e non si stanno più scrivendo", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facedet-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = 1_000_000_000_000;
  assert.equal(modelsReadyAt(join(dir, "none"), true, now), null);
  models(dir, ["facedet.onnx", "landmarkdet.yaml"], now - 600_000);
  assert.equal(modelsReadyAt(dir, false, now), now - 600_000, "small size: no ArcFace needed");
  assert.equal(modelsReadyAt(dir, true, now), null, "large size: ArcFace still missing");
  models(dir, ["arcface.onnx"], now - 10_000);
  assert.equal(modelsReadyAt(dir, true, now), null, "written 10 s ago: maybe still downloading");
  assert.equal(modelsReadyAt(dir, true, now + 60_000), now - 10_000);
});

test("Frigate started before the face models is restarted once, not after / Frigate partito prima dei modelli dei volti si riavvia una volta, poi non più", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frigate-config-"));
  const facedet = join(dir, "model_cache", "facedet");
  let uptime = 0;
  let enabled = true;
  let restarts = 0;
  const frigate = createServer((req, res) => {
    if (req.url === "/api/config") return res.end(JSON.stringify({ face_recognition: { enabled, model_size: "large" } }));
    if (req.url === "/api/stats") return res.end(JSON.stringify({ service: { uptime } }));
    if (req.url === "/api/restart" && req.method === "POST") {
      restarts++;
      uptime = 0;
      return res.end(JSON.stringify({ success: true }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => frigate.listen(0, "127.0.0.1", ok));
  t.after(() => {
    frigate.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let now = 1_000_000_000_000;
  const logs: string[] = [];
  const fm = new FaceModels({ configDir: dir, frigateUrl: `http://127.0.0.1:${(frigate.address() as AddressInfo).port}`, log: (m) => logs.push(m), now: () => now });

  assert.equal(await fm.check(), "waiting", "models still downloading");
  // Frigate started 10 minutes ago, the models arrived 2 minutes ago
  models(facedet, ["facedet.onnx", "landmarkdet.yaml", "arcface.onnx"], now - 120_000);
  uptime = 600;
  assert.equal(await fm.check(), "restarted");
  assert.equal(restarts, 1);
  assert.equal(logs.length, 1);
  now += 30_000;
  uptime = 25;
  assert.equal(await fm.check(), "ok", "Frigate now started after the models");
  assert.equal(restarts, 1);

  enabled = false;
  assert.equal(await fm.check(), "off");
});
