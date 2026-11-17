import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import sharp from "sharp";
import { activeObjects, fetchLatestFrame } from "../src/frigate.ts";

test("a preview frame of a stalled camera is not live / la miniatura di una camera ferma non è un fotogramma vivo", async (t) => {
  let size = { width: 640, height: 360 };
  const server = createServer(async (_req, res) => {
    const jpeg = await sharp({ create: { ...size, channels: 3, background: "#777" } }).jpeg().toBuffer();
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(jpeg);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const expect = { width: 640, height: 360 };
  assert.ok((await fetchLatestFrame(url, "front_left", expect)).length > 0);
  size = { width: 320, height: 180 }; // Frigate's preview frame
  await assert.rejects(fetchLatestFrame(url, "front_left", expect), /not live/);
  // without an expected size anything goes
  assert.ok((await fetchLatestFrame(url, "front_left")).length > 0);
});

test("camera_activity: a person whose face Frigate named is still a person / camera_activity: una persona a cui Frigate ha dato un nome resta una persona", () => {
  // as Frigate 0.18 sends it
  const payload = JSON.stringify({
    attic: { objects: [{ id: "1794466817.616779-o8t0h4", label: "person-verified", stationary: true, sub_label: "Alice" }] },
    living_room: { objects: [] },
  });
  assert.deepEqual(
    activeObjects(payload).map((o) => [o.camera, o.label, o.sub_label]),
    [["attic", "person", "Alice"]],
  );
});
