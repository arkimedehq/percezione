import sharp from "sharp";
import WebSocket from "ws";
import type { ActiveObject } from "./perception.ts";
import { baseName } from "./people.ts";

/** Subset of `after` in frigate/events, as Frigate 0.18 sends it. */
export interface FrigateObject {
  id: string;
  camera: string;
  label: string;
  sub_label: [string, number] | null;
  frame_time: number;
  start_time: number;
  end_time: number | null;
  stationary: boolean;
  false_positive: boolean;
  box: [number, number, number, number]; // x1, y1, x2, y2 in detect stream pixels
  current_zones?: string[];
  entered_zones?: string[];
}

export interface FrigateEvent {
  type: "new" | "update" | "end";
  after: FrigateObject;
}

export function parseEvent(payload: Buffer): FrigateEvent | null {
  try {
    const e = JSON.parse(payload.toString()) as FrigateEvent;
    if (!e?.after?.id) return null;
    // a night face's folder is "<name>~ir": the person is <name> (src/people.ts)
    if (e.after.sub_label) e.after.sub_label = [baseName(e.after.sub_label[0]), e.after.sub_label[1]];
    return e;
  } catch {
    return null;
  }
}

/** Names in Frigate's Face Library (the folder "train" holds recognition attempts, not a person). */
export async function fetchFaceNames(frigateUrl: string): Promise<string[]> {
  const res = await fetch(`${frigateUrl}/api/faces`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Frigate faces ${res.status}`);
  return [...new Set(Object.keys((await res.json()) as Record<string, unknown>).filter((n) => n !== "train").map(baseName))];
}

/**
 * Current frame of a camera. With `expect` (the detect size) a frame of another size is rejected: when the camera
 * has had no new frame for `ffmpeg.retry_interval`, Frigate answers with its latest small preview frame or an
 * error image instead (frigate/api/media.py, latest_frame). After a Frigate restart such a preview
 * could become a "left object" whose photo was the timestamp overlay.
 */
export async function fetchLatestFrame(frigateUrl: string, camera: string, expect?: { width: number; height: number }): Promise<Buffer> {
  const res = await fetch(`${frigateUrl}/api/${encodeURIComponent(camera)}/latest.jpg`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Frigate latest.jpg ${res.status}`);
  const jpeg = Buffer.from(await res.arrayBuffer());
  if (expect) {
    const { width, height } = await sharp(jpeg).metadata();
    if (width !== expect.width || height !== expect.height) {
      throw new Error(`frame not live (${width}×${height} instead of ${expect.width}×${expect.height}): camera stalled`);
    }
  }
  return jpeg;
}

/**
 * Wide crop around the person: the context (monitor, desk, phone) is the main clue to the
 * activity, so the box is widened by `margin` per side and scaled down to `maxSide`.
 */
export async function cropAroundBox(
  jpeg: Buffer,
  box: [number, number, number, number] | null,
  margin: number,
  maxSide: number,
): Promise<Buffer> {
  const img = sharp(jpeg);
  // without a box (track rebuilt from the WebSocket) the whole frame is used
  if (!box) return img.resize({ width: maxSide, height: maxSide, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  const { width = 0, height = 0 } = await img.metadata();
  const [x1, y1, x2, y2] = box;
  const mx = (x2 - x1) * margin;
  const my = (y2 - y1) * margin;
  const left = Math.max(0, Math.floor(x1 - mx));
  const top = Math.max(0, Math.floor(y1 - my));
  const right = Math.min(width, Math.ceil(x2 + mx));
  const bottom = Math.min(height, Math.ceil(y2 + my));
  return img
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

export function boxCenter(box: [number, number, number, number]): [number, number] {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

/**
 * Frigate's WebSocket: the `onConnect` message makes it republish `camera_activity` with the objects
 * currently tracked per camera. It is requested periodically to know who is still there.
 */
/**
 * The objects of a `camera_activity` payload. Frigate writes "person-verified" for a person whose face it named
 * (frigate/camera/state.py): here it is a person again, as in its MQTT events.
 */
export function activeObjects(payload: string): ActiveObject[] {
  const cams = JSON.parse(payload) as Record<string, { objects?: Omit<ActiveObject, "camera">[] }>;
  return Object.entries(cams).flatMap(([camera, c]) => (c.objects ?? []).map((o) => ({ ...o, label: o.label.replace(/-verified$/, ""), sub_label: night(o.sub_label), camera })));
}

/** "Alice~ir" (a night face) is Alice. */
function night(sub: ActiveObject["sub_label"]): ActiveObject["sub_label"] {
  if (!sub) return sub;
  return Array.isArray(sub) ? [baseName(sub[0]), sub[1]] : baseName(sub);
}

export function watchCameraActivity(
  frigateUrl: string,
  /** read before every wait: a change applies from the next poll */
  pollMs: () => number,
  onObjects: (objects: ActiveObject[]) => void,
): void {
  const url = frigateUrl.replace(/^http/, "ws") + "/ws";
  let timer: ReturnType<typeof setTimeout> | undefined;
  // with Frigate down a reconnect fails every 5 s: the same error is written once
  let lastError = "";
  const connect = () => {
    const ws = new WebSocket(url);
    const poll = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ topic: "onConnect", payload: "" }));
      timer = setTimeout(poll, pollMs());
    };
    ws.on("open", () => {
      if (lastError) console.log("Frigate WebSocket connected again");
      lastError = "";
      poll();
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { topic?: string; payload?: string };
        if (msg.topic !== "camera_activity" || !msg.payload) return;
        onObjects(activeObjects(msg.payload));
      } catch {
        // non-JSON messages or other topics: ignored
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      setTimeout(connect, 5_000);
    });
    ws.on("error", (err) => {
      if (err.message !== lastError) console.warn(`Frigate WebSocket: ${err.message}`);
      lastError = err.message;
    });
  };
  connect();
}
