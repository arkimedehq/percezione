import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { startFrigateProxy } from "../src/frigate-proxy.ts";

test("Frigate behind the Percezione login, WebSocket included / Frigate dietro il login di Percezione, anche il WebSocket", async (t) => {
  const frigate = createServer((req, res) => res.end(`frigate ${req.url}`));
  const wss = new WebSocketServer({ server: frigate });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo ${m}`)));
  await new Promise<void>((done) => frigate.listen(0, "127.0.0.1", done));
  const proxy = await startFrigateProxy(
    { frigateUrl: `http://127.0.0.1:${(frigate.address() as AddressInfo).port}`, authed: (req) => (req.headers.cookie ?? "").includes("percezione=ok"), uiPort: 8090 },
    0,
    "127.0.0.1",
  );
  t.after(() => {
    proxy.close();
    wss.close();
    frigate.close();
  });
  const base = `127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  const anon = await fetch(`http://${base}/api/config`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "http://127.0.0.1:8090/");

  const ok = await fetch(`http://${base}/api/config`, { headers: { Cookie: "percezione=ok" } });
  assert.equal(await ok.text(), "frigate /api/config");

  const ws = new WebSocket(`ws://${base}/ws`, { headers: { Cookie: "percezione=ok" } });
  await new Promise((done) => ws.on("open", done));
  ws.send("hello");
  assert.equal(String(await new Promise((done) => ws.on("message", done))), "echo hello");
  ws.close();
});
