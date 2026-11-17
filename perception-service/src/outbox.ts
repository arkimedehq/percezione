import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A durable queue for one destination (docs/outputs.md): written to disk first, then sent in order.
 * - A failed send is retried after 5 s, then 10, 20… up to 5 minutes; nothing is skipped, and other destinations
 *   are not blocked (one outbox each).
 * - A `PermanentError` (e.g. the receiver answered 400) drops that item and moves on: retrying would block forever.
 * - Items older than `maxAgeMs` (default 7 days) are dropped, like the replay window of /events.
 * - `<name>.jsonl` holds the items, `<name>.pos` the sequence number of the last one handed over: a restart resumes
 *   after it. Delivery is at least once (a crash between send and save resends one item): receivers dedup by id.
 */
export class PermanentError extends Error {}

export interface OutboxStatus {
  name: string;
  pending: number;
  delivered: number;
  dropped: number;
  last_ok: string | null;
  last_error: string | null;
  last_error_at: string | null;
  retry_at: string | null;
}

interface Entry<T> {
  seq: number;
  at: string;
  item: T;
}

export interface OutboxOptions {
  maxAgeMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  now?: () => Date;
}

const DAY_MS = 86_400_000;
// rewrite the file once this many delivered items sit at its head
const COMPACT_AFTER = 500;

export class Outbox<T> {
  private queue: Entry<T>[] = [];
  private seq = 0;
  private sinceCompact = 0;
  private running = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private delay: number;
  private readonly file: string;
  private readonly posFile: string;
  private readonly o: Required<OutboxOptions>;
  private s: Omit<OutboxStatus, "name" | "pending">;

  constructor(
    dir: string,
    readonly name: string,
    private readonly send: (item: T) => Promise<void>,
    opts: OutboxOptions = {},
  ) {
    this.o = { maxAgeMs: 7 * DAY_MS, minDelayMs: 5_000, maxDelayMs: 300_000, now: () => new Date(), ...opts };
    this.delay = this.o.minDelayMs;
    this.s = { delivered: 0, dropped: 0, last_ok: null, last_error: null, last_error_at: null, retry_at: null };
    mkdirSync(dir, { recursive: true });
    this.file = resolve(dir, `${name}.jsonl`);
    this.posFile = resolve(dir, `${name}.pos`);
    this.load();
    this.pump();
  }

  push(item: T): void {
    const e: Entry<T> = { seq: ++this.seq, at: this.o.now().toISOString(), item };
    appendFileSync(this.file, JSON.stringify(e) + "\n");
    this.queue.push(e);
    this.pump();
  }

  /** Try now instead of waiting for the backoff (e.g. the broker is back). */
  retryNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.s.retry_at = null;
    }
    this.pump();
  }

  status(): OutboxStatus {
    return { name: this.name, pending: this.queue.length, ...this.s };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Stops and deletes the queue (the destination was removed). */
  destroy(): void {
    this.stop();
    rmSync(this.file, { force: true });
    rmSync(this.posFile, { force: true });
  }

  /** Resolves when nothing is pending or a retry is scheduled (for tests). */
  async idle(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 5));
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped || this.timer) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const e = this.queue[0]!;
        if (this.o.now().getTime() - Date.parse(e.at) > this.o.maxAgeMs) {
          this.fail(`expired after ${Math.round(this.o.maxAgeMs / DAY_MS)} days without delivery`);
          this.done(e, false);
          continue;
        }
        try {
          await this.send(e.item);
          this.s.last_ok = this.o.now().toISOString();
          this.delay = this.o.minDelayMs;
          this.done(e, true);
        } catch (err) {
          this.fail((err as Error).message);
          if (err instanceof PermanentError) {
            this.done(e, false);
            continue;
          }
          const at = new Date(this.o.now().getTime() + this.delay);
          this.s.retry_at = at.toISOString();
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.s.retry_at = null;
            void this.pump();
          }, this.delay);
          this.timer.unref?.();
          this.delay = Math.min(this.delay * 2, this.o.maxDelayMs);
          return;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private fail(message: string): void {
    this.s.last_error = message;
    this.s.last_error_at = this.o.now().toISOString();
  }

  private done(e: Entry<T>, delivered: boolean): void {
    this.queue.shift();
    if (delivered) this.s.delivered++;
    else this.s.dropped++;
    writeFileSync(this.posFile, String(e.seq));
    if (++this.sinceCompact >= COMPACT_AFTER || !this.queue.length) this.compact();
  }

  /** The file keeps only what is still pending. */
  private compact(): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, this.queue.map((e) => JSON.stringify(e) + "\n").join(""));
    renameSync(tmp, this.file);
    this.sinceCompact = 0;
  }

  private load(): void {
    const pos = existsSync(this.posFile) ? Number(readFileSync(this.posFile, "utf8")) || 0 : 0;
    this.seq = pos;
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Entry<T>;
        this.seq = Math.max(this.seq, e.seq);
        if (e.seq > pos) this.queue.push(e);
      } catch {
        // a line cut by a crash while appending: the item was never acknowledged to anyone
      }
    }
  }
}
