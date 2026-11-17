import assert from "node:assert/strict";
import { test } from "node:test";
import { availableFromVmStat, frigateUsage, parsePs } from "../src/usage.ts";

test("processes grouped by role from ps / processi raggruppati per ruolo da ps", () => {
  const out = [
    "  PID    RSS  %CPU COMMAND",
    "  101  51200   1.5 node /x/node_modules/.bin/tsx src/index.ts",
    "  102 102400   2.0 /usr/bin/node --import tsx src/index.ts",
    "  201  20480   0.1 /x/.venv/bin/python /x/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8100",
    "  301 1048576 150.0 /Applications/Docker.app/Contents/MacOS/com.apple.Virtualization.VirtualMachine",
    "  401   4096   0.0 /bin/zsh",
  ].join("\n");
  const p = parsePs(out);
  assert.deepEqual(p.map((x) => [x.name, x.count]), [["Percezione (service)", 2], ["ONNX analyzers", 1], ["Docker (Frigate)", 1]]);
  assert.equal(p[0]!.rss, 150 * 1024 * 1024);
  assert.equal(p[0]!.cpu, 3.5);
});

test("available memory on macOS counts cache pages too / la memoria disponibile su macOS conta anche la cache", () => {
  const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  100.\nPages active: 5000.\nPages inactive: 200.\nPages speculative: 50.\nPages purgeable: 10.\n";
  assert.equal(availableFromVmStat(vm), 360 * 16384);
  assert.equal(availableFromVmStat("nonsense"), null);
});

test("Frigate stats reduced to what the page shows / statistiche di Frigate ridotte a quello che mostra la pagina", () => {
  const f = frigateUsage({
    cpu_usages: { "frigate.full_system": { cpu: "16.3", mem: "76.2" } },
    detectors: { cpu1: { inference_speed: 14.1, cpu: "97.1" } },
    embeddings: { face_recognition_speed: 410.3 },
    service: { storage: { "/dev/shm": { total: 512, used: 256 } } },
    cameras: { attic: { camera_fps: 5, detection_fps: 8.4, stalls_last_hour: 118, reconnects_last_hour: 0, connection_quality: "fair" } },
  });
  assert.equal(f.cpu, 16.3);
  assert.deepEqual(f.detector, { name: "cpu1", inferenceMs: 14.1, cpu: 97.1 });
  assert.equal(f.shm!.used, 256 * 1024 * 1024);
  assert.equal(f.cameras[0]!.stallsLastHour, 118);
});
