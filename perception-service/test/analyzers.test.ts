import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Analyzers } from "../src/analyzers.ts";
import { ConfigStore } from "../src/settings.ts";

test("a model missing from Ollama is downloaded by itself, with the progress in the status / un modello che manca in Ollama si scarica da solo, con l'avanzamento nello stato", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "analyzers-"));
  const store = new ConfigStore(join(dir, "config.json"), () => ({ version: 1, analyzers: { vlm: { model: "vision:4b", vocabulary: { other: "…" }, attributes: {} } }, cameras: {} }));
  let have = false;
  let pulls = 0;
  let finish = () => {};
  const ollama = createServer((req, res) => {
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: have ? [{ name: "vision:4b" }] : [] }));
    if (req.url === "/api/pull") {
      pulls++;
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      res.write(JSON.stringify({ status: "pulling", digest: "sha256:a", total: 1000, completed: 250 }) + "\n");
      finish = () => {
        res.write(JSON.stringify({ status: "pulling", digest: "sha256:a", total: 1000, completed: 1000 }) + "\n");
        have = true;
        res.end(JSON.stringify({ status: "success" }) + "\n");
      };
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => ollama.listen(0, "127.0.0.1", ok));
  t.after(() => {
    ollama.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const analyzers = new Analyzers(store, `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`);
  const vlm = () => analyzers.list().find((a) => a.name === "vlm")!;

  await analyzers.refresh();
  assert.deepEqual([vlm().ok, vlm().download?.model], [false, "vision:4b"]);
  await new Promise((ok) => setTimeout(ok, 50));
  await analyzers.refresh();
  assert.equal(vlm().download?.percent, 25);
  assert.equal(pulls, 1, "one download at a time");
  finish();
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual([vlm().ok, vlm().download], [true, undefined]);
});
