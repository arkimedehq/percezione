import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Outbox, PermanentError } from "../src/outbox.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timeout");
    await wait(5);
  }
};

function dir(t: { after(fn: () => void): void }) {
  const d = mkdtempSync(join(tmpdir(), "outbox-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test("delivers in order, retries a destination that is down, loses nothing / consegna in ordine, ritenta una destinazione giù, non perde nulla", async (t) => {
  const got: number[] = [];
  let up = false;
  const box = new Outbox<number>(dir(t), "x", async (n) => {
    if (!up) throw new Error("down");
    got.push(n);
  }, { minDelayMs: 10, maxDelayMs: 40 });
  t.after(() => box.stop());
  for (let i = 1; i <= 5; i++) box.push(i);
  await wait(60);
  assert.deepEqual(got, []);
  assert.equal(box.status().pending, 5);
  assert.equal(box.status().last_error, "down");
  assert.ok(box.status().retry_at);
  up = true;
  await until(() => got.length === 5);
  assert.deepEqual(got, [1, 2, 3, 4, 5]);
  assert.equal(box.status().pending, 0);
  assert.equal(box.status().delivered, 5);
  assert.ok(box.status().last_ok);
});

test("a restart resumes after the last delivered item / un riavvio riprende dopo l'ultimo consegnato", async (t) => {
  const d = dir(t);
  const first: number[] = [];
  const a = new Outbox<number>(d, "x", async (n) => {
    if (n > 2) throw new Error("down");
    first.push(n);
  }, { minDelayMs: 1000 });
  for (let i = 1; i <= 4; i++) a.push(i);
  await until(() => first.length === 2 && a.status().retry_at !== null);
  a.stop();
  const second: number[] = [];
  const b = new Outbox<number>(d, "x", async (n) => void second.push(n));
  t.after(() => b.stop());
  await until(() => second.length === 2);
  assert.deepEqual(second, [3, 4]);
  b.push(5);
  await until(() => second.length === 3);
  assert.deepEqual(second, [3, 4, 5]);
  // the file keeps only what is pending
  assert.equal(readFileSync(join(d, "x.jsonl"), "utf8"), "");
});

test("a permanent refusal drops that item only; old items expire / un rifiuto definitivo scarta solo quell'elemento; i vecchi scadono", async (t) => {
  const got: number[] = [];
  let now = new Date("2026-11-11T10:00:00Z");
  const box = new Outbox<number>(dir(t), "x", async (n) => {
    if (n === 2) throw new PermanentError("HTTP 400: rejected");
    got.push(n);
  }, { now: () => now, maxAgeMs: 60_000 });
  t.after(() => box.stop());
  box.push(1);
  box.push(2);
  box.push(3);
  await until(() => got.length === 2);
  assert.deepEqual(got, [1, 3]);
  assert.equal(box.status().dropped, 1);
  assert.equal(box.status().last_error, "HTTP 400: rejected");
});

test("items older than the limit are dropped, not sent / gli elementi oltre il limite si scartano, non si inviano", async (t) => {
  const d = dir(t);
  let now = new Date("2026-11-11T10:00:00Z");
  const a = new Outbox<number>(d, "x", async () => {
    throw new Error("down");
  }, { now: () => now, minDelayMs: 10_000 });
  a.push(1);
  await until(() => a.status().retry_at !== null);
  a.stop();
  now = new Date("2026-11-19T10:00:00Z");
  const got: number[] = [];
  const b = new Outbox<number>(d, "x", async (n) => void got.push(n), { now: () => now });
  t.after(() => b.stop());
  b.push(2);
  await until(() => got.length === 1);
  assert.deepEqual(got, [2]);
  assert.equal(b.status().dropped, 1);
});
