import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Short memory of a camera (docs/external-events.md): ffmpeg copies its main stream into pieces of ~2 s in a
 * RAM folder (tmpfs), without re-encoding, and only the last `keepS` seconds are kept, so the space is known: bitrate ×
 * (keepS + one piece). A request holds a time range: its pieces stay until it is done, and a frame of any instant in
 * it can be taken. A piece starts at a key frame, so with long key frame intervals the pieces are longer.
 */

/** A closed piece of video and the time it covers (ms). */
export interface Piece {
  file: string;
  start: number;
  end: number;
}

/** Runs ffmpeg; tests replace it. */
export type Spawn = (args: string[]) => ChildProcess;
const ffmpeg: Spawn = (args) => spawnProcess("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

export const PIECE_S = 2;
const DECODER_NOISE = /^\[(h264|hevc) @|Last message repeated|decode_slice_header|no frame!|non-existing PPS/;
const RESTART_MS = 5_000;

export class CameraBuffer {
  private proc: ChildProcess | null = null;
  private stopped = false;
  /** when each piece was first seen: the start of the very first one */
  private seen = new Map<string, number>();
  private holds = new Set<{ from: number; to: number }>();

  constructor(
    readonly camera: string,
    readonly url: string,
    readonly dir: string,
    public keepS: number,
    private readonly opts: { spawn?: Spawn; log?: (msg: string) => void; secret?: string } = {},
  ) {}

  start(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.stopped = false;
    this.run();
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill("SIGTERM");
    this.proc = null;
    rmSync(this.dir, { recursive: true, force: true });
  }

  private run(): void {
    if (this.stopped) return;
    const log = this.opts.log ?? console.error;
    // file names are the wall clock second the piece opened: unique also across restarts
    const args = ["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", this.url, "-map", "0:v:0", "-c", "copy",
      "-f", "segment", "-segment_time", String(PIECE_S), "-segment_format", "mpegts", "-reset_timestamps", "1", "-strftime", "1",
      resolve(this.dir, "%s.ts")];
    const p = (this.opts.spawn ?? ffmpeg)(args);
    this.proc = p;
    p.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        // joining a stream between key frames the decoder complains until the next one: harmless
        if (!line.trim() || DECODER_NOISE.test(line)) continue;
        // ffmpeg names the address in its errors: never the password in the logs
        const text = this.opts.secret ? line.replaceAll(this.opts.secret, "***") : line;
        log(`buffer ${this.camera}: ${text.trim().replaceAll(this.url, this.camera)}`);
      }
    });
    p.on("error", (err) => log(`buffer ${this.camera}: ${err.message}`));
    p.on("exit", () => {
      if (this.proc !== p || this.stopped) return;
      this.proc = null;
      setTimeout(() => this.run(), RESTART_MS).unref();
    });
  }

  /** Closed pieces, oldest first; the open one (still being written) last, ending now. */
  pieces(now = Date.now()): Piece[] {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".ts")).sort();
    const out: Piece[] = [];
    let prevEnd: number | null = null;
    for (const [i, file] of files.entries()) {
      if (!this.seen.has(file)) this.seen.set(file, now);
      const end = i === files.length - 1 ? now : statSync(resolve(this.dir, file)).mtimeMs;
      // a piece starts when the previous one stopped being written
      out.push({ file, start: prevEnd ?? this.seen.get(file)!, end });
      prevEnd = end;
    }
    for (const f of this.seen.keys()) if (!files.includes(f)) this.seen.delete(f);
    return out;
  }

  /** Drops the pieces older than keepS that no request holds. */
  prune(now = Date.now()): void {
    const pieces = this.pieces(now);
    for (const p of pieces.slice(0, -1)) {
      if (p.end >= now - this.keepS * 1000) continue;
      if ([...this.holds].some((h) => p.end >= h.from && p.start <= h.to)) continue;
      unlinkSync(resolve(this.dir, p.file));
      this.seen.delete(p.file);
    }
  }

  /** Keeps the pieces of [from, to] (ms) until the returned function is called. */
  hold(from: number, to: number): () => void {
    const h = { from, to };
    this.holds.add(h);
    return () => void this.holds.delete(h);
  }

  /** The piece that has the instant ts (ms) and where it is in it (s); the nearest when none does. */
  locate(ts: number, now = Date.now()): { file: string; offset: number } | null {
    const pieces = this.pieces(now);
    if (!pieces.length) return null;
    const near = (p: Piece) => (ts < p.start ? p.start - ts : ts > p.end ? ts - p.end : 0);
    const p = pieces.reduce((a, b) => (near(b) < near(a) ? b : a));
    const offset = Math.max(0, Math.min(ts, p.end - 100) - p.start) / 1000;
    return { file: resolve(this.dir, p.file), offset };
  }
}

/** One JPEG of a piece at offset (s), full size. */
export async function extractFrame(file: string, offset: number, spawn: Spawn = (args) => spawnProcess("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] })): Promise<Buffer | null> {
  // seeking after -i decodes from the piece's start (a few seconds at most): seeking on the input finds no frame in
  // these pieces, whose timestamps do not start at 0
  const p = spawn(["-hide_banner", "-loglevel", "error", "-i", file, "-ss", offset.toFixed(2), "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]);
  const chunks: Buffer[] = [];
  p.stdout?.on("data", (d: Buffer) => chunks.push(d));
  return new Promise((ok) => {
    p.on("error", () => ok(null));
    p.on("exit", (code) => ok(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
  });
}

/** The buffers of the cameras: one per camera. `url` gives its go2rtc address (null: no go2rtc stream, no buffer). */
export class Buffers {
  private cams = new Map<string, CameraBuffer>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly url: (camera: string) => string | null,
    private readonly opts: { spawn?: Spawn; log?: (msg: string) => void; secret?: string } = {},
  ) {}

  /** Starts and stops buffers to match: camera → seconds to keep. */
  sync(want: Record<string, number>): void {
    for (const [camera, b] of this.cams) {
      // a camera with another stream starts again
      if (camera in want && this.url(camera) === b.url) continue;
      b.stop();
      this.cams.delete(camera);
    }
    for (const [camera, keepS] of Object.entries(want)) {
      const have = this.cams.get(camera);
      if (have) {
        have.keepS = keepS;
        continue;
      }
      const url = this.url(camera);
      if (!url) continue;
      const b = new CameraBuffer(camera, url, resolve(this.root, camera), keepS, this.opts);
      b.start();
      this.cams.set(camera, b);
    }
    if (this.cams.size && !this.timer) this.timer = setInterval(() => this.prune(), 1_000);
    if (!this.cams.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private prune(): void {
    for (const b of this.cams.values()) {
      try {
        b.prune();
      } catch {
        // the folder is being recreated: next second
      }
    }
  }

  /** Holds [from, to] (ms) on the cameras that have a buffer. */
  hold(cameras: string[], from: number, to: number): () => void {
    const done = cameras.flatMap((c) => this.cams.get(c)?.hold(from, to) ?? []);
    return () => done.forEach((f) => f());
  }

  /** A full-size frame of the camera at ts (ms); null without a buffer or a piece. */
  async frame(camera: string, ts: number): Promise<Buffer | null> {
    const at = this.cams.get(camera)?.locate(ts);
    return at ? extractFrame(at.file, at.offset) : null;
  }

  stop(): void {
    for (const b of this.cams.values()) b.stop();
    this.cams.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
